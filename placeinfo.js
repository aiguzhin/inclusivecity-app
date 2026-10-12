'use strict';
/*
 * Фото и отзывы о заведениях внутри карточки места — из Google Places API (официально, без парсинга).
 * Ключ — переменная окружения GOOGLE_PLACES_KEY (Render → Environment). Без ключа сайт показывает только
 * свободные фото из Wikimedia Commons (по тегам OpenStreetMap), а этот модуль отвечает {enabled:false}.
 * Ключ никогда не уходит в браузер: фото отдаются через /api/place-photo (редирект на картинку Google).
 */

const KEY = () => process.env.GOOGLE_PLACES_KEY || '';
const API = 'https://places.googleapis.com/v1';
const TTL = 7 * 864e5;              // одно место спрашиваем у Google не чаще раза в неделю
const LIMIT_PER_HOUR = 150;         // запросов карточек с одного IP в час

const cache = new Map();            // ключ места → {at, data}
const photoCache = new Map();       // ref фото → {at, uri}
const hits = new Map();

function allowed(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= LIMIT_PER_HOUR) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}
function trim(map, max) { if (map.size > max) { const k = map.keys().next().value; map.delete(k); } }
function distM(a, b, c, d) {
  const R = 6371e3, r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R;
}

async function lookup(name, lat, lon, lang) {
  const r = await fetch(API + '/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY(),
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.photos,places.reviews',
    },
    body: JSON.stringify({
      textQuery: name, languageCode: lang, maxResultCount: 3,
      locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 250 } },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  // берём ближайшее совпадение не дальше 350 м — иначе это другое заведение с тем же названием
  const best = (j.places || [])
    .map((p) => ({ p, d: p.location ? distM(lat, lon, p.location.latitude, p.location.longitude) : 1e9 }))
    .filter((x) => x.d <= 350).sort((a, b) => a.d - b.d)[0];
  if (!best) return null;
  const p = best.p;
  return {
    name: p.displayName && p.displayName.text,
    rating: p.rating || null,
    count: p.userRatingCount || 0,
    url: p.googleMapsUri || '',
    photos: (p.photos || []).slice(0, 8).map((ph) => ({
      ref: ph.name,
      w: ph.widthPx, h: ph.heightPx,
      author: ((ph.authorAttributions || [])[0] || {}).displayName || '',
      authorUrl: ((ph.authorAttributions || [])[0] || {}).uri || '',
    })),
    reviews: (p.reviews || []).slice(0, 5).map((rv) => ({
      author: (rv.authorAttribution || {}).displayName || '',
      authorUrl: (rv.authorAttribution || {}).uri || '',
      rating: rv.rating || null,
      when: rv.relativePublishTimeDescription || '',
      text: ((rv.text || rv.originalText || {}).text || '').slice(0, 900),
    })),
  };
}

async function handleInfo(req, res, url, sendJson) {
  if (!KEY()) return sendJson(res, 200, { enabled: false });
  const name = String(url.searchParams.get('name') || '').trim().slice(0, 120);
  const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
  const lang = ['ru', 'kk', 'en'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'ru';
  if (!name || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(res, 400, { error: 'bad_params' });
  const key = [name.toLowerCase(), lat.toFixed(4), lon.toFixed(4), lang].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return sendJson(res, 200, { enabled: true, place: hit.data });
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowed(ip)) return sendJson(res, 429, { error: 'rate_limited' });
  try {
    const data = await lookup(name, lat, lon, lang);
    cache.set(key, { at: Date.now(), data }); trim(cache, 3000);
    return sendJson(res, 200, { enabled: true, place: data });
  } catch (e) {
    console.warn('placeinfo:', e.message);
    return sendJson(res, 502, { error: 'upstream' });
  }
}

async function handlePhoto(req, res, url, sendJson) {
  if (!KEY()) return sendJson(res, 404, { error: 'not_configured' });
  const ref = String(url.searchParams.get('ref') || '');
  const w = Math.min(1200, Math.max(120, parseInt(url.searchParams.get('w'), 10) || 600));
  if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(ref)) return sendJson(res, 400, { error: 'bad_ref' });
  const ck = ref + '|' + w;
  let hit = photoCache.get(ck);
  if (!hit || Date.now() - hit.at > 864e5) {
    try {
      const r = await fetch(`${API}/${ref}/media?maxWidthPx=${w}&skipHttpRedirect=true`, {
        headers: { 'X-Goog-Api-Key': KEY() }, signal: AbortSignal.timeout(12000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.photoUri) return sendJson(res, 404, { error: 'no_photo' });
      hit = { at: Date.now(), uri: j.photoUri }; photoCache.set(ck, hit); trim(photoCache, 5000);
    } catch (e) { return sendJson(res, 502, { error: 'upstream' }); }
  }
  res.writeHead(302, { Location: hit.uri, 'Cache-Control': 'public, max-age=3600' });
  res.end();
}

module.exports = { handleInfo, handlePhoto };
