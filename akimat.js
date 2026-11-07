// Кабинет акимата: /akimat
// У каждого города свой ключ доступа (создаёт модератор в /admin). Акимат видит жалобы
// только своего города, ставит «В работе» / «Исправлено» (с фото «после» и комментарием),
// видит сроки и выгружает таблицу. Ключи храним только в виде sha256 — в data/akimat.json
// и копией в Cloudflare KV (`akimat`), чтобы не пропадали при обновлениях.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Рамка города — та же, что во фронтенде и в tools/busbuild.js
const CITY_DLAT = 0.13, CITY_DLON = 0.24;
const CITY_NAMES = {
  almaty: 'Алматы', astana: 'Астана', shymkent: 'Шымкент', karaganda: 'Караганда', aktobe: 'Актобе',
  taraz: 'Тараз', pavlodar: 'Павлодар', oskemen: 'Усть-Каменогорск', semey: 'Семей', atyrau: 'Атырау',
  kostanay: 'Костанай', kyzylorda: 'Кызылорда', oral: 'Уральск', petropavl: 'Петропавловск', aktau: 'Актау',
  temirtau: 'Темиртау', turkistan: 'Туркестан', kokshetau: 'Кокшетау', taldykorgan: 'Талдыкорган',
  ekibastuz: 'Экибастуз', konaev: 'Конаев', zhezkazgan: 'Жезказган',
};

let D = null;          // зависимости из server.js
let FILE = null;
const fails = new Map();

const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
  D.kvPut('akimat', JSON.stringify(list), 'application/json').catch((e) => console.warn('akimat kv:', e.message));
}

function init(deps) {
  D = deps;
  FILE = path.join(deps.DATA_DIR, 'akimat.json');
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, '[]', 'utf8');
    deps.kvGet('akimat').then((buf) => { if (buf) fs.writeFileSync(FILE, buf); }).catch(() => {});
  }
}

function inCity(city, r) {
  const c = D.BUS_CITIES[city];
  return c && Math.abs(r.lat - c[0]) <= CITY_DLAT && Math.abs(r.lng - c[1]) <= CITY_DLON;
}

// Ключ акимата: заголовок X-Akimat-Key. Не больше 10 ошибок за 15 минут с адреса.
function auth(req) {
  const ip = D.clientIp(req), now = Date.now();
  const f = (fails.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  if (f.length >= 10) return null;
  const key = String(req.headers['x-akimat-key'] || '');
  const h = key ? hash(key) : '';
  const acc = h && load().find((a) => a.keyHash.length === h.length && crypto.timingSafeEqual(Buffer.from(a.keyHash), Buffer.from(h)));
  if (!acc) { f.push(now); fails.set(ip, f); return null; }
  return acc;
}

const daysBetween = (a, b) => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 864e5);
function shape(r) {
  return {
    id: r.id, lat: r.lat, lng: r.lng, type: r.type, comment: r.comment, photo: r.photo || null,
    status: r.status, season: r.season || 'permanent', verifications: (r.verifiedBy || []).length,
    createdAt: r.createdAt, updatedAt: r.updatedAt || null, startedAt: r.startedAt || null, fixedAt: r.fixedAt || null,
    fixPhoto: r.fixPhoto || null, note: r.adminNote || '', fixedBy: r.fixedBy || null,
  };
}
function stats(list) {
  const now = new Date().toISOString();
  const open = list.filter((r) => r.status === 'approved' || r.status === 'pending');
  const fixed = list.filter((r) => r.status === 'fixed');
  const fixDays = fixed.filter((r) => r.fixedAt).map((r) => daysBetween(r.createdAt, r.fixedAt)).sort((a, b) => a - b);
  const median = fixDays.length ? fixDays[Math.floor(fixDays.length / 2)] : null;
  const overdue = list.filter((r) => (r.status === 'approved' || r.status === 'in_progress') && daysBetween(r.createdAt, now) > 30).length;
  const handled = list.filter((r) => r.status === 'in_progress' || r.status === 'fixed').length;
  return {
    total: list.length, open: open.length, inProgress: list.filter((r) => r.status === 'in_progress').length,
    fixed: fixed.length, overdue, medianFixDays: median === null ? null : Math.round(median * 10) / 10,
    handledShare: list.length ? Math.round((handled / list.length) * 100) : 0,
    last30: list.filter((r) => daysBetween(r.createdAt, now) <= 30).length,
  };
}
function cityReports(city) {
  return D.readReports().filter((r) => r.status !== 'rejected' && inCity(city, r));
}

// Возвращает true, если запрос обработан
async function handle(req, res, pathname) {
  const send = D.sendJson;

  // --- управление ключами (модератор) ---
  if (pathname === '/api/admin/akimat') {
    if (!D.requireAdmin(req)) return send(res, 401, { error: 'unauthorized' }), true;
    if (req.method === 'GET') {
      const all = D.readReports().filter((r) => r.status !== 'rejected');
      return send(res, 200, {
        cities: Object.entries(CITY_NAMES).map(([id, name]) => ({ id, name, reports: all.filter((r) => inCity(id, r)).length })),
        accounts: load().map((a) => ({ id: a.id, city: a.city, cityName: CITY_NAMES[a.city], org: a.org, createdAt: a.createdAt, lastSeen: a.lastSeen || null })),
      }), true;
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await D.readBody(req, 64 * 1024)).toString('utf8') || '{}'); } catch (e) { return send(res, 400, { error: 'bad json' }), true; }
      if (!CITY_NAMES[body.city]) return send(res, 400, { error: 'Неизвестный город' }), true;
      const key = crypto.randomBytes(18).toString('base64url');
      const acc = { id: crypto.randomUUID(), city: body.city, org: String(body.org || '').trim().slice(0, 160) || `Акимат г. ${CITY_NAMES[body.city]}`,
        keyHash: hash(key), createdAt: new Date().toISOString() };
      const list = load(); list.push(acc); save(list);
      return send(res, 201, { ok: true, key, link: `/akimat#key=${key}`, city: acc.city, org: acc.org }), true;
    }
  }
  let m = pathname.match(/^\/api\/admin\/akimat\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    if (!D.requireAdmin(req)) return send(res, 401, { error: 'unauthorized' }), true;
    const list = load(), i = list.findIndex((a) => a.id === m[1]);
    if (i === -1) return send(res, 404, { error: 'not found' }), true;
    list.splice(i, 1); save(list);
    return send(res, 200, { ok: true }), true;
  }

  if (!pathname.startsWith('/api/akimat/')) return false;
  const acc = auth(req);
  if (!acc) return send(res, 401, { error: 'Ключ не подошёл. Попросите новую ссылку у команды ICity.' }), true;

  // --- данные кабинета ---
  if (pathname === '/api/akimat/me' && req.method === 'GET') {
    const list = cityReports(acc.city);
    const accounts = load(); const me = accounts.find((a) => a.id === acc.id);
    if (me) { me.lastSeen = new Date().toISOString(); save(accounts); }
    return send(res, 200, { city: acc.city, cityName: CITY_NAMES[acc.city], org: acc.org, center: D.BUS_CITIES[acc.city],
      stats: stats(list), reports: list.map(shape) }), true;
  }

  // --- смена статуса: progress | fixed (fixed — можно с фото «после» и комментарием) ---
  m = pathname.match(/^\/api\/akimat\/reports\/([^/]+)\/(progress|fixed)$/);
  if (m && req.method === 'POST') {
    let fields = {}, file = null;
    try {
      const buf = await D.readBody(req, D.MAX_UPLOAD_BYTES);
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) ({ fields, file } = D.parseMultipart(buf, ct));
      else fields = JSON.parse(buf.toString('utf8') || '{}');
    } catch (e) { return send(res, 400, { error: e.code === 'LIMIT' ? 'Фото больше 8 МБ' : 'Некорректный запрос' }), true; }
    if (file && !/^image\//.test(file.mimetype)) return send(res, 400, { error: 'Нужна фотография' }), true;

    const list = D.readReports();
    const r = list.find((x) => x.id === m[1]);
    if (!r || !inCity(acc.city, r) || r.status === 'rejected') return send(res, 404, { error: 'Жалоба не найдена' }), true;
    if (r.status === 'fixed') return send(res, 409, { error: 'Уже отмечено как исправленное' }), true;
    const now = new Date().toISOString();
    if (file) {
      const ext = (path.extname(file.filename || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      const name = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(D.UPLOADS_DIR, name), file.data);
      D.kvPut('photo:' + name, file.data, file.mimetype).catch(() => {});
      r.fixPhoto = `/uploads/${name}`;
    }
    const note = String(fields.note || '').trim().slice(0, 500);
    if (note) r.adminNote = note;
    if (m[2] === 'progress') { r.status = 'in_progress'; r.startedAt = now; }
    else { r.status = 'fixed'; r.fixedAt = now; if (!r.startedAt) r.startedAt = now; }
    r.updatedAt = now;
    r.fixedBy = acc.org;
    r.history = (r.history || []).concat({ at: now, status: r.status, by: acc.org, note: note || undefined });
    D.writeReports(list);
    D.notifyReport(r);
    return send(res, 200, { ok: true, report: shape(r) }), true;
  }

  return send(res, 404, { error: 'not found' }), true;
}

module.exports = { init, handle, CITY_NAMES };
