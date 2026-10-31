// Озвучка на своём сервере: Piper (открытый синтезатор речи, работает без интернета и ключей).
// Русский — голос «Дмитрий» (CC0), казахский — ISSAI (CC BY 4.0). Английский остаётся браузеру.
// Программа и голоса скачиваются сами при первом запуске в data/tts (около 140 МБ), готовые фразы кэшируются.
// GET /api/tts?l=ru|kk&t=<текст>  → (скорость меняет клиент: audio.playbackRate)
// →  audio/wav  или 503, если голос ещё не готов
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, 'data', 'tts');
const BIN = path.join(DIR, 'piper', 'piper');
const CACHE = path.join(DIR, 'cache');
const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/';
const VOICES = {
  ru: { file: 'ru_RU-dmitri-medium.onnx', urls: [HF + 'ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx'], tar: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-dmitri-medium.tar.bz2', speaker: null, scale: 0.95 },
  kk: { file: 'kk_KZ-issai-high.onnx', tar: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-kk_KZ-issai-high.tar.bz2', speaker: 0, scale: 1.0 },
};
const MAX_CACHE_FILES = 4000;
let setup = null;           // Promise подготовки
let failed = '';            // текст последней ошибки подготовки
const workers = {};         // постоянные процессы piper по языкам

function run(cmd, args, opts = {}) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('error', bad);
    p.on('close', c => c === 0 ? ok() : bad(new Error(cmd + ' ' + c + ' ' + err.slice(-300))));
  });
}
async function download(url, to) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ICity/1.0 (inclusivecity.uk)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  const tmp = to + '.part';
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(tmp, to);
}
async function prepare() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('только linux x64');
  if (!fs.existsSync(BIN)) {
    const tgz = path.join(DIR, 'piper.tgz');
    await download(PIPER_URL, tgz);
    await run('tar', ['xzf', tgz, '-C', DIR]);
    fs.unlinkSync(tgz);
  }
  for (const [lang, v] of Object.entries(VOICES)) {
    const onnx = path.join(DIR, v.file);
    if (fs.existsSync(onnx) && fs.existsSync(onnx + '.json')) continue;
    try {
      let done = false;
      if (v.urls) {
        try { await download(v.urls[0] + '.json', onnx + '.json'); await download(v.urls[0], onnx); done = true; }
        catch (e) { console.warn('[tts] ' + lang + ' с huggingface не скачался, беру копию с GitHub:', e.message); }
      }
      if (!done) {
        const tb = path.join(DIR, lang + '.tar.bz2');
        await download(v.tar, tb);
        await run('tar', ['xjf', tb, '-C', DIR]);
        const sub = path.join(DIR, path.basename(v.tar, '.tar.bz2'));
        fs.renameSync(path.join(sub, v.file), onnx);
        fs.renameSync(path.join(sub, v.file + '.json'), onnx + '.json');
        fs.rmSync(sub, { recursive: true, force: true }); fs.unlinkSync(tb);
        // В копии с GitHub модель пересохранена с ONNX IR 9, а onnxruntime внутри Piper понимает до 8.
        // Операторы те же, поэтому достаточно поправить номер версии в заголовке файла (поле 1 = 0x08 0x09).
        const fd = fs.openSync(onnx, 'r+'); const h = Buffer.alloc(2); fs.readSync(fd, h, 0, 2, 0);
        if (h[0] === 0x08 && h[1] > 8) fs.writeSync(fd, Buffer.from([0x08]), 0, 1, 1);
        fs.closeSync(fd);
      }
    } catch (e) { console.error('[tts] голос ' + lang + ':', e.message); }
  }
}
function ensure() {
  if (!setup) setup = prepare().then(() => { failed = ''; console.log('[tts] готово'); })
    .catch(e => { failed = e.message; console.error('[tts] подготовка:', e.message); setTimeout(() => { setup = null; }, 30 * 60e3); throw e; });
  return setup;
}
function ready(lang) {
  const v = VOICES[lang];
  return !!v && fs.existsSync(BIN) && fs.existsSync(path.join(DIR, v.file));
}

// Постоянный процесс piper: строки JSON на вход, путь готового файла на выход
function worker(lang) {
  if (workers[lang] && !workers[lang].dead) return workers[lang];
  const v = VOICES[lang];
  const p = spawn(BIN, ['--model', path.join(DIR, v.file), '--length_scale', String(v.scale), '--sentence_silence', '0.2', '--noise_scale', '0.5', '--noise_w', '0.6', '--json-input', '-q'], { cwd: path.dirname(BIN) });
  const w = { p, queue: [], busy: null, buf: '', dead: false };
  p.stdout.on('data', d => {
    w.buf += d; let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      w.buf = w.buf.slice(i + 1);
      const job = w.busy; w.busy = null;
      if (job) { clearTimeout(job.timer); job.ok(); }
      next(w);
    }
  });
  let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-600); });
  const die = () => { if (!w.dead && err) console.error('[tts] piper ' + lang + ':', err.trim().split('\n').slice(-2).join(' | ')); w.dead = true; if (w.busy) { w.busy.bad(new Error('piper exited')); w.busy = null; } w.queue.splice(0).forEach(j => j.bad(new Error('piper exited'))); };
  p.on('close', die); p.on('error', die);
  workers[lang] = w;
  return w;
}
function next(w) {
  clearTimeout(w.idle);
  if (!w.busy && !w.queue.length && !w.dead) { w.idle = setTimeout(() => { try { w.p.stdin.end(); w.p.kill(); } catch (e) {} }, 10 * 60e3); return; }   // простаивает 10 мин — освобождаем память
  if (w.busy || !w.queue.length || w.dead) return;
  const job = w.busy = w.queue.shift();
  job.timer = setTimeout(() => { try { w.p.kill(); } catch (e) {} }, 20e3);
  w.p.stdin.write(JSON.stringify(job.req) + '\n');
}
function synth(lang, text, out) {
  const v = VOICES[lang];
  const w = worker(lang);
  return new Promise((ok, bad) => {
    if (w.queue.length > 30) return bad(new Error('busy'));
    w.queue.push({ req: v.speaker == null ? { text, output_file: out } : { text, output_file: out, speaker_id: v.speaker }, ok, bad });
    next(w);
  });
}

// Текст для голоса: без разметки, ссылок, обратных слэшей и значков
function clean(s) {
  return String(s || '')
    .replace(/\\[nrt]/g, ' ').replace(/\\/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ').replace(/[*_`#>|~^=<{}\[\]]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\s*[\r\n]+\s*[-•—–]?\s*/g, '. ').replace(/(^|\s)[-•]\s+/g, '$1')
    .replace(/\s*→\s*/g, ', ').replace(/\s*\/\s*/g, ' ')
    .replace(/\.\s*\./g, '.').replace(/([,.:;!?])\s*[,.]+/g, '$1').replace(/\s+([,.!?:;])/g, '$1').replace(/\s{2,}/g, ' ').trim()
    .slice(0, 600);
}

async function handle(req, res, url, sendJson, tooMany) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' });
  const lang = url.searchParams.get('l') === 'kk' ? 'kk' : url.searchParams.get('l') === 'ru' ? 'ru' : '';
  const text = clean(url.searchParams.get('t'));
  if (!lang || !text) return sendJson(res, 400, { error: 'lang/text' });
  const key = crypto.createHash('sha1').update(lang + '|' + text).digest('hex');
  const file = path.join(CACHE, key + '.wav');
  if (fs.existsSync(file) && fs.statSync(file).size < 1000) { try { fs.unlinkSync(file); } catch (x) {} }
  if (!fs.existsSync(file)) {
    if (!ready(lang)) { ensure().catch(() => {}); return sendJson(res, 503, { error: 'not ready', detail: failed || 'preparing' }); }
    if (tooMany(req, 'tts', 90, 60e3)) return sendJson(res, 429, { error: 'too many' });
    try { await synth(lang, text, file); } catch (e) { try { fs.unlinkSync(file); } catch (x) {} return sendJson(res, 503, { error: 'synth', detail: e.message }); }
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) { try { fs.unlinkSync(file); } catch (x) {} return sendJson(res, 503, { error: 'synth' }); }
    prune();
  }
  const st = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=2592000, immutable' });
  fs.createReadStream(file).pipe(res);
}
let pruneAt = 0;
function prune() {
  if (Date.now() - pruneAt < 10 * 60e3) return; pruneAt = Date.now();
  try {
    const fl = fs.readdirSync(CACHE).map(f => ({ f, t: fs.statSync(path.join(CACHE, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    fl.slice(0, Math.max(0, fl.length - MAX_CACHE_FILES)).forEach(x => fs.unlinkSync(path.join(CACHE, x.f)));
  } catch (e) {}
}
function status() { return { ru: ready('ru'), kk: ready('kk'), error: failed || undefined }; }

module.exports = { handle, ensure, status, clean };
