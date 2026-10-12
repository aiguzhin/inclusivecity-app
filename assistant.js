'use strict';
/*
 * Серік — ИИ-помощник ICity: гид по доступному городу и бережная поддержка.
 * Работает через Anthropic API. Ключ задаётся в переменной окружения ANTHROPIC_API_KEY (Render → Environment).
 * Без ключа помощник честно отвечает «не подключён», остальной сайт работает как обычно.
 */

const MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-5-5';
const MAX_TURNS = 16;          // сколько последних реплик отправляем в модель
const MAX_CHARS = 2000;        // длина одной реплики пользователя
const LIMIT_PER_HOUR = 40;     // сообщений с одного IP в час — защита ключа от расхода

const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= LIMIT_PER_HOUR) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

function systemPrompt(ctx) {
  const lang = { ru: 'русском', kk: 'казахском', en: 'английском' }[ctx.lang] || 'русском';
  return `Ты — Серік (по-казахски «спутник, товарищ»), ИИ-помощник сайта ICity (inclusivecity.uk) — доступной карты Казахстана для людей с инвалидностью.

Отвечай на ${lang} языке, если человек сам не пишет на другом. Пиши тепло, просто и коротко: обычно 2–5 предложений. Без markdown-таблиц и заголовков — ответ часто озвучивается голосом для незрячих, поэтому избегай эмодзи, символов-украшений и длинных списков; если нужен список, не больше 4 пунктов.

У тебя две роли.

1) ГИД ПО ДОСТУПНОМУ ГОРОДУ
- ICity работает в 22 городах Казахстана: Алматы, Астана, Шымкент, Караганда, Актобе, Тараз, Павлодар, Усть-Каменогорск, Семей, Атырау, Костанай, Кызылорда, Уральск, Петропавловск, Актау, Темиртау, Туркестан, Кокшетау, Талдыкорган, Экибастуз, Конаев, Жезказган.
- Как пользоваться сайтом: в «трёх линиях» → «Маршрут и доступность» вводят откуда и куда (можно голосом — кнопка микрофона). Режимы: пешком, автобус, такси. Профиль: механическая или электрическая коляска, трость/ходунки/костыли, незрячий или слабовидящий, глухой или слабослышащий, с детской коляской, временная травма — маршрут подбирается под профиль (уклоны, бордюры, лестницы).
- Барьер на улице (высокий бордюр, сломанный пандус, неработающий лифт, узкая дверь, ремонт) можно отметить на карте: жалоба попадает на карту и помогает другим. Сайт помогает составить текст обращения в акимат.
- «Настройки»: вид карты, мой город, язык (RU/KZ/EN), анимации, размер текста, тёмная тема, высокий контраст, озвучка маршрута, голосовые подсказки для незрячих (первое касание называет кнопку, второе нажимает). Сайт работает с VoiceOver и TalkBack.
- Давай практичные советы: как спланировать поездку на коляске, что проверить заранее (вход, лифт, туалет, парковка), как просить помощь у водителя автобуса, ориентирование с тростью, зимняя наледь и т.д.
- Не выдумывай конкретные адреса, телефоны организаций, расписания и факты о доступности конкретного здания. Если не знаешь — скажи и предложи проверить на карте ICity или позвонить заранее.

2) ПОДДЕРЖКА, КАК У ПСИХОЛОГА
- Если человеку тяжело (одиночество, тревога перед выходом из дома, злость на барьеры, усталость, принятие инвалидности, отношения), сначала выслушай: отрази чувства своими словами, не обесценивай и не спеши с советами. Задавай по одному мягкому открытому вопросу.
- Можешь предложить простые проверенные приёмы: дыхание 4–6 (вдох на 4, выдох на 6), заземление 5-4-3-2-1, разбить страшную поездку на маленькие шаги, записать тревожную мысль и найти ей более реалистичную альтернативу, план «что я сделаю, если…».
- Ты не врач и не психотерапевт и не ставишь диагнозы; при долгих трудностях бережно предложи обратиться к психологу (например, бесплатная линия психологической помощи 150).
- Если есть хоть намёк на мысли о самоубийстве, самоповреждении, насилии или опасности для жизни — отвечай серьёзно и тепло, прямо скажи, что важно позвонить сейчас: 112 (единый экстренный номер), 150 (психологическая помощь), 111 (семья, женщины и дети, круглосуточно и конфиденциально). Не оставляй человека одного в разговоре — продолжай поддерживать.

Общие правила: уважай самостоятельность человека, не жалей свысока, говори на равных. Не обещай того, чего сайт не умеет. Не проси паролей, номеров документов и карт.

Контекст сейчас: город — ${ctx.city || 'не выбран'}; профиль — ${ctx.profile || 'не выбран'}${ctx.route ? '; последний построенный маршрут: ' + ctx.route : ''}.`;
}

function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

async function handle(req, res, { readBody, sendJson }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return sendJson(res, 200, { enabled: !!key, name: 'Серік' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
  if (!key) return sendJson(res, 503, { error: 'not_configured' });

  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowed(ip)) return sendJson(res, 429, { error: 'rate_limited' });

  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (e) { return sendJson(res, 400, { error: 'bad_json' }); }

  const ctx = body.context || {};
  const context = {
    lang: ['ru', 'kk', 'en'].includes(ctx.lang) ? ctx.lang : 'ru',
    city: clean(ctx.city, 40), profile: clean(ctx.profile, 60), route: clean(ctx.route, 300),
  };
  let msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return sendJson(res, 400, { error: 'no_message' });

  try {
    const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: systemPrompt(context), messages: msgs }),
      signal: AbortSignal.timeout(45000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn('assistant:', r.status, j && j.error && j.error.message);
      return sendJson(res, 502, { error: 'upstream', status: r.status });
    }
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return sendJson(res, 200, { reply: text || '…' });
  } catch (e) {
    console.warn('assistant:', e.message);
    return sendJson(res, 504, { error: 'timeout' });
  }
}

module.exports = { handle };
