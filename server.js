// InclusiveCity backend
// Написан на чистом Node.js (без внешних npm-зависимостей) — это делает деплой
// проще и надёжнее: не нужен даже "npm install", сервер запускается сразу
// командой `node server.js` на любом хостинге с Node 18+.
//
// Отдаёт фронтенд (public/) и API для отчётов о барьерах.
// Хранилище — JSON-файл (data/reports.json) и папка uploads/ для фото.
// Этого достаточно для MVP с небольшим потоком отчётов; для продакшена с
// большой нагрузкой стоит перейти на настоящую БД — см. README.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-please';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');

const ALLOWED_TYPES = [
  'Высокий бордюр',
  'Сломанный или крутой пандус',
  'Неработающий лифт / подъёмник',
  'Узкая дверь или высокий порог',
  'Ремонт / временное перекрытие',
  'Лестница без пандуса',
  'Снег или наледь',
  'Машина на тротуаре/съезде',
];

// Характер барьера. Временные (ремонт) автоматически исчезают через 30 дней,
// зимние — после окончания зимнего сезона: барьер «снег на пандусе» не должен
// висеть на карте круглый год, иначе данные перестают отражать реальность.
const ALLOWED_SEASONS = ['permanent', 'winter', 'temporary'];
const TEMPORARY_TTL_DAYS = 30;

function expiryFor(season, fromDate) {
  const now = fromDate ? new Date(fromDate) : new Date();
  if (season === 'temporary') {
    return new Date(now.getTime() + TEMPORARY_TTL_DAYS * 864e5).toISOString();
  }
  if (season === 'winter') {
    // действует до 1 апреля ближайшего года
    const year = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
    return new Date(Date.UTC(year, 3, 1)).toISOString();
  }
  return null;
}

function isExpired(r) {
  return !!(r.expiresAt && new Date(r.expiresAt).getTime() < Date.now());
}

// --- гарантируем, что папки/файлы существуют ---
for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(REPORTS_FILE)) {
  fs.writeFileSync(REPORTS_FILE, '[]', 'utf8');
}

// --- простое файловое хранилище отчётов ---
function readReports() {
  try {
    return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeReports(list) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function publicShape(r) {
  return {
    id: r.id,
    lat: r.lat,
    lng: r.lng,
    type: r.type,
    comment: r.comment,
    photo: r.photo || null,
    season: r.season || 'permanent',
    verifications: (r.verifiedBy || []).length,
    expiresAt: r.expiresAt || null,
    createdAt: r.createdAt,
  };
}

// Подтверждения жителей. Храним хэш IP, а не сам адрес: этого достаточно,
// чтобы один человек не накрутил счётчик, и при этом мы не собираем
// персональные данные.
function visitorHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(ip + '|inclusivecity').digest('hex').slice(0, 16);
}

// --- вспомогательные функции HTTP ---
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (limitBytes && size > limitBytes) {
        reject(Object.assign(new Error('Файл слишком большой'), { code: 'LIMIT' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- минимальный парсер multipart/form-data (без внешних зависимостей) ---
// Достаточен для нашего контролируемого случая: несколько текстовых полей + один файл.
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Некорректный multipart запрос');
  const boundary = '--' + (m[1] || m[2]).trim();
  const boundaryBuf = Buffer.from(boundary);
  const fields = {};
  let file = null;

  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const nextStart = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (nextStart === -1) break;
    // содержимое части между текущим и следующим boundary
    let part = buffer.slice(start + boundaryBuf.length, nextStart);
    // убираем ведущие \r\n и завершающие \r\n перед следующим boundary
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const rawHeaders = part.slice(0, headerEnd).toString('utf8');
      const content = part.slice(headerEnd + 4);
      const dispositionMatch = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
      if (dispositionMatch) {
        const name = dispositionMatch[1];
        const filename = dispositionMatch[2];
        if (filename !== undefined) {
          if (filename) {
            const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
            file = {
              fieldName: name,
              filename,
              mimetype: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
              data: content,
            };
          }
        } else {
          fields[name] = content.toString('utf8');
        }
      }
    }
    start = nextStart;
  }
  return { fields, file };
}

function requireAdmin(req) {
  const url = new URL(req.url, 'http://localhost');
  const token = req.headers['x-admin-token'] || url.searchParams.get('token');
  return token && token === ADMIN_TOKEN;
}

const EXT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = EXT_TYPES[ext] || 'application/octet-stream';
    // текст сжимаем: страница и маршруты автобусов становятся в 4–6 раз легче
    const ae = (res.req && res.req.headers['accept-encoding']) || '';
    if (data.length > 1024 && /text|json|javascript|svg/.test(type) && /\bgzip\b/.test(ae)) {
      const gz = zlib.gzipSync(data);
      res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': gz.length });
      res.end(gz);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(data);
  });
}

// защита от выхода за пределы разрешённой директории через ".."
function safeJoin(baseDir, requestedPath) {
  const target = path.normalize(path.join(baseDir, requestedPath));
  if (!target.startsWith(path.normalize(baseDir))) return null;
  return target;
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/transit' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const from = parseLatLon(q.get('from')), to = parseLatLon(q.get('to'));
    if (!from || !to) return sendJson(res, 400, { error: 'from/to must be "lat,lon"' });
    try {
      const r = await dgisTransit(from, to);
      return sendJson(res, r.status, r.body);
    } catch (e) {
      return sendJson(res, 502, { error: '2gis unavailable' });
    }
  }

  if (pathname === '/api/taxi-tariffs' && req.method === 'GET') {
    return sendJson(res, 200, readTariffs());
  }

  if (pathname === '/api/taxi-price' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const from = parseLatLon(q.get('from')), to = parseLatLon(q.get('to'));
    if (!from || !to) return sendJson(res, 400, { error: 'from/to must be "lat,lon"' });
    try {
      const r = await taxiLivePrice(from, to);
      return sendJson(res, r.status, r.body);
    } catch (e) {
      return sendJson(res, 502, { error: 'yandex unavailable' });
    }
  }

  if (pathname === '/api/reports' && req.method === 'GET') {
    const list = readReports().filter((r) => r.status === 'approved' && !isExpired(r));
    return sendJson(res, 200, list.map(publicShape));
  }

  // Подтверждение отчёта другим жителем — повышает доверие к данным
  let vm = pathname.match(/^\/api\/reports\/([^/]+)\/verify$/);
  if (vm && req.method === 'POST') {
    const list = readReports();
    const r = list.find((x) => x.id === vm[1] && x.status === 'approved');
    if (!r) return sendJson(res, 404, { error: 'not found' });
    const who = visitorHash(req);
    r.verifiedBy = r.verifiedBy || [];
    if (!r.verifiedBy.includes(who)) {
      r.verifiedBy.push(who);
      writeReports(list);
    }
    return sendJson(res, 200, { ok: true, verifications: r.verifiedBy.length });
  }

  // Сводка для дашборда города
  if (pathname === '/api/stats' && req.method === 'GET') {
    const all = readReports();
    const active = all.filter((r) => r.status === 'approved' && !isExpired(r));
    const count = (key) => active.reduce((acc, r) => {
      const k = r[key] || 'permanent';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return sendJson(res, 200, {
      total: active.length,
      pending: all.filter((r) => r.status === 'pending').length,
      confirmed: active.filter((r) => (r.verifiedBy || []).length >= 3).length,
      withPhoto: active.filter((r) => r.photo).length,
      last30days: active.filter((r) => Date.now() - new Date(r.createdAt).getTime() < 30 * 864e5).length,
      byType: count('type'),
      bySeason: count('season'),
    });
  }

  if (pathname === '/api/reports' && req.method === 'POST') {
    let buf;
    try {
      buf = await readBody(req, MAX_UPLOAD_BYTES);
    } catch (e) {
      return sendJson(res, 400, { error: e.code === 'LIMIT' ? 'Файл слишком большой (максимум 8MB)' : 'Ошибка чтения запроса' });
    }
    const contentType = req.headers['content-type'] || '';
    let fields = {};
    let file = null;
    try {
      if (contentType.startsWith('multipart/form-data')) {
        ({ fields, file } = parseMultipart(buf, contentType));
      } else {
        fields = JSON.parse(buf.toString('utf8') || '{}');
      }
    } catch (e) {
      return sendJson(res, 400, { error: 'Некорректный формат запроса' });
    }

    const latNum = Number(fields.lat);
    const lngNum = Number(fields.lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return sendJson(res, 400, { error: 'Некорректные координаты' });
    }
    if (!ALLOWED_TYPES.includes(fields.type)) {
      return sendJson(res, 400, { error: 'Некорректный тип барьера' });
    }
    if (!fields.comment || !String(fields.comment).trim()) {
      return sendJson(res, 400, { error: 'Комментарий обязателен' });
    }
    if (file && !/^image\//.test(file.mimetype)) {
      return sendJson(res, 400, { error: 'Файл должен быть изображением' });
    }

    let photoPath = null;
    if (file) {
      const ext = (path.extname(file.filename || '').slice(0, 8) || guessExt(file.mimetype)).replace(/[^a-zA-Z0-9.]/g, '');
      const savedName = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, savedName), file.data);
      photoPath = `/uploads/${savedName}`;
    }

    const season = ALLOWED_SEASONS.includes(fields.season) ? fields.season : 'permanent';
    const createdAt = new Date().toISOString();
    const report = {
      id: crypto.randomUUID(),
      lat: latNum,
      lng: lngNum,
      type: fields.type,
      comment: String(fields.comment).trim().slice(0, 500),
      photo: photoPath,
      season,
      expiresAt: expiryFor(season, createdAt),
      verifiedBy: [],
      status: 'pending',
      createdAt,
    };
    const list = readReports();
    list.unshift(report);
    writeReports(list);
    return sendJson(res, 201, { ok: true, id: report.id });
  }

  // --- админ ---
  if (pathname === '/api/admin/reports' && req.method === 'GET') {
    if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, readReports());
  }

  let m = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/(approve|reject)$/);
  if (m && req.method === 'POST') {
    if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const [, id, action] = m;
    const list = readReports();
    const r = list.find((x) => x.id === id);
    if (!r) return sendJson(res, 404, { error: 'not found' });
    r.status = action === 'approve' ? 'approved' : 'rejected';
    writeReports(list);
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const [, id] = m;
    const list = readReports();
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) return sendJson(res, 404, { error: 'not found' });
    const [removed] = list.splice(idx, 1);
    writeReports(list);
    if (removed.photo) {
      fs.unlink(path.join(UPLOADS_DIR, path.basename(removed.photo)), () => {});
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// --- Автобусные маршруты городов (из OpenStreetMap) ---
// Маршруты собирает tools/busbuild.js: раз в неделю его запускает GitHub Actions
// (.github/workflows/bus-data.yml) и сохраняет bus-data/<город>.json в репозиторий.
// Сервер берёт свежую версию прямо из GitHub (без передеплоя, жалобы не теряются),
// держит её в data/bus/ и раздаёт как /bus-<город>.json. Если GitHub недоступен —
// отдаёт копию из самого репозитория, а если нет и её — собирает город из Overpass.
const busbuild = require('./tools/busbuild');
const BUS_CITIES = busbuild.BUS_CITIES;
const BUS_DIR = path.join(DATA_DIR, 'bus');
const BUS_REPO_DIR = path.join(ROOT, 'bus-data');
const BUS_RAW_URL = 'https://raw.githubusercontent.com/aiguzhin/inclusivecity-app/main/bus-data/';
const BUS_TTL_MS = 864e5;   // свежую версию из GitHub проверяем раз в сутки
if (!fs.existsSync(BUS_DIR)) fs.mkdirSync(BUS_DIR, { recursive: true });

function busFile(city) { return path.join(BUS_DIR, `${city}.json`); }
function busRepoFile(city) { return path.join(BUS_REPO_DIR, `${city}.json`); }
function busIsFresh(city) {
  try { return Date.now() - fs.statSync(busFile(city)).mtimeMs < BUS_TTL_MS; } catch (e) { return false; }
}
function saveBus(city, data) {
  const tmp = busFile(city) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, busFile(city));
}
const busInflight = new Map();   // один запрос на город, сколько бы ни пришло пользователей
const busBuilding = new Map();   // медленная сборка из Overpass — отдельно, чтобы не держать быстрый путь
// Быстрый путь (секунды): свежий файл из GitHub, иначе копия из репозитория.
// Если нет ни того, ни другого — запускаем сборку из Overpass в фоне и сразу отвечаем «ещё нет».
function refreshBus(city) {
  if (busInflight.has(city)) return busInflight.get(city);
  const p = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(BUS_RAW_URL + city + '.json', { headers: { 'User-Agent': 'ICity/1.0' }, signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data && data.v === 2 && Array.isArray(data.routes)) { saveBus(city, data); return data; }
      }
    } catch (e) { /* GitHub недоступен — дальше */ }
    if (fs.existsSync(busRepoFile(city))) {   // копия из репозитория
      fs.copyFileSync(busRepoFile(city), busFile(city));
      return JSON.parse(fs.readFileSync(busFile(city), 'utf8'));
    }
    buildBusLive(city);
    throw new Error('not ready yet');
  })().finally(() => busInflight.delete(city));
  busInflight.set(city, p);
  return p;
}
let busQueue = Promise.resolve();   // сборки из Overpass — по одной, чтобы не перегружать его
function buildBusLive(city) {
  if (busBuilding.has(city) || fs.existsSync(busFile(city))) return;
  const p = busQueue.then(() => fs.existsSync(busFile(city)) ? null   // GitHub мог успеть раньше
    : busbuild.fetchCity(city, (s) => console.warn('bus', s)).then((data) => {
        if (!fs.existsSync(busFile(city))) saveBus(city, data);
        console.log(`bus ${city}: ${data.routes.length} routes (built from Overpass)`);
      }))
    .catch((e) => console.warn(`bus ${city} build failed:`, e.message))
    .finally(() => busBuilding.delete(city));
  busQueue = p;
  busBuilding.set(city, p);
}
async function serveBus(res, city) {
  if (!BUS_CITIES[city]) return sendJson(res, 404, { error: 'unknown city' });
  const ready = () => fs.existsSync(busFile(city)) ? busFile(city) : fs.existsSync(busRepoFile(city)) ? busRepoFile(city) : null;
  if (ready()) {
    if (!busIsFresh(city)) refreshBus(city).catch(() => {});
    return serveFile(res, ready());   // устаревшие данные лучше, чем никаких
  }
  // данных нет — пробуем быстрый путь прямо сейчас (GitHub отвечает за секунду)
  try { await refreshBus(city); } catch (e) { /* ещё собирается */ }
  if (ready()) return serveFile(res, ready());
  return sendJson(res, 503, { error: 'bus data is loading, try again later' });
}
// После запуска и затем раз в сутки подтягиваем свежие версии всех городов
async function warmBusData() {
  for (const city of Object.keys(BUS_CITIES)) {
    if (busIsFresh(city)) continue;
    try { await refreshBus(city); } catch (e) { /* соберётся в фоне */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- Такси: официальные тарифы и цена в реальном времени ---
// Тарифы «Эконом» Яндекс Go публикуются на taxi.yandex.kz отдельно для каждого
// города. Сервер раз в неделю перечитывает эти страницы, так что оценка цены
// в приложении всегда по действующему тарифу. Ключи города в адресах Яндекса
// местами отличаются от наших.
const YANDEX_SLUGS = {
  almaty: 'almaty', astana: 'astana', shymkent: 'chimkent', karaganda: 'karaganda', aktobe: 'aktobe',
  taraz: 'taraz', pavlodar: 'pavlodar', oskemen: 'ust_kamenogorsk', semey: 'semey', atyrau: 'atyrau',
  kostanay: 'kostanai', kyzylorda: 'kyzylorda', oral: 'uralsk', petropavl: 'petropavlovsk', aktau: 'aktau',
  temirtau: 'temirtau', turkistan: 'turkestan', kokshetau: 'kokshetau', taldykorgan: 'taldykorgan',
  ekibastuz: 'ekibastuz', zhezkazgan: 'zhezkazgan',
};
const TARIFF_FILE = path.join(DATA_DIR, 'taxi-tariffs.json');
const TARIFF_TTL_MS = 7 * 864e5;

// Разбор страницы тарифа: «Минимальная стоимость (включено 3 мин и 1 км) — 400 ₸ …
// Далее по городу — не более 58 ₸/км, не более 27 ₸/мин»
function parseYandexTariff(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const i = text.indexOf('Минимальная стоимость (включено');
  if (i < 0) return null;
  const t = text.slice(i, i + 700);
  const int = (re) => { const m = t.match(re); return m ? parseInt(m[1].replace(/\s/g, ''), 10) : null; };
  const incl = t.match(/включено ([\d,]+) мин и ([\d,]+) км/);
  const tariff = {
    base: int(/км\) — ([\d ]+?) ₸/),
    inclMin: incl ? parseFloat(incl[1].replace(',', '.')) : 3,
    inclKm: incl ? parseFloat(incl[2].replace(',', '.')) : 1,
    km: int(/не более ([\d ]+?) ₸\/км/),
    min: int(/₸\/км , не более ([\d ]+?) ₸\/мин/),
  };
  return tariff.base && tariff.km && tariff.min ? tariff : null;
}
function readTariffs() {
  try { return JSON.parse(fs.readFileSync(TARIFF_FILE, 'utf8')); } catch (e) { return {}; }
}
async function refreshTariffs() {
  const all = readTariffs();
  for (const [city, slug] of Object.entries(YANDEX_SLUGS)) {
    if (all[city] && Date.now() - new Date(all[city].checked).getTime() < TARIFF_TTL_MS) continue;
    try {
      const res = await fetch(`https://taxi.yandex.kz/ru_kz/${slug}/tariff/econom/`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (ICity tariff check)' } });
      const tariff = res.ok ? parseYandexTariff(await res.text()) : null;
      if (tariff) all[city] = { ...tariff, checked: new Date().toISOString() };
      else console.warn(`tariff ${city}: not parsed (HTTP ${res.status})`);
    } catch (e) {
      console.warn(`tariff ${city} failed:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  fs.writeFileSync(TARIFF_FILE, JSON.stringify(all));
}

// Цена прямо сейчас — через Trip information API Яндекс Go (taxi-routeinfo).
// Для него нужны ключи партнёрской программы Яндекс Go: YANDEX_TAXI_CLID и
// YANDEX_TAXI_APIKEY в переменных окружения. Без них отвечаем 501, и приложение
// показывает оценку по тарифу.
async function taxiLivePrice(from, to) {
  const clid = process.env.YANDEX_TAXI_CLID, apikey = process.env.YANDEX_TAXI_APIKEY;
  if (!clid || !apikey) return { status: 501, body: { error: 'live prices are not configured' } };
  const rll = `${from[1]},${from[0]}~${to[1]},${to[0]}`;
  const url = `https://taxi-routeinfo.taxi.yandex.net/taxi_info?clid=${encodeURIComponent(clid)}`
    + `&apikey=${encodeURIComponent(apikey)}&rll=${rll}&class=econom&lang=ru`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { status: 502, body: { error: `yandex ${res.status}` } };
  const d = await res.json();
  const opt = (d.options || [])[0];
  if (!opt) return { status: 502, body: { error: 'no options' } };
  return { status: 200, body: {
    price: opt.price, minPrice: opt.min_price, currency: d.currency,
    waitSec: opt.waiting_time, tripSec: d.time, distanceM: d.distance,
  } };
}
function parseLatLon(s) {
  const m = String(s || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const ll = [parseFloat(m[1]), parseFloat(m[2])];
  return Math.abs(ll[0]) <= 90 && Math.abs(ll[1]) <= 180 ? ll : null;
}

// --- Общественный транспорт из 2ГИС ---
// В 2ГИС есть все маршруты и расписание, но API платное: ключ кладётся в
// переменную окружения DGIS_API_KEY. Без ключа отвечаем 501, и приложение
// строит поездку по данным OpenStreetMap.
// Ответ 2ГИС переводим в тот же вид, что и варианты из OSM (legs/walk1/walk2/gaps),
// чтобы приложение показывало их одинаково.
const DGIS_KIND = { trolleybus: 't', shuttle_bus: 'm', tram: 'r', light_rail: 'r', metro: 'M', light_metro: 'M' };
const asList = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []));
function wktLine(s) {
  const m = String(s || '').match(/\(([^()]+)\)/);
  if (!m) return [];
  return m[1].split(',').map((p) => {
    const [lon, lat] = p.trim().split(/\s+/).map(Number);
    return [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
  }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}
function walkMeters(comment) {
  const m = String(comment || '').match(/([\d.,]+)\s*(км|km|м|m)(?![а-яa-z])/i);
  if (!m) return 0;
  const v = parseFloat(m[1].replace(',', '.'));
  return Math.round(/к|k/.test(m[2]) ? v * 1000 : v);
}
function movementPath(mv) {
  const alt = asList(mv.alternatives)[0];
  return alt ? [].concat(...asList(alt.geometry).map((g) => wktLine(g.selection))) : [];
}
function normalizeDgis(variants) {
  return asList(variants).map((v) => {
    const mvs = asList(v.movements);
    const legs = [];
    const walks = [];          // пешие отрезки по порядку: до первой остановки, пересадки, от последней
    let walk = 0;
    mvs.forEach((mv, i) => {
      const wp = mv.waypoint || {};
      if (mv.type === 'passage') {
        walks.push(walk); walk = 0;
        const routes = asList(mv.routes);
        const path = movementPath(mv);
        const next = mvs[i + 1] && mvs[i + 1].waypoint;
        legs.push({
          ref: routes.map((r) => asList(r.names).join('/')).join(', ') || '—',
          kind: DGIS_KIND[(routes[0] || {}).subtype] || '',
          to: '',
          board: { ll: path[0] || null, name: wp.name || '' },
          alight: { ll: path[path.length - 1] || null, name: (next && next.name) || '' },
          path,
          stops: asList((mv.platforms || {}).names).length + 1,
        });
      } else if (wp.subtype !== 'finish') {
        walk += walkMeters(wp.comment);
      }
    });
    walks.push(walk);
    return {
      source: '2gis',
      legs,
      walk1: walks[0] || 0,
      walk2: walks[walks.length - 1] || 0,
      gaps: walks.slice(1, -1),
      total: Math.round((v.total_duration || 0) / 60),
    };
  }).filter((o) => o.legs.length && o.legs.every((l) => l.path.length > 1));
}
async function dgisTransit(from, to) {
  const key = process.env.DGIS_API_KEY;
  if (!key) return { status: 501, body: { error: '2GIS key is not configured' } };
  const res = await fetch(`https://routing.api.2gis.com/public_transport/2.0?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { point: { lat: from[0], lon: from[1] } },
      target: { point: { lat: to[0], lon: to[1] } },
      transport: ['bus', 'trolleybus', 'tram', 'shuttle_bus', 'metro', 'light_metro', 'light_rail'],
      locale: 'ru',
      max_result_count: 6,
    }),
  });
  if (res.status === 204) return { status: 200, body: { options: [] } };
  if (!res.ok) return { status: 502, body: { error: `2gis ${res.status}` } };
  return { status: 200, body: { options: normalizeDgis(await res.json()) } };
}

function guessExt(mimetype) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
  return map[mimetype] || '';
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    if (pathname.startsWith('/uploads/')) {
      const filePath = safeJoin(UPLOADS_DIR, pathname.replace('/uploads/', ''));
      if (!filePath) return sendJson(res, 400, { error: 'bad path' });
      return serveFile(res, filePath);
    }

    if (pathname === '/' ) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (pathname === '/admin' || pathname === '/admin.html') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));

    const bm = pathname.match(/^\/bus-([a-z]+)\.json$/);
    if (bm && req.method === 'GET') return await serveBus(res, bm[1]);

    const staticPath = safeJoin(PUBLIC_DIR, pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      return serveFile(res, staticPath);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`InclusiveCity server running on port ${PORT}`);
  refreshTariffs().catch((e) => console.warn("tariffs:", e.message)).finally(warmBusData);
  setInterval(() => { refreshTariffs().catch(() => {}).finally(warmBusData); }, 864e5);
  if (ADMIN_TOKEN === 'change-me-please') {
    console.warn('ВНИМАНИЕ: используется ADMIN_TOKEN по умолчанию. Задайте свой в переменных окружения!');
  }
});
