// Самолечение https на своём сервере (ps.kz). Раз в 5 минут ICity проверяет себя через общий Caddy.
// Если https://inclusivecity.uk дважды подряд не отвечает (настройку ICity в общем Caddy убрали — так было 14.11.2026),
// запускается tools/vps/caddy-fix.sh: он кладёт СВОЙ файл /opt/edge/sites/inclusivecity.caddy (или старую схему),
// проверяет общую настройку и при ошибке возвращает как было. Чужие сайты не трогает. Не чаще раза в 30 минут.
// Работает только на сервере с Cosplaygram (/opt/cosplaygram) и от root; на Render и локально ничего не делает.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'tools', 'vps', 'caddy-fix.sh');
const LOG = path.join(__dirname, 'data', 'selfheal.log');
const st = { enabled: false, fails: 0, lastOkAt: 0, lastFixAt: 0, lastFix: null, running: false };

function probe() {
  return new Promise((ok) => {
    const req = https.request({ host: '127.0.0.1', port: 443, servername: 'inclusivecity.uk', path: '/api/health?probe=1', method: 'GET',
      headers: { Host: 'inclusivecity.uk', 'User-Agent': 'icity-selfheal' }, timeout: 15000, rejectUnauthorized: false },
    (res) => { res.resume(); ok(res.statusCode < 500); });
    req.on('error', () => ok(false));
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.end();
  });
}
function fix(reason) {
  if (st.running) return;
  st.running = true; st.lastFixAt = Date.now();
  execFile('bash', [SCRIPT], { timeout: 240e3, maxBuffer: 1e6 }, (err, out, errOut) => {
    st.running = false;
    const text = String(out || '') + String(errOut || '');
    st.lastFix = { at: new Date().toISOString(), reason, code: err ? (err.code ?? 'err') : 0, tail: text.trim().split('\n').slice(-2).join(' | ').slice(0, 300) };
    try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, text + '\n'); } catch (e) {}
    console.log('[selfheal] caddy-fix:', st.lastFix.code, st.lastFix.tail);
  });
}
async function tick() {
  if (await probe()) { st.fails = 0; st.lastOkAt = Date.now(); return; }
  st.fails++;
  console.warn('[selfheal] https://inclusivecity.uk не отвечает, подряд:', st.fails);
  if (st.fails >= 2 && Date.now() - st.lastFixAt > 30 * 60e3) fix('https не отвечает ' + st.fails + ' раза подряд');
}
function start() {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform !== 'linux' || !isRoot || !fs.existsSync('/opt/cosplaygram/docker-compose.yml') || !fs.existsSync(SCRIPT)) return;
  st.enabled = true;
  setTimeout(() => { tick(); setInterval(tick, 5 * 60e3).unref(); }, 90e3).unref();
}
function status() { return { enabled: st.enabled, fails: st.fails, lastOkAt: st.lastOkAt ? new Date(st.lastOkAt).toISOString() : null, lastFix: st.lastFix }; }
module.exports = { start, status };
