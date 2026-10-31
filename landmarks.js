// Достопримечательности и заметные здания города — значками с подписью прямо на карте (как в 2ГИС).
// Мечети, соборы, музеи, театры, стадионы, вокзалы, аэропорт, ТЦ, памятники, парки, зоопарк.
// Один запрос к Overpass на город; результат кэшируется на 7 дней в памяти и в Cloudflare KV.
// GET /api/landmarks?city=<key>&bb=s,w,n,e  →  200 {at, items:[{n,nk,ne,k,ll,w,t}]}  или 202 {pending:true}
let H = null;
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const TTL = 7 * 864e5;
const mem = new Map();
const busy = new Map();
const lastErr = new Map();

function query(bb) {
  return `[out:json][timeout:110];(`
    + `nwr["tourism"~"^(attraction|museum|theme_park|zoo|gallery|viewpoint|aquarium)$"]["name"](${bb});`
    + `nwr["historic"~"^(monument|memorial|castle|fort|ruins|archaeological_site|mausoleum|tomb)$"]["name"]["memorial"!~"^(plaque|blue_plaque|stolperstein|bench)$"](${bb});`
    + `nwr["amenity"="place_of_worship"]["name"](${bb});`
    + `nwr["amenity"~"^(theatre|arts_centre|bus_station|concert_hall|planetarium|circus)$"]["name"](${bb});`
    + `nwr["leisure"~"^(stadium|water_park|sports_centre)$"]["name"]["wikidata"](${bb});nwr["leisure"="stadium"]["name"](${bb});`
    + `nwr["leisure"="park"]["name"]["wikidata"](${bb});nwr["leisure"="park"]["name"]["tourism"](${bb});`
    + `nwr["railway"="station"]["name"]["station"!="subway"](${bb});nwr["station"="subway"]["name"](${bb});`
    + `nwr["aeroway"="aerodrome"]["name"](${bb});`
    + `nwr["shop"="mall"]["name"](${bb});`
    + `nwr["amenity"="university"]["name"](${bb});`
    + `nwr["man_made"~"^(tower|water_tower)$"]["name"]["wikidata"](${bb});`
    + `);out center tags;`;
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

// Вид значка и «вес» (чем больше — тем раньше виден при отдалении)
function kindOf(g) {
  const rel = g.religion || '';
  if (g.aeroway === 'aerodrome') return ['airport', 6];
  if (g.amenity === 'place_of_worship') {
    if (rel === 'muslim') return ['mosque', 3];
    if (rel === 'christian') return ['church', 3];
    return ['temple', 2];
  }
  if (g.leisure === 'stadium') return ['stadium', 4];
  if (g.railway === 'station' || g.station === 'subway') return [g.station === 'subway' ? 'metro' : 'train', g.station === 'subway' ? 2 : 4];
  if (g.amenity === 'bus_station') return ['bus', 3];
  if (g.tourism === 'museum' || g.tourism === 'gallery' || g.amenity === 'planetarium') return ['museum', 3];
  if (g.amenity === 'theatre' || g.amenity === 'concert_hall' || g.amenity === 'circus' || g.amenity === 'arts_centre') return ['theatre', 3];
  if (g.shop === 'mall') return ['mall', 3];
  if (g.tourism === 'zoo' || g.tourism === 'aquarium') return ['zoo', 3];
  if (g.tourism === 'theme_park' || g.leisure === 'water_park') return ['fun', 3];
  if (g.amenity === 'university') return ['uni', 2];
  if (g.leisure === 'park') return ['park', 2];
  if (g.leisure === 'sports_centre') return ['stadium', 2];
  if (g.historic === 'castle' || g.historic === 'fort') return ['castle', 3];
  if (g.historic === 'mausoleum' || g.historic === 'tomb') return ['mausoleum', 3];
  if (g.historic === 'monument') return ['monument', 2];
  if (g.historic === 'memorial') return ['memorial', 1];
  if (g.historic) return ['ruins', 2];
  if (g.man_made) return ['tower', 3];
  if (g.tourism === 'viewpoint') return ['view', 1];
  return ['sight', 2];
}
const KEEP = ['tourism', 'historic', 'amenity', 'leisure', 'railway', 'station', 'aeroway', 'shop', 'religion', 'wikidata', 'wikipedia', 'wheelchair', 'opening_hours', 'website', 'phone', 'contact:phone', 'addr:street', 'addr:housenumber', 'man_made', 'image', 'wikimedia_commons'];

async function compute(city, bb) {
  const q = query(bb);
  let d = null, err = null;
  for (let round = 0; round < 2 && !d; round++) {
    try { d = await Promise.any(MIRRORS.slice(0, 2).map((u) => fetchOne(u, q))); }
    catch (e) { try { d = await fetchOne(MIRRORS[2], q); } catch (e2) { err = e2; } }
    if (!d && round === 0) await new Promise((r) => setTimeout(r, 15e3));
  }
  if (!d) throw err || new Error('overpass unavailable');
  const seen = new Set(), items = [];
  for (const e of d.elements) {
    const g = e.tags || {}; const name = g['name:ru'] || g.name; if (!name) continue;
    const la = e.lat != null ? e.lat : e.center && e.center.lat, lo = e.lon != null ? e.lon : e.center && e.center.lon;
    if (la == null || lo == null) continue;
    const [k, base] = kindOf(g);
    // одно и то же место бывает и точкой, и контуром — оставляем одно
    const key = k + '|' + name.toLowerCase() + '|' + la.toFixed(3) + ',' + lo.toFixed(3);
    if (seen.has(key)) continue; seen.add(key);
    let w = base + (g.wikidata ? 2 : 0) + (g.wikipedia ? 1 : 0) + (e.type !== 'node' ? 1 : 0);
    if (g.tourism === 'attraction') w += 1;
    const t = {}; KEEP.forEach((x) => { if (g[x]) t[x] = String(g[x]).slice(0, 200); });
    items.push({ id: e.type + '/' + e.id, n: name.slice(0, 80), nk: (g['name:kk'] || '').slice(0, 80), ne: (g['name:en'] || '').slice(0, 80), k, w, ll: [+la.toFixed(6), +lo.toFixed(6)], t });
  }
  items.sort((a, b) => b.w - a.w);
  const data = { at: Date.now(), items: items.slice(0, 1500) };
  mem.set(city, data);
  H.kvPut('landmarks:' + city, JSON.stringify(data), 'application/json').catch(() => {});
  return data;
}

async function handle(req, res, pathname, url) {
  if (pathname !== '/api/landmarks' || req.method !== 'GET') return null;
  const city = String(url.searchParams.get('city') || '');
  const n = String(url.searchParams.get('bb') || '').split(',').map(Number);
  if (!/^[a-z_-]{2,30}$/.test(city) || n.length !== 4 || n.some((x) => !isFinite(x))
    || n[0] < 40 || n[2] > 56 || n[1] < 46 || n[3] > 88 || n[2] - n[0] > 0.6 || n[3] - n[1] > 0.9 || n[2] <= n[0] || n[3] <= n[1]) {
    return H.sendJson(res, 400, { error: 'bad request' });
  }
  let c = mem.get(city);
  if (!c) { try { const b = await H.kvGet('landmarks:' + city); if (b) { c = JSON.parse(b); mem.set(city, c); } } catch (e) {} }
  const fresh = c && Date.now() - c.at < TTL;
  if (!fresh && !busy.has(city)) {
    busy.set(city, compute(city, n.map((x) => x.toFixed(4)).join(',')).then(() => lastErr.delete(city))
      .catch((e) => { lastErr.set(city, String(e && (e.errors ? e.errors.map((x) => x.message).join('; ') : e.message)).slice(0, 200)); console.warn('landmarks', city, lastErr.get(city)); })
      .finally(() => busy.delete(city)));
  }
  if (c) return H.sendJson(res, 200, c);
  return H.sendJson(res, 202, { pending: true, error: lastErr.get(city) || null });
}

module.exports = { init(h) { H = h; }, handle };
