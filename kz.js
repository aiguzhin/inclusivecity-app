// Территории Казахстана по уровням: область → район (или город областного значения) → населённые пункты.
// Данные — границы и населённые пункты OpenStreetMap (ODbL, © участники OpenStreetMap) через Overpass.
// Сервер спрашивает Overpass только по выбранной территории и кэширует ответ на 30 дней (память + Cloudflare KV),
// поэтому клиент никогда не скачивает списки всех регионов сразу.
//   GET /api/kz/children?id=<osm relation id>&kind=region|district
//     200 {at, items:[{id,t,n,nk,ne,ll,p?}]}  или  202 {pending:true}
//   region   → районы и города областного значения (admin_level 6)
//   district → населённые пункты (place = city/town/village/hamlet) внутри района
let H = null;
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const TTL = 30 * 864e5;
const VER = 1;
const MAX_MEM = 120;                 // столько последних территорий держим в памяти, остальное — в KV
const mem = new Map();
const busy = new Map();
const lastErr = new Map();

// 20 верхних единиц (17 областей и 3 города республиканского значения) — id отношений OSM
const REGIONS = [214834, 215441, 215683, 215686, 215699, 215718, 215722, 215727, 215739, 215743, 215760, 215772, 215776,
  1288730, 2465058, 3087155, 3389772, 14243026, 14312169, 14312737];

function query(id, kind) {
  const area = `rel(${id});map_to_area->.a;`;
  if (kind === 'region') return `[out:json][timeout:90];${area}rel(area.a)["boundary"="administrative"]["admin_level"="6"]["name"];out tags center;`;
  return `[out:json][timeout:90];${area}node(area.a)["place"~"^(city|town|village|hamlet)$"]["name"];out;`;
}
async function fetchOne(url, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 50e3);
  try {
    const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ICity/1.0 (inclusivecity.uk)' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || !Array.isArray(d.elements)) throw new Error('bad payload');
    if (d.remark && /runtime error|timed out/i.test(d.remark)) throw new Error(d.remark.slice(0, 80));
    return d;
  } finally { clearTimeout(t); }
}
const PLACE_RANK = { city: 0, town: 1, village: 2, hamlet: 3 };
function shorten(s) { return String(s || '').slice(0, 80); }

async function compute(key, id, kind) {
  const q = query(id, kind);
  let d = null, err = null;
  // все зеркала сразу, берём первый ответ: одно из них часто перегружено и молчит минутами
  for (let round = 0; round < 2 && !d; round++) {
    try { d = await Promise.any(MIRRORS.map((u) => fetchOne(u, q))); }
    catch (e) { err = e.errors ? e.errors[0] : e; }
    if (!d && round === 0) await new Promise((r) => setTimeout(r, 8e3));
  }
  if (!d) throw err || new Error('overpass unavailable');
  const items = [];
  for (const e of d.elements) {
    const g = e.tags || {};
    const la = e.lat != null ? e.lat : e.center && e.center.lat, lo = e.lon != null ? e.lon : e.center && e.center.lon;
    if (la == null || lo == null) continue;
    const it = { id: e.id, n: shorten(g['name:ru'] || g.name), nk: shorten(g['name:kk']), ne: shorten(g['name:en']), ll: [+la.toFixed(5), +lo.toFixed(5)] };
    if (kind === 'district') { it.p = g.place; if (g.population && /^\d+$/.test(g.population)) it.pop = +g.population; }
    else it.t = /Г\.А\.|Қ\.Ә\.|город|қаласы/i.test(it.n + ' ' + it.nk) ? 'city' : 'district';
    items.push(it);
  }
  if (kind === 'district') items.sort((a, b) => (PLACE_RANK[a.p] - PLACE_RANK[b.p]) || ((b.pop || 0) - (a.pop || 0)) || a.n.localeCompare(b.n, 'ru'));
  else items.sort((a, b) => (a.t === b.t ? 0 : a.t === 'city' ? -1 : 1) || a.n.localeCompare(b.n, 'ru'));
  const data = { at: Date.now(), v: VER, items: items.slice(0, 2500) };
  remember(key, data);
  H.kvPut('kz:' + key, JSON.stringify(data), 'application/json').catch(() => {});
  return data;
}
function remember(key, data) {
  mem.delete(key);
  if (mem.size >= MAX_MEM) mem.delete(mem.keys().next().value);
  mem.set(key, data);
}

async function handle(req, res, pathname, url) {
  if (pathname !== '/api/kz/children' || req.method !== 'GET') return null;
  const id = Number(url.searchParams.get('id'));
  const kind = url.searchParams.get('kind') === 'district' ? 'district' : 'region';
  if (!Number.isInteger(id) || id <= 0 || id > 1e11) return H.sendJson(res, 400, { error: 'bad request' });
  if (kind === 'region' && !REGIONS.includes(id)) return H.sendJson(res, 400, { error: 'unknown region' });
  const key = kind + ':' + id;
  let c = mem.get(key);
  if (!c) { try { const b = await H.kvGet('kz:' + key); if (b) { c = JSON.parse(b); remember(key, c); } } catch (e) {} }
  const fresh = c && c.v === VER && Date.now() - c.at < TTL;
  if (!fresh && !busy.has(key)) {
    busy.set(key, compute(key, id, kind).then(() => lastErr.delete(key))
      .catch((e) => { lastErr.set(key, String(e && (e.errors ? e.errors.map((x) => x.message).join('; ') : e.message)).slice(0, 200)); console.warn('kz', key, lastErr.get(key)); })
      .finally(() => busy.delete(key)));
  }
  if (c) { res.setHeader('Cache-Control', 'public, max-age=3600'); return H.sendJson(res, 200, c); }
  return H.sendJson(res, 202, { pending: true, error: lastErr.get(key) || null });
}

// Списки районов небольшие — после запуска сервер по очереди готовит их для всех 20 регионов,
// чтобы выбор области открывался сразу. Населённые пункты района — только по запросу.
async function warm() {
  for (const id of REGIONS) {
    const key = 'region:' + id;
    try {
      let x = mem.get(key);
      if (!x) { const b = await H.kvGet('kz:' + key); if (b) { x = JSON.parse(b); remember(key, x); } }
      if (x && x.v === VER && Date.now() - x.at < TTL) continue;
      if (busy.has(key)) continue;
      const job = compute(key, id, 'region'); busy.set(key, job);
      await job.catch((e) => console.warn('kz warm', id, e.message)).finally(() => busy.delete(key));
      await new Promise((r) => setTimeout(r, 15e3));
    } catch (e) {}
  }
}

module.exports = { init(h) { H = h; setTimeout(() => warm().catch(() => {}), 90e3); setInterval(() => warm().catch(() => {}), 24 * 3600e3); }, handle };
