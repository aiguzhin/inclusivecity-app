// Фото профиля: POST/DELETE /api/avatar (только владелец — по токену входа Supabase), GET /api/avatar/<id>.jpg.
// Файл — data/avatars/<id>.jpg + копия в Cloudflare KV (avatar:<id>), чтобы фото не пропадало при передеплое.
const fs = require('fs');
const path = require('path');

let H = null, DIR = null;
const MAX = 400 * 1024;

async function whoAmI(req) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  const auth = String(req.headers.authorization || '');
  if (!url || !anon || !/^Bearer [\w.-]{20,}$/.test(auth)) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && /^[0-9a-f-]{36}$/.test(u.id) ? u.id : null;
  } catch (e) { return null; }
}
const isImage = (b) => (b[0] === 0xff && b[1] === 0xd8) || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') || (b[0] === 0x89 && b[1] === 0x50);
const mimeOf = (b) => (b[0] === 0xff ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : 'image/webp');

async function handle(req, res, pathname) {
  const m = pathname.match(/^\/api\/avatar\/([0-9a-f-]{36})\.jpg$/);
  if (m && req.method === 'GET') {
    const f = path.join(DIR, m[1] + '.img');
    let buf = null;
    try { buf = fs.readFileSync(f); } catch (e) {
      try { buf = await H.kvGet('avatar:' + m[1]); if (buf) fs.writeFileSync(f, buf); } catch (e2) {}
    }
    if (!buf || !buf.length) return H.sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': mimeOf(buf), 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return res.end(buf);
  }
  if (pathname === '/api/avatar' && (req.method === 'POST' || req.method === 'DELETE')) {
    const id = await whoAmI(req);
    if (!id) return H.sendJson(res, 401, { error: 'Войдите в аккаунт' });
    const f = path.join(DIR, id + '.img');
    if (req.method === 'DELETE') {
      try { fs.writeFileSync(f, Buffer.alloc(0)); } catch (e) {}
      H.kvPut('avatar:' + id, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
      return H.sendJson(res, 200, { ok: true });
    }
    let buf;
    try { buf = await H.readBody(req, MAX); } catch (e) { return H.sendJson(res, 413, { error: 'Фото слишком большое' }); }
    if (!buf || buf.length < 100 || !isImage(buf)) return H.sendJson(res, 400, { error: 'Нужна картинка JPEG, PNG или WebP' });
    fs.writeFileSync(f, buf);
    H.kvPut('avatar:' + id, buf, mimeOf(buf)).catch((e) => console.warn(e.message));
    return H.sendJson(res, 200, { ok: true, url: `/api/avatar/${id}.jpg?v=${Date.now().toString(36)}` });
  }
  return null;
}

module.exports = {
  init(helpers) { H = helpers; DIR = path.join(H.DATA_DIR, 'avatars'); fs.mkdirSync(DIR, { recursive: true }); },
  handle,
};
