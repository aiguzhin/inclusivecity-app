// Отзывы о доступности мест, просьбы о помощи волонтёрам и статусы жалоб.
// Хранилище — JSON-файлы в data/ с копией в Cloudflare KV (как у жалоб), без внешних зависимостей.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let H = null;              // помощники сервера: readBody, sendJson, parseMultipart, kvPut, kvGet, UPLOADS_DIR, DATA_DIR
const FILES = {};          // name -> путь
const timers = {};
const hits = new Map();    // ограничение частоты по IP

function file(name) { return FILES[name] || (FILES[name] = path.join(H.DATA_DIR, name + '.json')); }
function read(name) { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return []; } }
function write(name, list) {
  fs.writeFileSync(file(name), JSON.stringify(list), 'utf8');
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => H.kvPut(name, fs.readFileSync(file(name)), 'application/json').catch((e) => console.warn(e.message)), 1000);
}
async function restore() {
  for (const name of ['reviews', 'help']) {
    try { const buf = await H.kvGet(name); if (buf) fs.writeFileSync(file(name), buf); } catch (e) { console.warn(`social: restore ${name}:`, e.message); }
  }
}
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function limited(req, key, max, windowMs) {
  const k = key + '|' + ipOf(req), now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now); hits.set(k, arr); return false;
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const dist = (a, b) => { const R = 6371000, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r); return R * Math.sqrt(dLa * dLa + dLo * dLo); };
const CHECKS = ['ramp', 'door', 'step', 'toilet', 'elevator', 'parking', 'staff', 'tactile'];
const HELP_KINDS = ['escort', 'stairs', 'transport', 'shop', 'lost', 'other'];
const HELP_TTL = 3 * 3600e3;

async function body(req, res, limit) {
  let buf;
  try { buf = await H.readBody(req, limit || 64 * 1024); } catch (e) { H.sendJson(res, 400, { error: 'too large' }); return null; }
  const ct = req.headers['content-type'] || '';
  try {
    if (ct.startsWith('multipart/form-data')) return H.parseMultipart(buf, ct);
    return { fields: JSON.parse(buf.toString('utf8') || '{}'), file: null };
  } catch (e) { H.sendJson(res, 400, { error: 'bad request' }); return null; }
}

// ---------- Отзывы ----------
function reviewSummary(list) {
  const out = { count: list.length, stars: 0, checks: {} };
  if (!list.length) return out;
  out.stars = Math.round(list.reduce((s, r) => s + (r.stars || 0), 0) / list.filter((r) => r.stars).length * 10) / 10 || 0;
  for (const c of CHECKS) {
    const yes = list.filter((r) => r.checks && r.checks[c] === 'yes').length, no = list.filter((r) => r.checks && r.checks[c] === 'no').length;
    if (yes + no) out.checks[c] = { yes, no };
  }
  return out;
}
const pubReview = (r) => ({ id: r.id, name: r.author || '', stars: r.stars, checks: r.checks, text: r.text, photo: r.photo || null, photos: r.photos || (r.photo ? [r.photo] : []), profile: r.profile || '', at: r.at });

async function handle(req, res, pathname, url) {
  // GET /api/reviews?place=node/123  или ?near=lat,lng
  if (pathname === '/api/reviews' && req.method === 'GET') {
    const all = read('reviews').filter((r) => !r.hidden);
    const place = url.searchParams.get('place');
    if (place) {
      // то же место могли отметить по-разному (osm-id или координаты) — берём и отзывы в 30 м с тем же названием
      const lat = num(url.searchParams.get('lat')), lng = num(url.searchParams.get('lng')), nm = clean(url.searchParams.get('name'), 120).toLowerCase();
      const same = (r) => r.place === place || (lat != null && lng != null && dist([lat, lng], [r.lat, r.lng]) < 30 && (!nm || !r.placeName || r.placeName.toLowerCase() === nm));
      const list = all.filter(same).sort((a, b) => b.at.localeCompare(a.at)); return H.sendJson(res, 200, { summary: reviewSummary(list), reviews: list.slice(0, 50).map(pubReview) }); }
    const near = (url.searchParams.get('near') || '').split(',').map(Number);
    if (near.length === 2 && near.every(Number.isFinite)) {
      const byPlace = {};
      all.filter((r) => dist(near, [r.lat, r.lng]) < 3000).forEach((r) => { (byPlace[r.place] = byPlace[r.place] || { place: r.place, name: r.placeName, lat: r.lat, lng: r.lng, list: [] }).list.push(r); });
      return H.sendJson(res, 200, Object.values(byPlace).map((p) => ({ place: p.place, name: p.name, lat: p.lat, lng: p.lng, summary: reviewSummary(p.list) })));
    }
    return H.sendJson(res, 400, { error: 'place or near required' });
  }
  if (pathname === '/api/reviews' && req.method === 'POST') {
    if (limited(req, 'rev', 10, 3600e3)) return H.sendJson(res, 429, { error: 'Слишком много отзывов, попробуйте позже' });
    const b = await body(req, res, 8 * 1024 * 1024); if (!b) return;
    const f = b.fields, lat = num(f.lat), lng = num(f.lng), place = clean(f.place, 60);
    if (lat == null || lng == null || !place) return H.sendJson(res, 400, { error: 'Нет места' });
    let checks = {}; try { checks = typeof f.checks === 'string' ? JSON.parse(f.checks) : (f.checks || {}); } catch (e) {}
    const ck = {}; for (const c of CHECKS) if (checks[c] === 'yes' || checks[c] === 'no') ck[c] = checks[c];
    const stars = Math.max(0, Math.min(5, Math.round(num(f.stars) || 0)));
    const text = clean(f.text, 600);
    if (!stars && !Object.keys(ck).length && !text && !(b.files || []).length) return H.sendJson(res, 400, { error: 'Пустой отзыв' });
    // до 5 фото; каждое — на диск и копией в KV, чтобы не пропадали при передеплое
    const photos = [];
    for (const fl of (b.files || (b.file ? [b.file] : [])).filter((x) => x.fieldName === 'photo').slice(0, 5)) {
      if (!/^image\/(jpeg|png|webp)$/.test(fl.mimetype) || fl.data.length < 100) continue;
      const name = crypto.randomUUID() + (/png/.test(fl.mimetype) ? '.png' : /webp/.test(fl.mimetype) ? '.webp' : '.jpg');
      fs.writeFileSync(path.join(H.UPLOADS_DIR, name), fl.data);
      H.kvPut('photo:' + name, fl.data, fl.mimetype).catch((e) => console.warn(e.message));
      photos.push('/uploads/' + name);
    }
    const photo = photos[0] || null;
    const list = read('reviews');
    const r = { id: crypto.randomUUID(), place, placeName: clean(f.placeName, 120), lat, lng, stars, checks: ck, text, photo, photos,
      author: clean(f.author, 40), profile: clean(f.profile, 30), at: new Date().toISOString(), ip: crypto.createHash('sha256').update(ipOf(req)).digest('hex').slice(0, 12) };
    list.unshift(r); write('reviews', list.slice(0, 20000));
    return H.sendJson(res, 201, { ok: true, id: r.id });
  }
  let m = pathname.match(/^\/api\/reviews\/([^/]+)\/flag$/);
  if (m && req.method === 'POST') {
    if (limited(req, 'flag', 20, 3600e3)) return H.sendJson(res, 429, { error: 'too many' });
    const list = read('reviews'), r = list.find((x) => x.id === m[1]); if (!r) return H.sendJson(res, 404, { error: 'not found' });
    r.flags = (r.flags || 0) + 1; if (r.flags >= 3) r.hidden = true; write('reviews', list);
    return H.sendJson(res, 200, { ok: true });
  }

  // ---------- Помощь волонтёров ----------
  // Просьба видна всем примерно (±150 м), точное место и контакты — только откликнувшемуся волонтёру
  const alive = (h) => h.status !== 'closed' && Date.now() - new Date(h.at).getTime() < HELP_TTL;
  const pubHelp = (h) => ({ id: h.id, kind: h.kind, text: h.text, lat: Math.round(h.lat * 700) / 700, lng: Math.round(h.lng * 450) / 450, at: h.at, status: h.status, profile: h.profile });
  if (pathname === '/api/help' && req.method === 'GET') {
    const near = (url.searchParams.get('near') || '').split(',').map(Number);
    let list = read('help').filter(alive);
    if (near.length === 2 && near.every(Number.isFinite)) list = list.filter((h) => dist(near, [h.lat, h.lng]) < 30000);
    return H.sendJson(res, 200, list.map(pubHelp));
  }
  if (pathname === '/api/help' && req.method === 'POST') {
    if (limited(req, 'help', 5, 3600e3)) return H.sendJson(res, 429, { error: 'Слишком много просьб, попробуйте позже' });
    const b = await body(req, res); if (!b) return;
    const f = b.fields, lat = num(f.lat), lng = num(f.lng);
    if (lat == null || lng == null) return H.sendJson(res, 400, { error: 'Нет координат' });
    const kind = HELP_KINDS.includes(f.kind) ? f.kind : 'other';
    const token = crypto.randomBytes(16).toString('hex');
    const list = read('help').filter((h) => Date.now() - new Date(h.at).getTime() < 7 * 864e5);
    const h = { id: crypto.randomUUID(), kind, text: clean(f.text, 300), lat, lng, contact: clean(f.contact, 40), name: clean(f.name, 40), profile: clean(f.profile, 30),
      at: new Date().toISOString(), status: 'open', token, volunteer: null };
    list.unshift(h); write('help', list);
    return H.sendJson(res, 201, { ok: true, id: h.id, token });
  }
  m = pathname.match(/^\/api\/help\/([^/]+)$/);
  if (m && req.method === 'GET') {   // просящий видит, кто откликнулся
    const h = read('help').find((x) => x.id === m[1]); if (!h) return H.sendJson(res, 404, { error: 'not found' });
    if (url.searchParams.get('token') !== h.token) return H.sendJson(res, 200, pubHelp(h));
    return H.sendJson(res, 200, { ...pubHelp(h), lat: h.lat, lng: h.lng, volunteer: h.volunteer });
  }
  m = pathname.match(/^\/api\/help\/([^/]+)\/(accept|close)$/);
  if (m && req.method === 'POST') {
    const b = await body(req, res); if (!b) return;
    const list = read('help'), h = list.find((x) => x.id === m[1]); if (!h) return H.sendJson(res, 404, { error: 'not found' });
    if (m[2] === 'close') { if (b.fields.token !== h.token && b.fields.vtoken !== (h.volunteer && h.volunteer.token)) return H.sendJson(res, 403, { error: 'forbidden' }); h.status = 'closed'; write('help', list); return H.sendJson(res, 200, { ok: true }); }
    if (limited(req, 'accept', 10, 3600e3)) return H.sendJson(res, 429, { error: 'too many' });
    if (!alive(h)) return H.sendJson(res, 410, { error: 'Просьба уже закрыта' });
    if (h.volunteer) return H.sendJson(res, 409, { error: 'Уже откликнулся другой волонтёр' });
    const name = clean(b.fields.name, 40), phone = clean(b.fields.phone, 30);
    if (!name || !/\d{6,}/.test(phone.replace(/\D/g, ''))) return H.sendJson(res, 400, { error: 'Укажите имя и телефон' });
    const vtoken = crypto.randomBytes(12).toString('hex');
    h.volunteer = { name, phone, at: new Date().toISOString(), token: vtoken }; h.status = 'accepted'; write('help', list);
    if (H.notify) H.notify('help', h.id, (lang) => ({ title: 'ICity', body: { kk: `${name} көмекке келеді`, en: `${name} is coming to help you` }[lang] || `${name} идёт к вам на помощь`, url: '/map?do=help', tag: 'help-' + h.id })).catch(() => {});
    return H.sendJson(res, 200, { ok: true, vtoken, lat: h.lat, lng: h.lng, contact: h.contact, name: h.name, text: h.text });
  }
  return null;   // не наш маршрут
}

module.exports = { init(helpers) { H = helpers; return restore(); }, handle };
