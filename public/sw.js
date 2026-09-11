/* InclusiveCity service worker — офлайн-оболочка приложения.
 *
 * Важное правило: перехватываем только СВОИ ресурсы и карту.
 * Запросы к сторонним API (Overpass, Nominatim, OSRM, opentopodata)
 * не трогаем вообще — иначе при сбое сети приложение получит в ответ
 * HTML оболочки вместо честной ошибки и маршрут «сломается» молча.
 */
const CACHE = "ic-v3";
const SHELL = [
  "/",
  "/index.html",
  "/dashboard.html",
  "/manifest.json",
  "/icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];
const CDN_HOSTS = ["unpkg.com"];
const TILE_HOSTS = ["tile.openstreetmap.org", "a.tile.openstreetmap.org", "b.tile.openstreetmap.org", "c.tile.openstreetmap.org"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  const sameOrigin = url.origin === self.location.origin;

  // 1. Переходы по страницам: сеть, при офлайне — сохранённая оболочка
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => putInCache(req, res))
        .catch(() => caches.match(req).then(hit => hit || caches.match("/index.html")))
    );
    return;
  }

  // 2. Наш API: сеть первым, кэш — только как запасной вариант при офлайне
  if (sameOrigin && url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(req).then(res => putInCache(req, res))
        .catch(() => caches.match(req))
    );
    return;
  }

  // 3. Тайлы карты: кэш первым — карта работает в уже просмотренных районах
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => putInCache(req, res)).catch(() => hit))
    );
    return;
  }

  // 4. Своя статика и Leaflet с CDN: кэш первым
  if (sameOrigin || CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => putInCache(req, res)))
    );
    return;
  }

  // 5. Всё остальное (сторонние API) — пропускаем как есть, без подмен
});
