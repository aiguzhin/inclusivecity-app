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
];

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
    createdAt: r.createdAt,
  };
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
    res.writeHead(200, {
      'Content-Type': EXT_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
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

  if (pathname === '/api/reports' && req.method === 'GET') {
    const list = readReports().filter((r) => r.status === 'approved');
    return sendJson(res, 200, list.map(publicShape));
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

    const report = {
      id: crypto.randomUUID(),
      lat: latNum,
      lng: lngNum,
      type: fields.type,
      comment: String(fields.comment).trim().slice(0, 500),
      photo: photoPath,
      status: 'pending',
      createdAt: new Date().toISOString(),
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
  if (ADMIN_TOKEN === 'change-me-please') {
    console.warn('ВНИМАНИЕ: используется ADMIN_TOKEN по умолчанию. Задайте свой в переменных окружения!');
  }
});
