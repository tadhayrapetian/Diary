// Комментарий на полях.
//
// В Books на выделенном слове есть «Найти»; здесь тот же жест, только отвечает
// модель, а не словарь — потому это и работает на латинском эпиграфе или на
// слове, которое знал Даль, а поиск не знает. Всё это необязательно: без ключа
// читалка просто не предлагает такого.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.READER_MODEL || 'claude-opus-5';
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client = null;

export const lookupAvailable = () => HAS_KEY;

const SYSTEM = `Ты — комментарий на полях книги. Тебе показывают выделенный кусок текста и то,
что стоит вокруг него. Отвечай коротко и по делу, обычным текстом без списков и разметки.

- «значение» — объясни слово или выражение так, как это сделал бы хороший словарь:
  что значит, откуда, какой оттенок. Если слово устаревшее или диалектное — скажи об этом.
- «перевод» — переведи на русский. Если текст уже русский, переведи на английский.
  Только перевод, без предисловий.
- «объяснить» — объясни, что здесь происходит и почему это важно, опираясь на контекст.
  Не пересказывай текст дословно и не спойлери дальше выделенного места.

Держись в пределах 60 слов. Не выдумывай источники и не приписывай книге того, чего не видишь.`;

const PROMPTS = {
  define: 'значение',
  translate: 'перевод',
  explain: 'объяснить',
};

/**
 * @param {{ text?: string, context?: string, mode?: string, book?: string }} body
 * @returns {Promise<{ text: string }>}
 */
export async function lookup(body) {
  if (!HAS_KEY) throw Object.assign(new Error('справка выключена: нет ключа ANTHROPIC_API_KEY'), { status: 501 });

  const selection = String(body.text || '').trim().slice(0, 1500);
  if (!selection) throw Object.assign(new Error('нечего искать'), { status: 400 });

  const mode = PROMPTS[body.mode] ? body.mode : 'define';
  const context = String(body.context || '').trim().slice(0, 3000);
  const book = String(body.book || '').trim().slice(0, 200);

  client ||= new Anthropic();

  const message = [
    book ? `Книга: ${book}` : '',
    context ? `Вокруг: …${context}…` : '',
    `Выделено: «${selection}»`,
    `Нужно: ${PROMPTS[mode]}`,
  ].filter(Boolean).join('\n\n');

  const params = {
    model: MODEL,
    max_tokens: 400,
    // Комментарий на полях появляется, пока палец ещё на слове: без размышлений,
    // с наименьшим усилием — кратчайший путь до первого слова ответа.
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: message }],
  };

  // На бета-ручке есть серверные запасные пути; если аккаунту она недоступна,
  // спрашиваем обычную, а не отказываемся отвечать.
  for (const beta of [true, false]) {
    try {
      const surface = beta ? client.beta.messages : client.messages;
      const extra = beta ? { fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] } : {};
      const reply = await surface.create({ ...params, ...extra });
      const text = (reply.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
      if (text) return { text, mode };
      if (reply.stop_reason === 'refusal') return { text: 'На это я отвечать не стану.', mode };
    } catch (error) {
      if (!beta) {
        console.error('[полка] справка не ответила:', error?.message || error);
        throw Object.assign(new Error('справка сейчас недоступна'), { status: 502 });
      }
    }
  }
  return { text: '', mode };
}
