// Рейтинг районов: тяжёлый запрос к Overpass делает сервер, а не телефон.
// Серверу не страшны долгие ответы (ждёт до 2 минут, пробует все зеркала), результат кэшируется
// на 7 дней в памяти и в Cloudflare KV — следующий человек получает его мгновенно.
// GET /api/rating?city=<key>&bb=s,w,n,e  →  200 {at, places, pos, neg}  или 202 {pending:true}
let H = null;
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const TTL = 7 * 864e5;
const mem = new Map();       // city → {at, data}
const busy = new Map();      // city → Promise

function query(bb) {
  return `[out:json][timeout:110];node["place"~"^(suburb|quarter|neighbourhood)$"]["name"](${bb});out tags;make sep;out;`
    + `(nwr["ramp:wheelchair"="yes"](${bb});nwr["wheelchair"="yes"](${bb});nwr["highway"="elevator"](${bb});nwr["toilets:wheelchair"="yes"](${bb});`
    + `nwr["parking_space"="disabled"](${bb});node["tactile_paving"="yes"](${bb});nwr["traffic_signals:sound"="yes"](${bb}););out center skel;make sep;out;`
    + `(way["highway"="steps"][!"ramp:wheelchair"][!"ramp"](${bb});nwr["wheelchair"="no"](${bb});node["kerb"="raised"](${bb}););out center skel;`;
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
async function compute(city, bb) {
  const q = query(bb);
  let d = null, err = null;
  for (let round = 0; round < 2 && !d; round++) {
    // два зеркала параллельно, третье — если оба не смогли
    try { d = await Promise.any(MIRRORS.slice(0, 2).map((u) => fetchOne(u, q))); }
    catch (e) { try { d = await fetchOne(MIRRORS[2], q); } catch (e2) { err = e2; } }
    if (!d && round === 0) await new Promise((r) => setTimeout(r, 15e3));
  }
  if (!d) throw err || new Error('overpass unavailable');
  const parts = [[], [], []]; let k = 0;
  d.elements.forEach((e) => { if (e.type === 'sep') k++; else if (parts[k]) parts[k].push(e); });
  const pt = (e) => { const la = e.lat || (e.center && e.center.lat), lo = e.lon || (e.center && e.center.lon); return la ? [+la.toFixed(5), +lo.toFixed(5)] : null; };
  const pick = (t) => { const o = {}; ['name', 'name:ru', 'name:kk', 'name:en', 'place'].forEach((x) => { if (t[x]) o[x] = t[x]; }); return o; };
  const data = {
    at: Date.now(),
    places: parts[0].filter((e) => e.tags && e.tags.name && e.lat).map((e) => ({ tags: pick(e.tags), lat: e.lat, lon: e.lon })),
    pos: parts[1].map(pt).filter(Boolean),
    neg: parts[2].map(pt).filter(Boolean),
  };
  mem.set(city, data);
  H.kvPut('rating:' + city, JSON.stringify(data), 'application/json').catch(() => {});
  return data;
}

async function handle(req, res, pathname, url) {
  if (pathname !== '/api/rating' || req.method !== 'GET') return null;
  const city = String(url.searchParams.get('city') || '');
  const bb = String(url.searchParams.get('bb') || '');
  const n = bb.split(',').map(Number);
  if (!/^[a-z_-]{2,30}$/.test(city) || n.length !== 4 || n.some((x) => !isFinite(x))
    || n[0] < 40 || n[2] > 56 || n[1] < 46 || n[3] > 88 || n[2] - n[0] > 0.6 || n[3] - n[1] > 0.9 || n[2] <= n[0] || n[3] <= n[1]) {
    return H.sendJson(res, 400, { error: 'bad request' });
  }
  let c = mem.get(city);
  if (!c) { try { const b = await H.kvGet('rating:' + city); if (b) { c = JSON.parse(b); mem.set(city, c); } } catch (e) {} }
  const fresh = c && Date.now() - c.at < TTL;
  if (!fresh && !busy.has(city)) {
    const bbs = n.map((x) => x.toFixed(4)).join(',');
    busy.set(city, compute(city, bbs).catch((e) => console.warn('rating', city, e.message)).finally(() => busy.delete(city)));
  }
  if (c) return H.sendJson(res, 200, c);          // устаревший тоже отдаём сразу, свежий посчитается в фоне
  return H.sendJson(res, 202, { pending: true });
}

module.exports = { init(h) { H = h; }, handle };
