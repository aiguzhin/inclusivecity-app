/* InclusiveCity service worker — офлайн-оболочка приложения.
 *
 * Важное правило: перехватываем только СВОИ ресурсы и карту.
 * Запросы к сторонним API (Overpass, Nominatim, OSRM, opentopodata)
 * не трогаем вообще — иначе при сбое сети приложение получит в ответ
 * HTML оболочки вместо честной ошибки и маршрут «сломается» молча.
 */
const CACHE = "ic-v57";
// Тайлы и скачанный город живут в своих кэшах — не стираются при обновлении сайта
const TILES = "ic-tiles", OFFLINE = "ic-offline", KEEP = [TILES, OFFLINE], TILE_MAX = 4000;
const SHELL = [
  "/",
  "/landing.html",
  "/map",
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/manifest.json",
  "/icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js"
];
const CDN_HOSTS = ["unpkg.com"];
const TILE_HOSTS = ["tile.openstreetmap.org", "a.tile.openstreetmap.org", "b.tile.openstreetmap.org", "c.tile.openstreetmap.org",
  "server.arcgisonline.com", "a.tile.opentopomap.org", "b.tile.opentopomap.org", "c.tile.opentopomap.org"];

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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

let tilePuts = 0;
function putTile(req, res) {
  if (res && (res.ok || res.type === "opaque")) {
    const copy = res.clone();
    caches.open(TILES).then(c => c.put(req, copy).then(() => {
      // раз в 200 новых тайлов подрезаем кэш до TILE_MAX — самые старые уходят первыми
      if (++tilePuts % 200 === 0) c.keys().then(ks => { const extra = ks.length - TILE_MAX; for (let i = 0; i < extra; i++) c.delete(ks[i]); });
    })).catch(() => {});
  }
  return res;
}
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

  // 2. Наш API, маршруты автобусов (обновляются раз в неделю) и ключи входа: сеть первым,
  //    кэш — только как запасной вариант при офлайне
  if (sameOrigin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/bus-") || url.pathname.startsWith("/places/") || url.pathname === "/taxi-osm.json" || url.pathname === "/auth-config.js")) {
    e.respondWith(
      fetch(req).then(res => putInCache(req, res))
        .catch(() => caches.match(req))
    );
    return;
  }

  // 3. Тайлы карты: кэш первым — карта работает в уже просмотренных районах
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => putTile(req, res)).catch(() => hit))
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

// Push с сервера: статус жалобы изменился, волонтёр откликнулся — приходит, даже когда приложение закрыто
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "ICity", {
    body: d.body || "", icon: "/icon.svg", badge: "/icon.svg", tag: d.tag || "icity", renotify: true,
    vibrate: [200, 100, 200], data: { url: d.url || "/map" }
  }));
});

// Нажали на уведомление — открываем нужный раздел приложения
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/map";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const w = list.find(c => new URL(c.url).pathname.startsWith("/map"));
    if (w) { if (target !== "/map" && "navigate" in w) return w.navigate(target).then(c => c && c.focus()); return w.focus(); }
    return self.clients.openWindow(target);
  }));
});
