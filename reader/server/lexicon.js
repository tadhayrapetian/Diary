/**
 * The word card: what a tapped word means here, how it sounds, and how to say
 * it in the reader's own language.
 *
 * Answers are cached on the sentence as well as the word, because the whole
 * point is that "charge" in a cavalry charge is not "charge" on a bill.
 */

const SENSE = {
  type: 'object',
  properties: {
    pos: { type: 'string' },
    gloss: { type: 'string' },
    translation: { type: 'string' },
    example: { type: 'string' },
  },
  required: ['pos', 'gloss', 'translation', 'example'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string' },
    lemma: { type: 'string' },
    ipa: { type: 'string' },
    pos: { type: 'string' },
    translation: { type: 'string' },
    meaning: { type: 'string' },
    note: { type: 'string' },
    example: { type: 'string' },
    forms: { type: 'string' },
    etymology: { type: 'string' },
    unknown: { type: 'boolean' },
    senses: { type: 'array', items: SENSE },
  },
  required: [
    'word', 'lemma', 'ipa', 'pos', 'translation', 'meaning',
    'note', 'example', 'forms', 'etymology', 'unknown', 'senses',
  ],
  additionalProperties: false,
};

const LANGUAGES = {
  en: 'English', ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
  tr: 'Turkish', ar: 'Arabic', fa: 'Persian', he: 'Hebrew', hi: 'Hindi',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', vi: 'Vietnamese', id: 'Indonesian',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech',
  el: 'Greek', ro: 'Romanian', hu: 'Hungarian', hy: 'Armenian', ka: 'Georgian',
  sr: 'Serbian', bg: 'Bulgarian', kk: 'Kazakh', az: 'Azerbaijani', la: 'Latin',
};

export const languageName = (code) =>
  LANGUAGES[String(code || '').toLowerCase().slice(0, 2)] || code || 'English';

/** Least-recently-used, so a long reading session does not grow without bound. */
class Cache {
  constructor(limit = 4000) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

const cache = new Cache();

/** The sentence matters, but only its shape — normalise so near-misses hit. */
function cacheKey({ word, sentence, sourceLang, targetLang }) {
  const context = String(sentence || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  return `${sourceLang}>${targetLang}|${word.toLowerCase()}|${context}`;
}

function askFor({ word, sentence, sourceLang, targetLang, title }) {
  const lines = [
    `Word: ${word}`,
    sentence ? `Sentence: ${sentence}` : 'Sentence: (none given)',
    `Article language: ${languageName(sourceLang)}`,
    `Reader's language: ${languageName(targetLang)}`,
  ];
  if (title) lines.push(`Article: ${title}`);
  return lines.join('\n');
}

/**
 * @param {object} query word, sentence, sourceLang, targetLang, title
 * @param {object} deps  client, model, prompt
 * @returns {Promise<object>} a card matching SCHEMA, plus `source`
 */
export async function lookUp(query, deps) {
  const word = String(query.word || '').trim().slice(0, 200);
  if (!word) throw new Error('no word given');

  const normalised = {
    word,
    sentence: String(query.sentence || '').slice(0, 600),
    sourceLang: String(query.sourceLang || 'en').slice(0, 8),
    targetLang: String(query.targetLang || 'ru').slice(0, 8),
    title: String(query.title || '').slice(0, 160),
  };

  const key = cacheKey(normalised);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const response = await deps.client.messages.create({
    model: deps.model,
    max_tokens: 1600,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system: [{ type: 'text', text: deps.prompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: askFor(normalised) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(response.stop_details?.explanation || 'declined');
  }

  const text = response.content.find((block) => block.type === 'text')?.text || '';
  let card;
  try {
    card = JSON.parse(text);
  } catch {
    throw new Error('the dictionary answered in a shape we could not read');
  }

  const result = {
    word: card.word || word,
    lemma: card.lemma || '',
    ipa: (card.ipa || '').replace(/^[/[]|[/\]]$/g, ''),
    pos: card.pos || '',
    translation: card.translation || '',
    meaning: card.meaning || '',
    note: card.note || '',
    example: card.example || '',
    forms: card.forms || '',
    etymology: card.etymology || '',
    unknown: Boolean(card.unknown),
    senses: Array.isArray(card.senses) ? card.senses.slice(0, 6) : [],
    audio: '',
    source: 'model',
  };
  cache.set(key, result);
  return result;
}

export const internals = { Cache, cacheKey, SCHEMA };
