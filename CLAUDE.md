# ICity (inclusivecity-app)

Карта доступности для городов Казахстана: пешие маршруты с проверкой барьеров,
общественный транспорт, такси, жалобы на барьеры.

- Прод: https://inclusivecity.uk/ (домен на Cloudflare Registrar, DNS там же: CNAME `@` и `www` → `inclusivecity.onrender.com`, режим «DNS only»).
  Хостинг — Render, бесплатный план, Blueprint из `render.yaml`, деплой автоматически из `main`;
  адрес https://inclusivecity.onrender.com/ тоже работает.
  Railway (inclusivecity-production.up.railway.app) остановлен: закончился пробный период.
- `.github/workflows/keepalive.yml` раз в 10 минут дёргает `/api/health`: не даёт Render заснуть
  и присылает письмо, если сайт не отвечает.
- Репозиторий: https://github.com/aiguzhin/inclusivecity-app
- Отображаемое название — «ICity»; домен и имя репозитория остаются `inclusivecity`.

## Устройство

- `server.js` — Node 18 без npm-зависимостей: статика из `public/`, API жалоб,
  `/bus-<город>.json` (маршруты транспорта из OpenStreetMap, кэш в `data/bus/`,
  обновление раз в неделю), `/api/taxi-tariffs`, `/api/taxi-price`
  (живая цена Яндекс Go — только при `YANDEX_TAXI_CLID` и `YANDEX_TAXI_APIKEY`).
- `public/index.html` — всё приложение (Leaflet, тексты на ru/kk/en в `I18N`).
- `public/sw.js` — офлайн-кэш; при каждом изменении фронтенда поднимать `CACHE` (`ic-vN`).
- `data/` на бесплатном Render не сохраняется между деплоями (нет диска) — кэши пересобираются,
  жалобы и фото пропадают; для постоянного хранения нужен платный план с диском (см. `render.yaml`).

## Как работать

- На этом Mac нет Node.js и git. Проверка синтаксиса сервера:
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -e 'checkSyntax("server.js")'`.
- Фронтенд локально: `ruby -run -e httpd public -p 8765` (API там нет).
- Изменения загружаются на GitHub через веб-интерфейс (страница Upload files) сразу
  после проверки; после деплоя — проверить сайт и дать ссылку.
- Цены такси — оценка по официальному тарифу «Эконом» Яндекс Go; таблица
  `TAXI_TARIFFS` в `index.html` снята с taxi.yandex.kz 05.10.2026.
