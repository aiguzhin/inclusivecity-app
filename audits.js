// Проверка мест волонтёрами («Проверено ICity»): /audit, /volunteer.
// Волонтёр (вход через Supabase) проходит чек-лист из 8 пунктов у входа в место, прикладывает до 3 фото.
// Балл = «да» / («да» + «нет»), «нет такого» не считается. Знак: ≥80 — доступно, 50–79 — частично, <50 — недоступно.
// За проверку засчитывается 0,5 волонтёрского часа (видно в /volunteer, там же печатная справка).
// Данные — data/audits.json + копия в Cloudflare KV (`audits`), фото — uploads/ + KV `photo:<имя>`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITEMS = ['entrance', 'ramp', 'door', 'inside', 'toilet', 'parking', 'tactile', 'staff'];
const HOURS_PER_AUDIT = 0.5;
const DAY_LIMIT = 30;
const MAX_PHOTOS = 3;

let D = null, FILE = null;
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } };
function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list), 'utf8');
  clearTimeout(save.t);
  save.t = setTimeout(() => D.kvPut('audits', fs.readFileSync(FILE), 'application/json').catch((e) => console.warn('audits kv:', e.message)), 1000);
}
function init(deps) {
  D = deps;
  FILE = path.join(deps.DATA_DIR, 'audits.json');
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, '[]', 'utf8');
    deps.kvGet('audits').then((b) => { if (b) fs.writeFileSync(FILE, b); }).catch(() => {});
  }
}

// Кто вошёл: токен Supabase → id и имя для таблицы (имя + первая буква фамилии)
const who = new Map();
async function whoAmI(req) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  const auth = String(req.headers.authorization || '');
  if (!url || !anon || !/^Bearer [\w.-]{20,}$/.test(auth)) return null;
  const hit = who.get(auth); if (hit && Date.now() - hit.at < 120e3) return hit.u;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !/^[0-9a-f-]{36}$/.test(u.id)) return null;
    const md = u.user_metadata || {};
    const full = String(md.ic_name || md.full_name || md.name || '').trim();
    const parts = full.split(/\s+/).filter(Boolean);
    const name = parts.length ? parts[0] + (parts[1] ? ' ' + parts[1][0] + '.' : '') : 'Волонтёр';
    const res = { id: u.id, name: name.slice(0, 40) };
    if (who.size > 5000) who.clear();
    who.set(auth, { u: res, at: Date.now() });
    return res;
  } catch (e) { return null; }
}

function score(answers) {
  let yes = 0, no = 0;
  for (const k of ITEMS) { if (answers[k] === 'yes') yes++; else if (answers[k] === 'no') no++; }
  return yes + no ? Math.round((yes / (yes + no)) * 100) : null;
}
const level = (s) => (s == null ? 'unknown' : s >= 80 ? 'good' : s >= 50 ? 'partial' : 'bad');
function nearestCity(lat, lon) {
  let best = null, bd = Infinity;
  for (const [id, c] of Object.entries(D.BUS_CITIES)) {
    const d = (c[0] - lat) ** 2 + ((c[1] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bd) { bd = d; best = id; }
  }
  return Math.sqrt(bd) * 111 < 40 ? best : null;   // дальше 40 км от центра — не город проекта
}
const pub = (a) => ({ id: a.id, place: a.place, lat: a.lat, lon: a.lon, city: a.city, answers: a.answers, score: a.score, level: level(a.score),
  comment: a.comment, photos: a.photos, by: a.byName, createdAt: a.createdAt });
const meters = (a, b) => {
  const R = 6371e3, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function handle(req, res, pathname) {
  const send = D.sendJson;
  const q = new URL(req.url, 'http://x').searchParams;

  // Список: ?near=lat,lon&r=метры (карточка места) или ?city=
  if (pathname === '/api/audits' && req.method === 'GET') {
    let list = load();
    const near = String(q.get('near') || '').split(',').map(Number);
    if (near.length === 2 && near.every(Number.isFinite)) {
      const r = Math.min(Number(q.get('r')) || 40, 300);
      list = list.filter((a) => meters(near, [a.lat, a.lon]) <= r);
    } else if (q.get('city')) list = list.filter((a) => a.city === q.get('city'));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, list.slice(0, 500).map(pub)), true;
  }

  // Таблица волонтёров и общие цифры
  if (pathname === '/api/audits/leaderboard' && req.method === 'GET') {
    const list = load(), by = new Map();
    for (const a of list) {
      const v = by.get(a.byId) || { name: a.byName, audits: 0, cities: new Set() };
      v.audits++; v.name = a.byName; if (a.city) v.cities.add(a.city); by.set(a.byId, v);
    }
    const top = [...by.values()].sort((a, b) => b.audits - a.audits).slice(0, 20)
      .map((v) => ({ name: v.name, audits: v.audits, hours: v.audits * HOURS_PER_AUDIT, cities: [...v.cities] }));
    const cities = {};
    list.forEach((a) => { if (a.city) cities[a.city] = (cities[a.city] || 0) + 1; });
    return send(res, 200, { total: list.length, volunteers: by.size, hours: list.length * HOURS_PER_AUDIT,
      good: list.filter((a) => level(a.score) === 'good').length, cities, top, hoursPerAudit: HOURS_PER_AUDIT }), true;
  }

  // Мои проверки и часы
  if (pathname === '/api/audits/me' && req.method === 'GET') {
    const me = await whoAmI(req);
    if (!me) return send(res, 401, { error: 'Войдите в аккаунт' }), true;
    const mine = load().filter((a) => a.byId === me.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, { name: me.name, audits: mine.length, hours: mine.length * HOURS_PER_AUDIT,
      first: mine.length ? mine[mine.length - 1].createdAt : null, last: mine.length ? mine[0].createdAt : null, list: mine.map(pub) }), true;
  }

  // Новая проверка
  if (pathname === '/api/audits' && req.method === 'POST') {
    const me = await whoAmI(req);
    if (!me) return send(res, 401, { error: 'Войдите в аккаунт, чтобы проверки засчитывались вам' }), true;
    const list = load();
    const today = list.filter((a) => a.byId === me.id && Date.now() - new Date(a.createdAt).getTime() < 864e5).length;
    if (today >= DAY_LIMIT) return send(res, 429, { error: `Не больше ${DAY_LIMIT} проверок в сутки` }), true;
    let fields = {}, files = [];
    try {
      const buf = await D.readBody(req, 3 * D.MAX_UPLOAD_BYTES);
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) {
        const parsed = D.parseMultipartAll ? D.parseMultipartAll(buf, ct) : D.parseMultipart(buf, ct);
        fields = parsed.fields; files = parsed.files || (parsed.file ? [parsed.file] : []);
      } else fields = JSON.parse(buf.toString('utf8') || '{}');
    } catch (e) { return send(res, 400, { error: e.code === 'LIMIT' ? 'Фото слишком большие' : 'Некорректный запрос' }), true; }
    const lat = Number(fields.lat), lon = Number(fields.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: 'Отметьте место на карте' }), true;
    const city = nearestCity(lat, lon);
    if (!city) return send(res, 400, { error: 'Место должно быть в одном из городов ICity' }), true;
    const place = String(fields.place || '').trim().slice(0, 120);
    if (!place) return send(res, 400, { error: 'Напишите название места' }), true;
    let answers = {};
    try { answers = typeof fields.answers === 'string' ? JSON.parse(fields.answers) : (fields.answers || {}); } catch (e) { answers = {}; }
    const clean = {};
    for (const k of ITEMS) clean[k] = ['yes', 'no', 'na'].includes(answers[k]) ? answers[k] : 'na';
    const s = score(clean);
    if (s == null) return send(res, 400, { error: 'Ответьте хотя бы на один пункт «да» или «нет»' }), true;
    // одно место — одна проверка в 30 дней от одного волонтёра (иначе часы набиваются)
    if (list.some((a) => a.byId === me.id && meters([lat, lon], [a.lat, a.lon]) < 30 && Date.now() - new Date(a.createdAt).getTime() < 30 * 864e5))
      return send(res, 409, { error: 'Вы уже проверяли это место в последние 30 дней' }), true;
    const photos = [];
    for (const f of files.filter((f) => /^image\//.test(f.mimetype)).slice(0, MAX_PHOTOS)) {
      const ext = (path.extname(f.filename || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      const name = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(D.UPLOADS_DIR, name), f.data);
      D.kvPut('photo:' + name, f.data, f.mimetype).catch(() => {});
      photos.push(`/uploads/${name}`);
    }
    const a = { id: crypto.randomUUID(), place, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, city, answers: clean, score: s,
      comment: String(fields.comment || '').trim().slice(0, 500), photos, byId: me.id, byName: me.name, createdAt: new Date().toISOString() };
    list.push(a); save(list);
    const mine = list.filter((x) => x.byId === me.id).length;
    return send(res, 201, { ok: true, audit: pub(a), myAudits: mine, myHours: mine * HOURS_PER_AUDIT }), true;
  }

  // Модерация
  const m = pathname.match(/^\/api\/admin\/audits\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    if (!D.requireAdmin(req)) return send(res, 401, { error: 'unauthorized' }), true;
    const list = load(), i = list.findIndex((a) => a.id === m[1]);
    if (i === -1) return send(res, 404, { error: 'not found' }), true;
    list.splice(i, 1); save(list);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

module.exports = { init, handle, ITEMS };
