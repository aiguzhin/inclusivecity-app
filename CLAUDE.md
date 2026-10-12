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
- `public/landing.html` — главная `/`: 3D-лендинг (three.js r128 с cdnjs), полёт камеры по скроллу.
- `public/index.html` — всё приложение (Leaflet, тексты на ru/kk/en в `I18N`), открывается на `/map`
  (и по старому адресу `/index.html`); PWA стартует с `/map`.
- `public/login.html` — `/login` и `/account`: вход и регистрация через Supabase Auth
  (supabase-js 2.45.4 UMD с jsDelivr, PKCE). Регистрация по телефону с кодом из SMS или по почте, вход по телефону/почте
  с паролем, восстановление пароля по SMS или письму, Google; Apple и eGov — кнопки «скоро». Номера — только +7 (10 цифр).
  Ключи отдаёт сервер в `/auth-config.js` из переменных окружения `SUPABASE_URL` и `SUPABASE_ANON_KEY`
  (без них страница показывает «Вход скоро заработает»). Кнопка «Войти/Профиль» в приложении и на лендинге
  смотрит сессию в localStorage (`sb-…-auth-token`).
- `assistant.js` — `/api/assistant`: ИИ-помощник «Серік» (гид по доступному городу + бережная поддержка),
  прокси к Anthropic API; ключ `ANTHROPIC_API_KEY` в переменных Render (без него чат пишет «не подключён»),
  модель — `ASSISTANT_MODEL` (по умолчанию `claude-haiku-5-5`), лимит 40 сообщений в час с IP.
- `placeinfo.js` — `/api/place-info` и `/api/place-photo`: фото, рейтинг и отзывы заведений в карточке места
  (Google Places API (New), ключ `GOOGLE_PLACES_KEY`, кэш на неделю); без ключа — фото Wikimedia Commons по тегам OSM.
  Ссылку на 2ГИС в карточке места убрали. Телефоны приводятся к виду `+7 XXX XXX XX XX` (`kzPhone`).
- Контакты заведений: `tools/overture_places.py` (DuckDB, Overture Maps places) по workflow `places.yml` пишет
  `public/places/<город>.json`; `placeEnrichContacts` в `index.html` подставляет телефон/сайт/Instagram, если их нет в OSM.
- Профиль передвижения — в настройках (`#secProfile`) и на `/account` (`user_metadata.mobility`), в «Куда едем?» — `.prof-chip`.
- Глобус (`openGlobe` в `index.html`): при зуме ≤ 3 вместо карты — Земля на three.js: реальные день/ночь по времени,
  облака, Млечный Путь, Солнце и Луна в настоящих направлениях (`globeAstro`), кнопки ☀ и ☾.
- 3D — только жестом (два пальца вверх, правая кнопка мыши); обычная карта прячется лишь когда 3D дорисовалась (`is3d-ready`).
- Голосовые подсказки для незрячих (`S.hints` в `index.html`): первое касание называет элемент, второе нажимает.
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
