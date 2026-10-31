// Друзья: добавление по ссылке-приглашению, геопозиция друг друга на карте (только по согласию и на время),
// избранные места и отзывы друзей. Вход — токен Supabase (как у фото профиля).
// Хранилище — data/friends.json + копия в Cloudflare KV. Геопозиция — только в памяти сервера и живёт до срока «делиться до».
//
// GET  /api/friends                     → { me:{id,name,code,sharing}, friends:[{id,name,avatar,profile,loc,places}] }
// GET  /api/friends/invite?code=XXXX    → { id, name, avatar }        (чьё приглашение)
// POST /api/friends/accept {code}       → дружба с владельцем ссылки (ссылку он отправил сам — это его согласие)
// POST /api/friends/remove {id}
// POST /api/friends/code                → новая ссылка (старая перестаёт работать)
// POST /api/friends/me {name,avatar,profile,places}   → что видят друзья
// POST /api/friends/share {until}       → делиться геопозицией до момента (мс) или 0 — перестать
// POST /api/friends/loc {lat,lng,acc}   → текущая точка (только пока включено «делиться»)
// POST /api/friends/reviews {id}        → отзывы друга о доступности
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let H = null, FILE = null, whoAmI = null, reviewsBy = null;
let db = { users: {}, codes: {}, pairs: [] };
const locs = new Map();          // id -> {lat,lng,acc,at}
let saveT = null;

function load() { try { db = Object.assign({ users: {}, codes: {}, pairs: [] }, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {} }
function save() {
  fs.writeFileSync(FILE, JSON.stringify(db));
  clearTimeout(saveT); saveT = setTimeout(() => H.kvPut('friends', fs.readFileSync(FILE), 'application/json').catch((e) => console.warn(e.message)), 1500);
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
function user(id) { return db.users[id] || (db.users[id] = { name: '', avatar: '', profile: '', places: [], share: 0 }); }
function codeOf(id) {
  const u = user(id);
  if (!u.code || db.codes[u.code] !== id) {
    let c; do { c = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8); } while (c.length < 8 || db.codes[c]);
    if (u.code) delete db.codes[u.code];
    u.code = c; db.codes[c] = id; save();
  }
  return u.code;
}
function friendsOf(id) { return db.pairs.filter((p) => p.split('|').includes(id)).map((p) => p.split('|').find((x) => x !== id)); }
function sharing(id) { const u = db.users[id]; return !!u && (u.share === -1 || u.share > Date.now()); }
function pub(id, viewer) {
  const u = db.users[id] || {};
  const l = locs.get(id);
  const loc = sharing(id) && l && Date.now() - l.at < 30 * 60e3 ? { lat: l.lat, lng: l.lng, acc: l.acc, at: l.at } : null;
  return { id, name: u.name || 'Друг', avatar: u.avatar || '', profile: u.profile || '', loc, places: (u.places || []).slice(0, 40) };
}
async function json(req, res) {
  try { const b = await H.readBody(req, 64 * 1024); return JSON.parse(b.toString('utf8') || '{}'); }
  catch (e) { H.sendJson(res, 400, { error: 'bad request' }); return null; }
}

async function handle(req, res, pathname, url) {
  if (!pathname.startsWith('/api/friends')) return null;
  const me = await whoAmI(req);
  if (!me) return H.sendJson(res, 401, { error: 'Войдите в аккаунт' });
  const sub = pathname.slice('/api/friends'.length);

  if (sub === '' && req.method === 'GET') {
    const u = user(me);
    return H.sendJson(res, 200, { me: { id: me, name: u.name, code: codeOf(me), share: u.share || 0 }, friends: friendsOf(me).map((f) => pub(f, me)) });
  }
  if (sub === '/invite' && req.method === 'GET') {
    const id = db.codes[String(url.searchParams.get('code') || '')];
    if (!id) return H.sendJson(res, 404, { error: 'Ссылка устарела или неверная' });
    const u = db.users[id] || {};
    return H.sendJson(res, 200, { id, name: u.name || 'Пользователь ICity', avatar: u.avatar || '', self: id === me, already: db.pairs.includes(pairKey(id, me)) });
  }
  if (req.method !== 'POST') return H.sendJson(res, 405, { error: 'method' });
  const b = await json(req, res); if (!b) return;

  if (sub === '/accept') {
    const id = db.codes[String(b.code || '')];
    if (!id) return H.sendJson(res, 404, { error: 'Ссылка устарела или неверная' });
    if (id === me) return H.sendJson(res, 400, { error: 'Это ваша ссылка' });
    if (friendsOf(me).length >= 200) return H.sendJson(res, 400, { error: 'Слишком много друзей' });
    const k = pairKey(id, me); if (!db.pairs.includes(k)) { db.pairs.push(k); save(); }
    return H.sendJson(res, 200, { ok: true, friend: pub(id, me) });
  }
  if (sub === '/remove') {
    const k = pairKey(String(b.id || ''), me); db.pairs = db.pairs.filter((p) => p !== k); save();
    return H.sendJson(res, 200, { ok: true });
  }
  if (sub === '/code') {
    const u = user(me); if (u.code) delete db.codes[u.code]; u.code = ''; return H.sendJson(res, 200, { code: codeOf(me) });
  }
  if (sub === '/me') {
    const u = user(me);
    if (b.name != null) u.name = clean(b.name, 40);
    if (b.avatar != null) u.avatar = /^\/api\/avatar\/[0-9a-f-]{36}\.jpg(\?v=\w+)?$|^https:\/\/[\w.-]+\.googleusercontent\.com\/[\w\-/=.]+$/.test(String(b.avatar)) ? String(b.avatar) : '';
    if (b.profile != null) u.profile = clean(b.profile, 30);
    if (Array.isArray(b.places)) {
      // друзьям — только избранные места, без дома и работы
      u.places = b.places.filter((p) => p && p.type === 'place' && Number.isFinite(+p.lat) && Number.isFinite(+p.lng)).slice(0, 40)
        .map((p) => ({ name: clean(p.name, 80), lat: +(+p.lat).toFixed(6), lng: +(+p.lng).toFixed(6), note: clean(p.note, 120) }));
    }
    save(); return H.sendJson(res, 200, { ok: true });
  }
  if (sub === '/share') {
    const until = num(b.until); const u = user(me);
    u.share = until === -1 ? -1 : until && until > Date.now() ? Math.min(until, Date.now() + 7 * 864e5) : 0;
    if (!u.share) locs.delete(me);
    save(); return H.sendJson(res, 200, { ok: true, share: u.share });
  }
  if (sub === '/loc') {
    if (!sharing(me)) { locs.delete(me); return H.sendJson(res, 200, { ok: false, share: 0 }); }
    const lat = num(b.lat), lng = num(b.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return H.sendJson(res, 400, { error: 'bad' });
    locs.set(me, { lat: +lat.toFixed(6), lng: +lng.toFixed(6), acc: Math.min(9999, Math.round(num(b.acc) || 0)), at: Date.now() });
    return H.sendJson(res, 200, { ok: true });
  }
  if (sub === '/reviews') {
    const id = String(b.id || '');
    if (!db.pairs.includes(pairKey(id, me))) return H.sendJson(res, 403, { error: 'Не в друзьях' });
    return H.sendJson(res, 200, reviewsBy ? reviewsBy(id) : []);
  }
  return H.sendJson(res, 404, { error: 'not found' });
}

module.exports = {
  async init(helpers) {
    H = helpers; whoAmI = helpers.whoAmI; reviewsBy = helpers.reviewsBy;
    FILE = path.join(H.DATA_DIR, 'friends.json');
    try { const buf = await H.kvGet('friends'); if (buf && buf.length) fs.writeFileSync(FILE, buf); } catch (e) {}
    load();
  },
  handle,
};
