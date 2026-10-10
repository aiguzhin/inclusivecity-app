// Сборка маршрутов общественного транспорта городов из OpenStreetMap.
//
// Запускается раз в неделю в GitHub Actions (.github/workflows/bus-data.yml):
//   node tools/busbuild.js            — все города
//   node tools/busbuild.js almaty     — один город
// и складывает результат в bus-data/<город>.json. Сервер раздаёт эти файлы как
// /bus-<город>.json, поэтому маршруты не пропадают при передеплое и не зависят
// от того, перегружен ли сейчас публичный Overpass.
//
// Формат файла:
//   stops:  [lat, lon, название, ♿ 1/0?]
//   routes: { r: номер, t: конечная, k: вид (t — троллейбус, m — маршрутка, r — трамвай),
//             s: индексы остановок по ходу движения,
//             p: расстояние каждой остановки от начала линии, м,
//             g: линия маршрута по улицам (encoded polyline, точность 1e-5) }
// Каждое направление — отдельный маршрут: старые (PTv1) отношения OSM описывают
// оба направления сразу, мы разворачиваем их в два.
'use strict';

const CITY_DLAT = 0.13, CITY_DLON = 0.24;   // те же рамки города, что и во фронтенде
const BUS_CITIES = {
  almaty: [43.2383, 76.9455], astana: [51.1282, 71.4306], shymkent: [42.3174, 69.5901],
  karaganda: [49.8063, 73.0855], aktobe: [50.2839, 57.1670], taraz: [42.9000, 71.3667],
  pavlodar: [52.2871, 76.9674], oskemen: [49.9483, 82.6275], semey: [50.4111, 80.2275],
  atyrau: [47.0945, 51.9238], kostanay: [53.2198, 63.6354], kyzylorda: [44.8479, 65.5093],
  oral: [51.2333, 51.3667], petropavl: [54.8667, 69.1500], aktau: [43.6410, 51.1975],
  temirtau: [50.0547, 72.9644], turkistan: [43.3000, 68.2500], kokshetau: [53.2833, 69.4000],
  taldykorgan: [45.0156, 78.3739], ekibastuz: [51.7298, 75.3266],
  konaev: [43.8552, 77.0615], zhezkazgan: [47.8043, 67.7146],
};
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const MEMBER_SNAP_M = 60;   // остановка из состава маршрута — не дальше 60 м от линии
const AREA_SNAP_M = 25;     // остановка города рядом с линией маршрута без своих остановок
const MERGE_M = 70;         // «столбик» и «площадка» одной остановки сливаем в одну
const SIMPLIFY_M = 5;       // упрощение линии: погрешность до 5 м на глаз не видна

function cityBbox(city) {
  const [lat, lon] = BUS_CITIES[city];
  return [lat - CITY_DLAT, lon - CITY_DLON, lat + CITY_DLAT, lon + CITY_DLON].map((x) => x.toFixed(4)).join(',');
}
function overpassQuery(city) {
  const b = cityBbox(city);
  return `[out:json][timeout:300];rel[route~"^(bus|trolleybus|minibus|share_taxi|tram)$"](${b})->.r;`
    + `.r out body;way(r.r);out geom;node(r.r);out;`
    + `(node[highway=bus_stop](${b});node[public_transport=platform](${b}););out;`;
}

// --- геометрия в локальных метрах ---
function projector(lat0) {
  const k = Math.cos(lat0 * Math.PI / 180) * 111320;
  return (p) => [p[1] * k, p[0] * 111320];
}
function simplify(pts, xy, tol) {   // Дуглас — Пейкер
  if (pts.length < 3) return pts.slice();
  const P = pts.map(xy), keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      let t = L2 ? ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function encodePolyline(pts) {
  let out = '', pl = 0, pn = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, lo] of pts) {
    const a = Math.round(la * 1e5), b = Math.round(lo * 1e5);
    out += enc(a - pl) + enc(b - pn); pl = a; pn = b;
  }
  return out;
}

// Пути отношения складываем в одну линию: каждый следующий разворачиваем так,
// чтобы он начинался там, где закончился предыдущий
function chainWays(list) {
  const d = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  let line = [];
  for (let k = 0; k < list.length; k++) {
    let g = list[k];
    if (!line.length) {
      const next = list[k + 1];
      if (next) {   // первый путь ориентируем по второму
        const e = (x) => Math.min(d(x, next[0]), d(x, next[next.length - 1]));
        if (e(g[0]) < e(g[g.length - 1])) g = g.slice().reverse();
      }
      line = g.slice();
      continue;
    }
    const end = line[line.length - 1];
    if (d(g[g.length - 1], end) < d(g[0], end)) g = g.slice().reverse();
    line = line.concat(d(g[0], end) < 1e-7 ? g.slice(1) : g);
  }
  return line;
}

// Ближайшая точка линии: расстояние до неё и путь от начала линии
function locate(L, cum, P, minBox) {
  let best = Infinity, pos = 0;
  for (let i = 1; i < L.length; i++) {
    const [ax, ay] = L[i - 1], [bx, by] = L[i];
    if (minBox && (Math.min(ax, bx) - P[0] > minBox || P[0] - Math.max(ax, bx) > minBox
      || Math.min(ay, by) - P[1] > minBox || P[1] - Math.max(ay, by) > minBox)) continue;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? ((P[0] - ax) * dx + (P[1] - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dd = Math.hypot(P[0] - ax - t * dx, P[1] - ay - t * dy);
    if (dd < best) { best = dd; pos = cum[i - 1] + t * Math.sqrt(L2); }
  }
  return { d: best, pos };
}

const isStopRole = (role) => /stop|platform|^$|^forward$|^backward$|^both$/.test(role);
const roleDir = (role) => /backward/.test(role) ? 'b' : /forward/.test(role) ? 'f' : '';
const kindOf = (t) => t.route === 'trolleybus' ? 't' : (t.route === 'minibus' || t.route === 'share_taxi') ? 'm' : t.route === 'tram' ? 'r' : '';

function buildCity(city, osm) {
  const nodes = new Map(), ways = new Map(), rels = [];
  for (const e of osm.elements || []) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way' && e.geometry) ways.set(e.id, e.geometry.map((g) => [g.lat, g.lon]));
    else if (e.type === 'relation') rels.push(e);
  }
  const [lat0] = BUS_CITIES[city];
  const xy = projector(lat0);
  // все остановки города (для маршрутов, у которых в OSM нет своих остановок)
  const cityStops = [...nodes.values()].filter((n) => n.tags && (n.tags.highway === 'bus_stop'
    || n.tags.public_transport === 'platform' || n.tags.public_transport === 'stop_position'));
  const cityStopsXY = cityStops.map((n) => xy([n.lat, n.lon]));
  const named = cityStops.filter((n) => n.tags.name || n.tags['name:ru']);
  const namedXY = named.map((n) => xy([n.lat, n.lon]));

  const stops = [], stopIndex = new Map(), routes = [];
  const nameOf = (n) => {
    const t = n.tags || {};
    if (t.name || t['name:ru']) return t.name || t['name:ru'];
    // у безымянного столбика берём название соседней остановки
    const P = xy([n.lat, n.lon]);
    let best = 50, nm = '';
    named.forEach((m, i) => { const d = Math.hypot(namedXY[i][0] - P[0], namedXY[i][1] - P[1]); if (d < best) { best = d; nm = m.tags.name || m.tags['name:ru']; } });
    return nm;
  };
  const stopId = (n) => {
    if (!stopIndex.has(n.id)) {
      const t = n.tags || {};
      const s = [Math.round(n.lat * 1e5) / 1e5, Math.round(n.lon * 1e5) / 1e5, nameOf(n)];
      if (t.wheelchair === 'yes') s.push(1); else if (t.wheelchair === 'no') s.push(0);
      stops.push(s); stopIndex.set(n.id, stops.length - 1);
    }
    return stopIndex.get(n.id);
  };

  const seen = new Set();   // одинаковые варианты одного номера (дубли в OSM) не повторяем
  for (const r of rels) {
    const t = r.tags || {};
    const ref = String(t.ref || t.name || '').trim();
    if (!ref) continue;
    const v2 = t['public_transport:version'] === '2';
    const members = r.members || [];
    const wayMembers = members.filter((m) => m.type === 'way' && ways.has(m.ref) && !/platform|stop|station|turning/.test(m.role));
    const stopMembers = members.filter((m) => m.type === 'node' && nodes.has(m.ref) && isStopRole(m.role));
    // Направления: в PTv2 отношение — одно направление; в PTv1 — туда (без backward)
    // и обратно (без forward, в обратном порядке)
    const dirs = [];
    if (v2 || !wayMembers.some((m) => /forward|backward/.test(m.role))) {
      dirs.push({ ways: wayMembers, stopsM: stopMembers, to: t.to, both: !v2 });
    } else {
      dirs.push({ ways: wayMembers.filter((m) => roleDir(m.role) !== 'b'),
                  stopsM: stopMembers.filter((m) => roleDir(m.role) !== 'b'), to: t.to });
      dirs.push({ ways: wayMembers.filter((m) => roleDir(m.role) !== 'f').reverse(),
                  stopsM: stopMembers.filter((m) => roleDir(m.role) !== 'f').reverse(), to: t.from, back: true });
    }
    for (const dir of dirs) {
      let line = chainWays(dir.ways.map((m) => ways.get(m.ref)));
      if (line.length < 2) continue;
      line = simplify(line, xy, SIMPLIFY_M);
      const L = line.map(xy), cum = [0];
      for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]));
      if (cum[cum.length - 1] < 300) continue;
      // остановки: свои (если их хотя бы 3), иначе — остановки города вдоль линии
      let cand = [];
      const own = dir.stopsM.map((m) => nodes.get(m.ref));
      if (own.length >= 3) {
        own.forEach((n) => { const q = locate(L, cum, xy([n.lat, n.lon]), MEMBER_SNAP_M); if (q.d <= MEMBER_SNAP_M) cand.push({ n, pos: q.pos }); });
      }
      if (cand.length < 3) {
        cand = [];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        L.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
        cityStops.forEach((n, i) => {
          const P = cityStopsXY[i];
          if (P[0] < minX - 40 || P[0] > maxX + 40 || P[1] < minY - 40 || P[1] > maxY + 40) return;
          const q = locate(L, cum, P, AREA_SNAP_M);
          if (q.d <= AREA_SNAP_M) cand.push({ n, pos: q.pos });
        });
      }
      cand.sort((x, y) => x.pos - y.pos);
      // столбик + площадка одной остановки (и остановки по обе стороны улицы) — одна остановка
      const seq = [];
      for (const c of cand) {
        const last = seq[seq.length - 1];
        const same = last && nameOf(last.n) && nameOf(last.n) === nameOf(c.n);
        if (last && (c.pos - last.pos < MERGE_M || (same && c.pos - last.pos < 250))) {
          const hasName = (x) => !!((x.n.tags || {}).name);
          if (!hasName(last) && hasName(c)) seq[seq.length - 1] = c;
          continue;
        }
        seq.push(c);
      }
      if (seq.length < 2) continue;
      const s = seq.map((c) => stopId(c.n));
      const key = ref + '|' + s.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const route = { r: ref, s, p: seq.map((c) => Math.round(c.pos)), g: encodePolyline(line) };
      if (dir.to) route.t = dir.to;
      const k = kindOf(t); if (k) route.k = k;
      // старый маршрут без разметки направлений — линия общая, едем в обе стороны
      if (dir.both) route.b = 1;
      routes.push(route);
    }
  }
  // Во многих городах маршруты в OSM ещё не нарисованы, а остановки есть. Тогда отдаём
  // все остановки: приложение подскажет ближайшую и откроет поездку в 2ГИС или Яндексе.
  if (routes.length < 30) cityStops.forEach((n) => { if (n.tags.highway === 'bus_stop' || n.tags.public_transport === 'platform') stopId(n); });
  return { city, updated: new Date().toISOString().slice(0, 10), v: 2,
           source: 'OpenStreetMap contributors, ODbL', stops, routes };
}

async function fetchCity(city, log = console.log) {
  const body = 'data=' + encodeURIComponent(overpassQuery(city));
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of OVERPASS_MIRRORS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 330000);
      try {
        const res = await fetch(url, { method: 'POST', body, signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                     'User-Agent': 'ICity/1.0 (+https://github.com/aiguzhin/inclusivecity-app)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const osm = await res.json();
        // перегруженный Overpass отвечает 200 с пустым списком и remark — это сбой
        if (osm.remark && /error|timed out/i.test(osm.remark)) throw new Error(osm.remark.slice(0, 120));
        return buildCity(city, osm);
      } catch (e) {
        lastErr = e; log(`  ${city}: ${url} — ${e.message}`);
      } finally { clearTimeout(timer); }
    }
    await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
  }
  throw lastErr || new Error('overpass unavailable');
}

if (typeof module !== 'undefined') module.exports = { BUS_CITIES, buildCity, fetchCity, overpassQuery };

// node tools/busbuild.js [город ...]
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs'), path = require('path');
  const outDir = path.join(__dirname, '..', 'bus-data');
  fs.mkdirSync(outDir, { recursive: true });
  const list = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BUS_CITIES);
  (async () => {
    let failed = 0;
    for (const city of list) {
      try {
        const data = await fetchCity(city);
        const file = path.join(outDir, `${city}.json`);
        // хуже прежнего не сохраняем: Overpass иногда отдаёт урезанные данные
        let old = null;
        try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* файла ещё нет */ }
        if (old && old.routes && data.routes.length < old.routes.length * 0.7) {
          console.log(`${city}: ${data.routes.length} routes < ${old.routes.length} before — keeping old file`);
        } else {
          fs.writeFileSync(file, JSON.stringify(data));
          console.log(`${city}: ${data.routes.length} routes, ${data.stops.length} stops`);
        }
      } catch (e) { failed++; console.log(`${city}: FAILED ${e.message}`); }
      await new Promise((r) => setTimeout(r, 10000));
    }
    if (failed === list.length) process.exit(1);
  })();
}
