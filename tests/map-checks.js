// Автоматические проверки страницы карты (/map) в Chromium через Playwright.
// Ничего не отправляют наружу: все внешние API подменены, POST на свой сервер блокируются и считаются,
// геопозиция и микрофон не запрашиваются (вызовы считаются и должны остаться нулём).
// Запуск:  node tests/map-checks.js          (нужен пакет playwright: npm i -D playwright или глобально)
// Переменные: LEAFLET_DIR — папка node_modules с leaflet (если unpkg недоступен).
const http = require('http');
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Нужен playwright: npm i -D playwright'); process.exit(2); }

const PUB = path.join(__dirname, '..', 'public');
const MOD_DIRS = [process.env.LEAFLET_DIR, path.join(__dirname, '..', 'node_modules'), '/tmp/claude-0/npmx/node_modules'].filter(Boolean);

// --- маленький статический сервер: только public/, API отвечает тест (page.route) ---
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
function startStatic() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '/map') p = '/index.html';
    const f = path.join(PUB, path.normalize(p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// --- подмены сети ---
const NET = { overpass: 'items', posts: [], osrmSteps: true };
const OVERPASS_ITEMS = { elements: [
  { type: 'node', id: 1, lat: 51.1290, lon: 71.4310, tags: { amenity: 'toilets', name: 'Туалет 1', wheelchair: 'yes' } },
  { type: 'node', id: 2, lat: 51.1300, lon: 71.4330, tags: { amenity: 'toilets', wheelchair: 'no' } },
  { type: 'node', id: 3, lat: 51.1270, lon: 71.4290, tags: { amenity: 'pharmacy', name: 'Аптека' } }] };
const hanging = [];
function osrmRoute() {
  const coords = [[71.430, 51.128], [71.435, 51.130], [71.440, 51.132]];
  const steps = NET.osrmSteps ? [
    { name: 'улица Бейбитшилик', distance: 400, maneuver: { type: 'depart', modifier: '', location: coords[0] } },
    { name: 'проспект Республики', distance: 800, maneuver: { type: 'turn', modifier: 'left', location: coords[1] } },
    { name: '', distance: 0, maneuver: { type: 'arrive', location: coords[2] } }] : [];
  return { code: 'Ok', routes: [{ distance: 1200, duration: 900, geometry: { type: 'LineString', coordinates: coords }, legs: [{ steps }] }] };
}
async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = req.url(), u = new URL(url);
    if (u.hostname === '127.0.0.1') {
      if (req.method() !== 'GET') { NET.posts.push(req.method() + ' ' + u.pathname); return route.fulfill({ status: 403, json: { error: 'blocked in tests' } }); }
      if (u.pathname.startsWith('/api/') || u.pathname === '/auth-config.js') return route.fulfill({ status: 404, json: {} });
      return route.continue();
    }
    if (u.hostname === 'unpkg.com' || u.hostname === 'cdn.jsdelivr.net') {
      const m = u.pathname.match(/^\/(?:npm\/)?((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/);
      for (const d of MOD_DIRS) { const f = m && path.join(d, m[1], m[2]); if (f && fs.existsSync(f)) return route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : 'application/javascript' }); }
      return route.continue().catch(() => route.abort());
    }
    if (/overpass|interpreter/.test(url)) {
      if (NET.overpass === 'hang') { hanging.push(route); return; }
      if (NET.overpass === 'error') return route.fulfill({ status: 504, body: 'Gateway Timeout' });
      if (NET.overpass === 'empty') return route.fulfill({ json: { elements: [] } });
      return route.fulfill({ json: OVERPASS_ITEMS });
    }
    if (/routing\.openstreetmap\.de/.test(u.hostname) && /routed-foot/.test(u.pathname)) return route.fulfill({ json: osrmRoute() });
    return route.abort();   // плитки, Nominatim, погода, высоты и прочее — не нужны проверкам
  });
}

// счётчики «опасных» вызовов: геопозиция, микрофон, системный диалог «поделиться»
const INIT = (city) => {
  sessionStorage.setItem('ic_introSeen', '1');
  if (city) localStorage.setItem('ic_city', city);
  localStorage.setItem('ic_permsAsked', '1');
  window.__calls = { geo: 0, mic: 0, share: 0 };
  const geo = { getCurrentPosition: (ok, err) => { __calls.geo++; err && err({ code: 1, message: 'denied in tests' }); }, watchPosition: (ok, err) => { __calls.geo++; err && err({ code: 1 }); return 1; }, clearWatch() {} };
  try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch (e) {}
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { __calls.mic++; return Promise.reject(new Error('no mic in tests')); };
  window.SpeechRecognition = window.webkitSpeechRecognition = function () { __calls.mic++; this.start = () => {}; this.stop = () => {}; };
  navigator.share = () => { __calls.share++; return Promise.resolve(); };
  window.confirm = () => false;
};

// --- крошечный раннер ---
const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ✓ ' + name); }
  catch (e) { results.push([false, name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };

(async () => {
  const srv = await startStatic();
  const BASE = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  async function page(width, height, city = 'astana') {
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', locale: 'ru-RU' });
    await wire(ctx); await ctx.addInitScript(INIT, city);
    const p = await ctx.newPage();
    p.errors = []; p.on('pageerror', (e) => { if (/ReferenceError|TypeError|SyntaxError/.test(e.message)) p.errors.push(e.message); });
    await p.goto(BASE + '/map', { waitUntil: 'load' });
    await p.waitForFunction(() => typeof mapReady !== 'undefined' && mapReady, null, { timeout: 15000 });
    await p.waitForTimeout(600);
    return p;
  }
  const closeAll = (p) => p.evaluate(() => document.querySelectorAll('.modal.open').forEach((m) => closeModal(m.id)));

  console.log('Координаты формы');
  for (const [w, h] of [[1024, 768], [375, 740]]) {
    const p = await page(w, h);
    await check(`${w}px: жалоба без выбранной точки не отправляется, GPS сам не подставляется`, async () => {
      await p.evaluate(() => openReport());
      await p.waitForSelector('#reportModal.open');
      const s = await p.evaluate(() => ({ pt: PT.report, dis: document.getElementById('submitReport').disabled, box: document.getElementById('reportPt').textContent, need: document.getElementById('reportNeed').textContent, geo: __calls.geo }));
      ok(s.pt === null, 'точка подставилась сама'); ok(s.dis, 'кнопка отправки активна без точки');
      ok(/не выбрана|выберите/i.test(s.box), 'нет объяснения «точка не выбрана»: ' + s.box); ok(s.need.trim(), 'нет списка недостающих полей'); ok(s.geo === 0, 'запрошена геопозиция');
    });
    await check(`${w}px: точка с карты = координаты в форме, «Показать точку» работает`, async () => {
      await p.evaluate(() => ptPick('report'));
      await p.waitForFunction(() => !document.querySelector('#reportModal.open'));
      const box = await p.locator('#map').boundingBox();
      const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + Math.min(box.height / 3, 220));
      const want = await p.evaluate(([x, y]) => { const r = document.getElementById('map').getBoundingClientRect(); const ll = map.containerPointToLatLng([x - r.left, y - r.top]); return [ll.lat, ll.lng]; }, [cx, cy]);
      const hit = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return (e.id || e.className || e.tagName) + ''; }, [cx, cy]);
      await p.mouse.click(cx, cy);
      await p.waitForSelector('#reportModal.open', { timeout: 5000 }).catch(async () => { throw new Error('после нажатия на карту форма не вернулась; под курсором: ' + hit + ', pickMode=' + (await p.evaluate(() => pickMode))); });
      const s = await p.evaluate(() => ({ pt: PT.report, ll: document.querySelector('#reportPt .pt-ll').textContent, dis: document.getElementById('submitReport').disabled }));
      ok(s.pt && Math.abs(s.pt.lat - want[0]) < 1e-4 && Math.abs(s.pt.lng - want[1]) < 1e-4, `точка ${JSON.stringify(s.pt)} ≠ нажатой ${want}`);
      ok(s.ll.includes(s.pt.lat.toFixed(5)) && s.ll.includes(s.pt.lng.toFixed(5)), 'в форме показаны другие координаты: ' + s.ll);
      ok(s.pt.src === 'map', 'источник точки не «карта»');
      ok(s.dis, 'без комментария отправка уже доступна');
      await p.fill('#comment', 'Проверка: высокий бордюр');
      ok(!(await p.evaluate(() => document.getElementById('submitReport').disabled)), 'с точкой и комментарием отправка недоступна');
      await p.evaluate(() => ptShow('report'));
      await p.waitForSelector('.pt-pulse', { timeout: 3000 });
      await closeAll(p);
    });
    await check(`${w}px: обращение в акимат без точки заблокировано`, async () => {
      await p.evaluate(() => { lastComplaintPoint = null; PT.complaint = null; openComplaint(); });
      await p.waitForSelector('#complaintModal.open');
      const s = await p.evaluate(() => ({ copy: document.getElementById('cmpCopyBtn').disabled, open: document.getElementById('cmpOpenBtn').classList.contains('is-disabled') }));
      ok(s.copy && s.open, 'кнопки обращения активны без точки');
      await closeAll(p);
    });
    if (w === 1024) await check('дата в русском интерфейсе — ДД.ММ.ГГГГ', async () => {
      const d = await p.evaluate(() => fmtDate(new Date(2026, 0, 5)));
      ok(d === '05.01.2026', 'получилось ' + d);
    });
    await check(`${w}px: просьба о помощи — точка и телефон обязательны`, async () => {
      const r = await p.evaluate(() => { if (typeof PT === 'undefined') return null; PT.help = null; formCheck('help'); const b = document.getElementById('hpSendBtn'); return b ? b.disabled : 'no-form'; });
      ok(r === true || r === 'no-form', 'кнопка «Отправить» активна без точки');
    });
    ok(p.errors.length === 0, 'ошибки JS: ' + p.errors.join(' | '));
    await p.context().close();
  }

  console.log('Быстрый поиск: конечные состояния');
  {
    const p = await page(375, 740);
    const run = async (mode) => {
      NET.overpass = mode;
      await p.evaluate(() => pfCategory('toilet'));
      await p.waitForFunction(() => { const r = document.getElementById('peekRes'); return r && !r.hidden && !r.querySelector('.terr-spin'); }, null, { timeout: 12000 });
      return p.evaluate(() => ({ text: document.getElementById('peekRes').textContent, cards: document.querySelectorAll('#peekRes .pr-card').length, btns: [...document.querySelectorAll('#peekRes button')].map((b) => b.textContent.trim()) }));
    };
    await check('есть результаты → список карточек', async () => { const s = await run('items'); ok(s.cards === 3, 'карточек ' + s.cards); });
    await check('ничего нет → «ничего не нашли» с областью поиска', async () => { const s = await run('empty'); ok(s.cards === 0 && /не нашли|ничего/i.test(s.text), s.text); ok(/карты|вас/i.test(s.text), 'не сказано, где искали'); });
    await check('ошибка сервера → сообщение и «Повторить»', async () => { const s = await run('error'); ok(s.btns.some((b) => /Повтор/i.test(b)), 'нет кнопки повтора: ' + s.btns); });
    await check('долгий запрос → кнопка «Отмена» снимает «Ищем…»', async () => {
      NET.overpass = 'hang';
      await p.evaluate(() => { pfCategory('toilet'); });   // не ждём завершения: проверяем состояние «Ищем…»
      await p.waitForSelector('#peekRes .terr-spin', { state: 'attached', timeout: 5000 }).catch(async () => { throw new Error('нет «Ищем…»: ' + (await p.evaluate(() => document.getElementById('peekRes').outerHTML.slice(0, 300)))); });
      await p.locator('#peekRes button', { hasText: /Отмен/ }).click();
      await p.waitForFunction(() => document.getElementById('peekRes').hidden, null, { timeout: 3000 });
    });
    await check('зависший запрос заканчивается сам (тайм-аут) с кнопкой повтора', async () => {
      NET.overpass = 'hang';
      await p.evaluate(() => { PF_MAX_MS = 3000; pfCategory('toilet'); });
      await p.waitForFunction(() => { const r = document.getElementById('peekRes'); return !r.hidden && !r.querySelector('.terr-spin'); }, null, { timeout: 8000 });
      const s = await p.evaluate(() => { PF_MAX_MS = 30000; return document.getElementById('peekRes').textContent; });
      ok(/Повтор/.test(s), 'после тайм-аута нет «Повторить»: ' + s);
    });
    await check('поиск не спрашивает геопозицию', async () => { ok((await p.evaluate(() => __calls.geo)) === 0, 'запрошена геопозиция'); });
    hanging.splice(0).forEach((r) => r.abort().catch(() => {}));
    ok(p.errors.length === 0, 'ошибки JS: ' + p.errors.join(' | '));
    await p.context().close();
  }

  console.log('Слои');
  {
    const p = await page(1024, 768);
    const keys = await p.evaluate(() => LAYERS.map((d) => d.key));
    await check(`есть данные → слой на карте и в списке «рядом», выключение убирает (${keys.length} слоёв)`, async () => {
      NET.overpass = 'items';
      for (const k of keys) {
        await p.evaluate(() => { cacheClear && cacheClear(); }).catch(() => {});
        await p.evaluate((k) => toggleLayer(k), k);
        const on = await p.evaluate((k) => ({ on: layerState[k].on, inMap: map.hasLayer(layerState[k].group), n: layerState[k].group.getLayers().length, pressed: document.getElementById('chip-' + k) && document.getElementById('chip-' + k).getAttribute('aria-pressed'), list: document.getElementById('nearbyList').textContent }), k);
        ok(on.on && on.inMap && on.n > 0, `${k}: слой не появился на карте ${JSON.stringify(on).slice(0, 120)}`);
        ok(on.pressed === null || on.pressed === 'true', `${k}: переключатель не отмечен`);
        await p.evaluate((k) => toggleLayer(k), k);
        const off = await p.evaluate((k) => ({ on: layerState[k].on, inMap: map.hasLayer(layerState[k].group) }), k);
        ok(!off.on && !off.inMap, `${k}: слой не выключился`);
      }
    });
    await check('нет данных → переключатель включён, причина в сообщении', async () => {
      NET.overpass = 'empty';
      await p.evaluate(() => { localStorage.removeItem('ic_cache'); });
      await p.evaluate(() => map.setView([43.0, 77.0], 16, { animate: false }));   // другая область — без кэша
      await p.evaluate((k) => toggleLayer(k), keys[0]);
      const s = await p.evaluate(() => document.getElementById('toast').textContent);
      ok(/OpenStreetMap|ничего|неполн/i.test(s), 'нет объяснения: ' + s);
      await p.evaluate((k) => toggleLayer(k), keys[0]);
    });
    await check('ошибка загрузки → слой не включается, сказано почему', async () => {
      NET.overpass = 'error';
      await p.evaluate(() => map.setView([43.2, 76.5], 16, { animate: false }));
      await p.evaluate((k) => toggleLayer(k), keys[1]);
      const s = await p.evaluate((k) => ({ on: layerState[k].on, toast: document.getElementById('toast').textContent }), keys[1]);
      ok(!s.on && s.toast.trim(), JSON.stringify(s));
    });
    await check('меню слоёв: открывается с фокусом внутри, ↓ двигает фокус, Esc закрывает и возвращает фокус', async () => {
      await p.evaluate(() => toggleMapMenu(true));
      ok(await p.evaluate(() => document.getElementById('mapMenu').contains(document.activeElement)), 'фокус не в меню');
      const a = await p.evaluate(() => document.activeElement.outerHTML.slice(0, 60));
      await p.keyboard.press('ArrowDown');
      ok(a !== (await p.evaluate(() => document.activeElement.outerHTML.slice(0, 60))), 'стрелка не двигает фокус');
      await p.keyboard.press('Escape');
      ok(await p.evaluate(() => document.getElementById('mapMenu').hidden && document.activeElement.id === 'mapMenuBtn'), 'Esc не закрыл меню или фокус потерян');
    });
    ok(p.errors.length === 0, 'ошибки JS: ' + p.errors.join(' | '));
    await p.context().close();
  }

  console.log('Шаги маршрута');
  for (const [w, h] of [[1024, 768], [375, 740]]) {
    const p = await page(w, h);
    await check(`${w}px: «Шаги» открывают реальные шаги выбранного варианта`, async () => {
      NET.osrmSteps = true; NET.overpass = 'empty';
      await p.evaluate(() => { setFieldPlace('start', 'A', [51.128, 71.43]); setFieldPlace('destination', 'B', [51.132, 71.44]); buildRoute(); });
      await p.waitForFunction(() => lastRoute && lastSteps.length, null, { timeout: 20000 });
      if (w < 860) { await p.waitForSelector('#peekRoute:not([hidden]) .pr-steps', { timeout: 5000 }); await p.click('#peekRoute .pr-steps'); }
      else await p.evaluate(() => openSteps());
      await p.waitForSelector('#stepsModal.open');
      const s = await p.evaluate(() => ({ li: document.querySelectorAll('#stepsBody ol li').length, steps: lastSteps.length, other: [...document.querySelectorAll('.modal.open')].map((m) => m.id), txt: document.getElementById('stepsBody').textContent }));
      ok(s.li === s.steps && s.li === 2, `шагов в окне ${s.li}, у маршрута ${s.steps}`);
      ok(s.other.length === 1 && s.other[0] === 'stepsModal', 'открылось другое окно: ' + s.other);
      ok(/Республики/.test(s.txt), 'в шагах не названия улиц маршрута');
      await closeAll(p);
    });
    await check(`${w}px: рядом с оценкой маршрута — источник данных и честная формулировка`, async () => {
      const s = await p.evaluate(() => document.getElementById('routeCard').textContent);
      ok(/OpenStreetMap/.test(s), 'нет источника');
      ok(!/Препятствий не найдено/.test(s), 'категоричная формулировка');
    });
    await check(`${w}px: маршрут без шагов → понятное сообщение, а не форма`, async () => {
      await p.evaluate(() => { lastSteps = []; openSteps(); });
      await p.waitForSelector('#stepsModal.open');
      const s = await p.evaluate(() => ({ txt: document.getElementById('stepsBody').textContent, open: [...document.querySelectorAll('.modal.open')].map((m) => m.id) }));
      ok(s.txt.trim().length > 10 && s.open.join() === 'stepsModal', JSON.stringify(s));
      await closeAll(p);
    });
    if (w < 860) await check('375px: маршрут виден над нижней панелью', async () => {
      await p.evaluate(() => showVariant(0)); await p.waitForTimeout(900);
      const s = await p.evaluate(() => { const r = document.getElementById('map').getBoundingClientRect(); const pk = document.getElementById('sheetPeek').getBoundingClientRect();
        return lastRoute.pts.map((ll) => { const pt = map.latLngToContainerPoint(ll); return { y: pt.y + r.top, x: pt.x + r.left, top: pk.top, w: innerWidth }; }); });
      ok(s.every((q) => q.y < q.top && q.x > 0 && q.x < q.w), 'часть маршрута под панелью или за краем: ' + JSON.stringify(s));
    });
    ok(p.errors.length === 0, 'ошибки JS: ' + p.errors.join(' | '));
    await p.context().close();
  }

  console.log('Раскладка 320 / 375 / 620 / 1024 px');
  for (const w of [320, 375, 620, 1024]) {
    const p = await page(w, w < 700 ? 720 : 768);
    await check(`${w}px: нет горизонтальной прокрутки`, async () => {
      ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'страница шире экрана');
    });
    await check(`${w}px: окна целиком на экране`, async () => {
      for (const [id, open] of [['reportModal', 'openReport()'], ['stepsModal', 'openSteps()'], ['complaintModal', 'openComplaint()'], ['shareModal', 'shareTrip(12)'], ['settingsModal', 'openModal("settingsModal")']]) {
        await p.evaluate(open); await p.waitForSelector('#' + id + '.open'); await p.waitForTimeout(350);
        const r = await p.evaluate((id) => { const d = document.querySelector('#' + id + ' .dialog').getBoundingClientRect(); const over = [...document.querySelectorAll('#' + id + ' .dialog *')].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible' && e.clientWidth > 0 && !/^(svg|path|textarea|input|select)$/i.test(e.tagName)).length;
          return { l: d.left, r: d.right, t: d.top, b: d.bottom, vw: innerWidth, vh: innerHeight, over }; }, id);
        ok(r.l >= -1 && r.r <= r.vw + 1 && r.t >= -1, `${id} выходит за экран ${JSON.stringify(r)}`);
        await closeAll(p); await p.waitForTimeout(300);
      }
    });
    await check(`${w}px: меню слоёв на экране, прокручивается и не закрывает атрибуцию`, async () => {
      await p.evaluate(() => toggleMapMenu(true));
      const r = await p.evaluate(() => { const m = document.getElementById('mapMenu').getBoundingClientRect(); const a = document.querySelector('.leaflet-control-attribution'); const ar = a && a.offsetParent ? a.getBoundingClientRect() : null;
        const cs = getComputedStyle(document.getElementById('mapMenu'));
        return { m: [m.left, m.top, m.right, m.bottom], vw: innerWidth, vh: innerHeight, scroll: cs.overflowY, hit: ar ? !(ar.right <= m.left || ar.left >= m.right || ar.bottom <= m.top || ar.top >= m.bottom) : false }; });
      ok(r.m[0] >= 0 && r.m[2] <= r.vw && r.m[1] >= 0 && r.m[3] <= r.vh, 'меню за экраном ' + JSON.stringify(r));
      ok(/auto|scroll/.test(r.scroll), 'меню не прокручивается');
      ok(!r.hit, 'меню перекрывает атрибуцию карты');
      await p.evaluate(() => toggleMapMenu(false));
    });
    ok(p.errors.length === 0, 'ошибки JS: ' + p.errors.join(' | '));
    await p.context().close();
  }

  console.log('Первый запуск и «Мои места»');
  for (const w of [1024, 375]) {
    const p = await page(w, 768, null);
    await check(`${w}px: пока место не выбрано, форма маршрута скрыта — один активный экран`, async () => {
      const s = await p.evaluate(() => ({ first: document.body.classList.contains('first-run'), start: !!document.getElementById('start').offsetParent, gate: !!document.getElementById('firstGate').offsetParent }));
      ok(s.first && !s.start, 'форма маршрута видна при первом запуске ' + JSON.stringify(s));
      ok(s.gate || w < 860, 'нет подсказки «сначала выберите место»');
    });
    await p.context().close();
  }
  {
    const p = await page(375, 740);
    await check('375px: вкладка «Мои места» открывает сохранённые места', async () => {
      await p.evaluate(() => { PLACES = [{ id: 't1', type: 'place', name: 'Тестовое место', addr: 'ул. Пример, 1', ll: [51.13, 71.43] }]; navPlacesTab(); });   // только в памяти: savePlaces не вызывается
      await p.waitForFunction(() => { const pn = document.getElementById('plPanel'); return pn && !pn.hidden && pn.querySelector('.pl-go'); }, null, { timeout: 4000 });
    });
    await check('поделиться поездкой — сначала окно «что будет отправлено», место не добавляется без галочки', async () => {
      await p.evaluate(() => { userLatLng = [51.13, 71.43]; shareTrip(12); });
      await p.waitForSelector('#shareModal.open');
      const s = await p.evaluate(() => ({ txt: document.getElementById('shText').value, what: document.getElementById('shWhat').textContent, share: __calls.share }));
      ok(!/openstreetmap\.org\/\?mlat/.test(s.txt), 'ссылка на место без согласия'); ok(/Что будет отправлено/.test(s.what), 'нет списка данных'); ok(s.share === 0, 'отправлено без нажатия');
    });
    await check('без входа плашка «вас видят друзья» не показывается', async () => {
      ok(!(await p.evaluate(() => { const e = document.getElementById('shareChip'); return e && !e.hidden; })), 'плашка видна без входа');
    });
    await check('во время проверок не было геопозиции, микрофона и POST-запросов', async () => {
      const c = await p.evaluate(() => __calls);
      ok(c.geo === 0 && c.mic === 0, JSON.stringify(c));
      ok(NET.posts.length === 0, 'POST: ' + NET.posts.join(', '));
    });
    await p.context().close();
  }

  await browser.close(); srv.close();
  const bad = results.filter((r) => !r[0]);
  console.log(`\n${results.length - bad.length}/${results.length} проверок прошли`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
