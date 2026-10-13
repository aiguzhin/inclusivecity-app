// Web Push без зависимостей: VAPID (ES256) + шифрование aes128gcm (RFC 8291/8188).
// Ключи VAPID — из VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY или создаются один раз и хранятся в Cloudflare KV,
// чтобы подписки не слетали при передеплое. Подписки тоже лежат в data/push.json + KV.
// Подписка «следит» за своими жалобами (reports) и просьбой о помощи (help): при смене статуса приходит уведомление,
// даже если приложение закрыто.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let H = null, FILE = null, timer = null;
let VAPID = null;                      // { pub: Buffer(65), key: KeyObject }
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
// Только настоящие push-сервисы браузеров — сервер не будет ходить по чужим адресам
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.mozaws\.net$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function write(list) {
  fs.writeFileSync(FILE, JSON.stringify(list), 'utf8');
  clearTimeout(timer);
  timer = setTimeout(() => H.kvPut('push', fs.readFileSync(FILE), 'application/json').catch((e) => console.warn(e.message)), 1000);
}

function keyFromJwk(j) {
  return { pub: Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]), key: crypto.createPrivateKey({ key: j, format: 'jwk' }) };
}
async function init(helpers) {
  H = helpers; FILE = path.join(H.DATA_DIR, 'push.json');
  try { const buf = await H.kvGet('push'); if (buf) fs.writeFileSync(FILE, buf); } catch (e) { console.warn('push: restore', e.message); }
  const ePub = process.env.VAPID_PUBLIC_KEY, ePriv = process.env.VAPID_PRIVATE_KEY;
  if (ePub && ePriv) {
    const p = unb64u(ePub);
    VAPID = keyFromJwk({ kty: 'EC', crv: 'P-256', x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)), d: ePriv });
    return;
  }
  let jwk = null;
  try { const buf = await H.kvGet('vapid'); if (buf) jwk = JSON.parse(buf); } catch (e) { console.warn('push: vapid', e.message); }
  const local = path.join(H.DATA_DIR, 'vapid.json');
  if (!jwk) { try { jwk = JSON.parse(fs.readFileSync(local, 'utf8')); } catch (e) {} }
  if (!jwk) {
    jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    H.kvPut('vapid', JSON.stringify(jwk), 'application/json').catch((e) => console.warn(e.message));
  }
  try { fs.writeFileSync(local, JSON.stringify(jwk)); } catch (e) {}
  VAPID = keyFromJwk(jwk);
}

function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:inclusivecityimpact@gmail.com' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: VAPID.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${b64u(VAPID.pub)}`;
}
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
// Шифрование одного сообщения для подписки (aes128gcm, одна запись)
function encrypt(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPub);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const salt = crypto.randomBytes(16), prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
async function send(sub, data) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body: encrypt(sub, JSON.stringify(data)),
  });
  return res.status;
}

// Уведомить всех, кто следит за жалобой (kind='report') или просьбой (kind='help')
async function notify(kind, id, data) {
  if (!VAPID) return 0;
  const list = read(), field = kind === 'help' ? 'help' : 'reports';
  const targets = list.filter((s) => (s[field] || []).includes(id));
  let sent = 0, dead = new Set();
  await Promise.all(targets.map(async (s) => {
    try {
      const st = await send(s, typeof data === 'function' ? data(s.lang || 'ru') : data);
      if (st === 404 || st === 410) dead.add(s.endpoint); else if (st < 300) sent++;
      else console.warn('push: HTTP', st);
    } catch (e) { console.warn('push:', e.message); }
  }));
  if (dead.size) write(read().filter((s) => !dead.has(s.endpoint)));
  return sent;
}

function validSub(s) {
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((r) => r.test(u.hostname))) return false;
    return unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length >= 16;
  } catch (e) { return false; }
}
const ids = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).slice(0, 64)).filter((x) => /^[\w-]+$/.test(x)).slice(0, 50);

async function handle(req, res, pathname) {
  if (pathname === '/api/push/key' && req.method === 'GET') {
    if (!VAPID) return H.sendJson(res, 503, { error: 'push off' });
    return H.sendJson(res, 200, { key: b64u(VAPID.pub) });
  }
  if ((pathname === '/api/push/subscribe' || pathname === '/api/push/unsubscribe') && req.method === 'POST') {
    let b; try { b = JSON.parse((await H.readBody(req, 16 * 1024)).toString('utf8') || '{}'); } catch (e) { return H.sendJson(res, 400, { error: 'bad request' }); }
    const sub = b.sub || {};
    let list = read().filter((s) => s.endpoint !== sub.endpoint);
    if (pathname.endsWith('unsubscribe')) { write(list); return H.sendJson(res, 200, { ok: true }); }
    if (!validSub(sub)) return H.sendJson(res, 400, { error: 'bad subscription' });
    list.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, reports: ids(b.reports), help: ids(b.help), lang: String(b.lang || 'ru').slice(0, 2), at: new Date().toISOString() });
    write(list.slice(0, 20000));
    return H.sendJson(res, 200, { ok: true });
  }
  return null;
}
module.exports = { init, handle, notify, ready: () => !!VAPID, _encrypt: encrypt };
