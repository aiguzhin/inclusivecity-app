// Барьеры города для маршрутов: высокие бордюры, турникеты, места «не для колясок» из OpenStreetMap
// плюс проверенные сообщения СМИ (barriers-extra.json). Лестницы маршрутизатор Valhalla
// и так знает из OSM, поэтому здесь их нет — только то, что ему нужно запретить явно.
// Тяжёлый запрос к Overpass делает сервер; результат кэшируется на 7 дней в памяти и в Cloudflare KV.
// GET /api/barriers?city=<key>&bb=s,w,n,e  →  200 {at, kerbs, gates, nowc, extra}  или 202 {pending:true}
const fs = require('fs');
const path = require('path');
let H = null;
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const TTL = 7 * 864e5;
const mem = new Map();
const busy = new Map();
const lastErr = new Map();
const EXTRA_FILE = path.join(__dirname, 'barriers-extra.json');

function query(bb) {
  return `[out:json][timeout:110];`
    + `(node["kerb"~"^(raised|normal|regular|yes)$"](${bb});node["barrier"="kerb"]["kerb"!~"^(lowered|flush|no|rolled)$"](${bb}););out body;make sep;out;`
    + `node["barrier"~"^(turnstile|full-height_turnstile|stile|kissing_gate|cycle_barrier|motorcycle_barrier)$"](${bb});out body;make sep;out;`
    + `(nwr["wheelchair"="no"]["highway"](${bb});node["wheelchair"="no"]["railway"="crossing"](${bb}););out tags geom;`;
}
async function fetchOne(url, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120e3);
  try {
    const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ICity/1.0 (inclusivecity.uk)' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || !Array.isArray(d.elements)) throw new Error('bad payload');
    if (d.remark && /runtime error|timed out/i.test(d.remark)) throw new Error(d.remark.slice(0, 80));
    return d;
  } finally { clearTimeout(t); }
}
// Высота бордюра в сантиметрах: «0.12», «12 cm», «120 mm»; без высоты — считаем 12 см (обычный высокий бордюр)
function kerbCm(tags) {
  const v = String(tags['kerb:height'] || '').trim().toLowerCase();
  const m = /^([\d.,]+)\s*(mm|cm|m)?$/.exec(v);
  if (!m) return 12;
  let x = parseFloat(m[1].replace(',', '.'));
  if (m[2] === 'mm') x /= 10; else if (m[2] === 'm' || (!m[2] && x < 1)) x *= 100;
  return Math.round(x * 10) / 10;
}
function readExtra(n) {
  try {
    const all = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8')).items || [];
    return all.filter((x) => x.lat >= n[0] && x.lat <= n[2] && x.lon >= n[1] && x.lon <= n[3]);
  } catch (e) { return []; }
}
async function compute(city, bb) {
  const q = query(bb);
  let d = null, err = null;
  for (let round = 0; round < 2 && !d; round++) {
    try { d = await Promise.any(MIRRORS.slice(0, 2).map((u) => fetchOne(u, q))); }
    catch (e) { try { d = await fetchOne(MIRRORS[2], q); } catch (e2) { err = e2; } }
    if (!d && round === 0) await new Promise((r) => setTimeout(r, 15e3));
  }
  if (!d) throw err || new Error('overpass unavailable');
  const parts = [[], [], []]; let k = 0;
  d.elements.forEach((e) => { if (e.type === 'sep') k++; else if (parts[k]) parts[k].push(e); });
  const ll = (e) => {
    const mid = Array.isArray(e.geometry) && e.geometry.length ? e.geometry[Math.floor(e.geometry.length / 2)] : null;
    const la = e.lat || (mid && mid.lat), lo = e.lon || (mid && mid.lon);
    return la ? [+la.toFixed(6), +lo.toFixed(6)] : null;
  };
  const data = {
    at: Date.now(),
    kerbs: parts[0].map((e) => { const p = ll(e); return p && [p[0], p[1], kerbCm(e.tags || {})]; }).filter(Boolean),
    gates: parts[1].map((e) => { const p = ll(e); return p && [p[0], p[1], (e.tags && e.tags.barrier) || 'gate']; }).filter(Boolean),
    nowc: parts[2].map((e) => {
      const p = ll(e); if (!p) return null;
      // у линий храним все точки: запрещать нужно весь участок, а не только середину
      const g = e.type === 'way' && Array.isArray(e.geometry) ? e.geometry.map((x) => [+x.lat.toFixed(6), +x.lon.toFixed(6)]) : null;
      return { ll: p, hw: (e.tags && e.tags.highway) || '', g };
    }).filter(Boolean),
  };
  mem.set(city, data);
  H.kvPut('barriers:' + city, JSON.stringify(data), 'application/json').catch(() => {});
  return data;
}

async function handle(req, res, pathname, url) {
  if (pathname !== '/api/barriers' || req.method !== 'GET') return null;
  const city = String(url.searchParams.get('city') || '');
  const bb = String(url.searchParams.get('bb') || '');
  const n = bb.split(',').map(Number);
  if (!/^[a-z_-]{2,30}$/.test(city) || n.length !== 4 || n.some((x) => !isFinite(x))
    || n[0] < 40 || n[2] > 56 || n[1] < 46 || n[3] > 88 || n[2] - n[0] > 0.6 || n[3] - n[1] > 0.9 || n[2] <= n[0] || n[3] <= n[1]) {
    return H.sendJson(res, 400, { error: 'bad request' });
  }
  let c = mem.get(city);
  if (!c) { try { const b = await H.kvGet('barriers:' + city); if (b) { c = JSON.parse(b); mem.set(city, c); } } catch (e) {} }
  const fresh = c && Date.now() - c.at < TTL;
  if (!fresh && !busy.has(city)) {
    const bbs = n.map((x) => x.toFixed(4)).join(',');
    busy.set(city, compute(city, bbs).then(() => lastErr.delete(city)).catch((e) => { lastErr.set(city, String(e && (e.errors ? e.errors.map((x) => x.message).join('; ') : e.message)).slice(0, 200)); console.warn('barriers', city, lastErr.get(city)); }).finally(() => busy.delete(city)));
  }
  const extra = readExtra(n);   // сообщения СМИ читаем из файла каждый раз — правка файла сразу в силе
  if (c) return H.sendJson(res, 200, Object.assign({}, c, { extra }));
  return H.sendJson(res, 202, { pending: true, busy: busy.has(city), error: lastErr.get(city) || null, extra });
}

module.exports = { init(h) { H = h; }, handle };
