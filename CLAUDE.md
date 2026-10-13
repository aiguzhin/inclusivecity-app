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
- Такси своего города: в `buildTaxiTrip` блок `cityTaxiHtml(город)` — только службы города, откуда едем:
  `YA_PHONE` (Яндекс Go по телефону), `public/taxi-osm.json` (службы такси из OSM, `tools/osm_taxi.py` по workflow `taxi.yml`)
  и `INVATAXI` (номера инватакси: 2ГИС и источники 2024–2026; `old:1` — только старый справочник Saby, помечается).
  С 20.09.2026 право на инватакси — по единому перечню 18 показаний (приказ Минздрава №102), заявка — акимат или Портал соцуслуг.
- Заставка `#icIntro` (сразу после `<body>` в `index.html`): холст 2D, ~3 с — сеть 22 городов → полёт к своему городу (`ic_city`) → знак ICity;
  касание/клавиша — пропустить, `ic_motion=off` или reduced-motion — короткий показ; сама снижает разрешение, если кадры опаздывают.
- Сохраняется между входами (localStorage `ic_*`): язык, город, тема, шрифт, контраст, профиль, способ, подложка, вид,
  положение карты (`ic_mapPos`, только для того же города) и включённые слои (`ic_layers`).
- Мои места (`PLACES`, `ic_places`): дом, работа, места и маршруты под полем «Куда»; последние «Откуда/Куда» — `ic_f_start/destination`.
  Дом/работа: окно `#psModal` (`openPlaceSet`, адрес с подсказками или ⌖) → значки на карте (`drawHomePins`, домик и портфель); карточка в шторке — `showHomePlace` (просто показать), нажатие на значок — карточка места с «Маршрут сюда».
- Погода на маршруте: `tripWeather`/`effSlope` — в гололёд допустимый уклон ×0.6, прогноз Open-Meteo по часам на время пути.
- Навигация `navStart` (объект `NAV`): watchPosition, голос `navSay` (говорит всегда), вибрация, барьеры впереди, перестроение после 3 точек >40 м, Wake Lock.
- Офлайн: «Скачать город» (`offlineDownload`) — слои в Cache API `ic-offline`, тайлы z10–13 в `ic-tiles`; оба кэша не стираются при смене `ic-vN`.
- Рейтинг районов `openRating`: place=suburb/quarter из OSM, удобства/барьеры/жалобы → 0–100, теплокарта 600 м, кэш 7 дней.
- `social.js`: `/api/reviews` (отзывы с галочками и фото), `/api/help` (просьбы волонтёрам, точное место — после отклика), статусы жалоб
  `/api/reports/:id/status`; в админке — «В работе»/«Исправлено». Данные в `data/reviews.json`, `data/help.json` + копия в Cloudflare KV
  (без CF_* переменных стираются при деплое; `/api/health` показывает `storage`).
- Стиль «Мягкий минимализм» — по умолчанию (`html[data-ui="soft"]`, `ic_ui`, Настройки → Стиль оформления, «Классический» — прежний вид):
  в плашке приветствие `renderHello`, карточки Дом/Работа `renderPeekPlaces`, 4 плитки и тёмное меню-«таблетка» (Карта, Мои места, Серік, Профиль).
- Шторка-плашка: по умолчанию свёрнута (`.sheet-peek.mini`: поиск + меню), свайп вверх/кнопка «⌃» раскрывают приветствие, Дом/Работа и плитки (`peekExpand`, `ic_peekFull`).
- Кнопка «три линии» на карте (`#mapMenuBtn`, `toggleMapMenu`): внутри слои (`#layerbar`), погода (`#wx`) и подпись снимка (`#imgInfo`) — перенесены туда при запуске (`initMapMenu`); значок — число включённых слоёв.
- Кнопки внизу: Я здесь, Туалет (`nearestToilet`), Барьер, SOS, Ещё; «Поделиться поездкой» (`shareTrip`); ярлыки PWA `/map?do=home|toilet|help|sos`.
- Профиль передвижения — в настройках (`#secProfile`) и на `/account` (`user_metadata.mobility`), в «Куда едем?» — `.prof-chip`.
- Спутник — слой `SatLayer`: перед плиткой спрашивает tilemap Esri (блоками 8×8), где снимка нет — растягивает ближайший более крупный уровень, поэтому заглушек «Map data not yet available» нет (maxNativeZoom 19).
  Подпись «Снимок: дата» убрана. Год снимков — Настройки → «Год спутниковых снимков» (`setSatYear`, `ic_satYear`): выпуск Wayback до конца года, выпуск каждой плитки — из tilemap `select`.
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
- Изменения загружаются на GitHub: из облачной сессии — git push в main (репозиторий подключён),
  иначе через веб-интерфейс (Upload files), сразу после проверки; после деплоя — проверить сайт и дать ссылку.
- Цены такси — оценка по официальному тарифу «Эконом» Яндекс Go; таблица
  `TAXI_TARIFFS` в `index.html` снята с taxi.yandex.kz 05.10.2026.
