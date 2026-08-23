/**
 * What the app does without an API key.
 *
 * A heuristic typesetter that reads the shape of the text rather than the sense
 * of it, and word lookups borrowed from two free public services. Both are
 * plainly worse than the model, and both exist so the app is never dead on
 * arrival: you can drop a file in and read it before you have a key.
 */

// -------------------------------------------------------------- typesetting

const BULLET = /^\s*[-*•‣▪]\s+/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+/;
const HEADING_MARK = /^\s*(#{1,6})\s+/;
const QUOTED = /^\s*>\s?/;
const RULE = /^\s*([-*_=]\s*){3,}$/;

const isSentenceish = (line) => /[.!?;:,]["'’”)]?\s*$/.test(line);

/** A line that stands alone, is short, and does not end like a sentence. */
function looksLikeHeading(line) {
  const text = line.trim();
  if (text.length < 2 || text.length > 90) return false;
  if (isSentenceish(text)) return false;
  if (BULLET.test(text) || NUMBERED.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length > 12) return false;
  // ALL CAPS, Title Case, or a numbered section: all headings in the wild.
  if (/^[A-ZА-Я0-9][^a-zа-я]*$/.test(text) && words.length <= 10) return true;
  if (/^(chapter|part|section|глава|часть)\b/i.test(text)) return true;
  const capitalised = words.filter((w) => /^[A-ZА-Я"'“(]/.test(w)).length;
  return capitalised >= Math.ceil(words.length * 0.6);
}

/** Straight quotes and double hyphens are typewriter habits; set them properly. */
function smarten(text) {
  return text
    .replace(/(^|[\s([{<\u2014\u2013-])"/g, '$1\u201c')
    .replace(/"/g, '\u201d')
    .replace(/(^|[\s([{<\u2014\u2013])'/g, '$1\u2018')
    .replace(/'/g, '\u2019')
    .replace(/--/g, '\u2014')
    .replace(/\.\.\./g, '\u2026');
}

const SHOUTING = (text) => {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && !/\p{Ll}/u.test(letters);
};

/** A heading that shouts was shouting for the layout, not for the reader. */
function calmCaps(text) {
  return SHOUTING(text) ? text.charAt(0) + text.slice(1).toLowerCase() : text;
}

const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'in', 'on', 'at', 'to',
  'for', 'from', 'by', 'with', 'as', 'is', 'over', 'into', 'upon',
]);

/** A title in capitals wants title case, not the sentence case a heading wants. */
function calmTitle(text) {
  if (!SHOUTING(text)) return text;
  const words = text.toLowerCase().split(/(\s+)/);
  const lastWord = words.findLast((word) => word.trim());
  return words
    .map((word, index) => {
      if (!word.trim()) return word;
      if (index > 0 && word !== lastWord && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/**
 * @param {string} source
 * @param {{title?: string, author?: string}} meta
 * @returns {string[]} protocol lines
 */
export function typesetLocally(source, meta = {}) {
  const lines = [];
  const paragraphs = source
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return ['P (nothing to read)'];

  let title = (meta.title || '').trim();
  let start = 0;

  // The document's own opening line beats a name taken off the file.
  const first = paragraphs[0].split('\n')[0].trim();
  const single = paragraphs[0].split('\n').length === 1;
  if (HEADING_MARK.test(first) && first.replace(HEADING_MARK, '').trim()) {
    title = first.replace(HEADING_MARK, '').trim();
    start = 1;
  } else if (single && looksLikeHeading(first)) {
    title = first;
    start = 1;
  }
  if (!title) title = (meta.name || '').trim();

  lines.push(`TITLE ${calmTitle(smarten(title || 'Untitled'))}`);
  if (meta.author) lines.push(`BYLINE ${meta.author}`);

  for (const paragraph of paragraphs.slice(start)) {
    for (const raw of paragraph.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      if (RULE.test(line)) {
        lines.push('HR');
        continue;
      }
      const heading = HEADING_MARK.exec(line);
      if (heading) {
        const text = line.replace(HEADING_MARK, '').trim();
        if (text) lines.push(`${heading[1].length <= 2 ? 'H2' : 'H3'} ${calmCaps(smarten(text))}`);
        continue;
      }
      if (QUOTED.test(line)) {
        lines.push(`QUOTE ${smarten(line.replace(QUOTED, '').trim())}`);
        continue;
      }
      if (BULLET.test(line)) {
        lines.push(`LI ${smarten(line.replace(BULLET, '').trim())}`);
        continue;
      }
      if (NUMBERED.test(line)) {
        lines.push(`NLI ${smarten(line.replace(NUMBERED, '').trim())}`);
        continue;
      }
      if (looksLikeHeading(line) && paragraph.split('\n').length === 1) {
        lines.push(`H2 ${calmCaps(smarten(line))}`);
        continue;
      }
      lines.push(`P ${smarten(line.replace(/\s+/g, ' '))}`);
    }
  }
  return lines;
}

// ------------------------------------------------------------------ lookups

const TIMEOUT = 6000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** dictionaryapi.dev — English headwords, free, no key. */
async function freeDictionary(word) {
  const data = await getJson(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  );
  if (!Array.isArray(data) || !data[0]) return null;

  const entry = data[0];
  const phonetic =
    entry.phonetics?.find((p) => p.text)?.text || entry.phonetic || '';
  const audio = entry.phonetics?.find((p) => p.audio)?.audio || '';
  const senses = [];
  for (const meaning of entry.meanings || []) {
    for (const definition of (meaning.definitions || []).slice(0, 2)) {
      senses.push({
        pos: meaning.partOfSpeech || '',
        gloss: definition.definition || '',
        translation: '',
        example: definition.example || '',
      });
    }
  }
  return {
    ipa: phonetic.replace(/^\/|\/$/g, ''),
    audio,
    pos: entry.meanings?.[0]?.partOfSpeech || '',
    senses: senses.slice(0, 5),
  };
}

/** MyMemory — free translation, no key, modest daily allowance. */
async function freeTranslate(text, from, to) {
  const data = await getJson(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
      `&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`,
  );
  const translated = data?.responseData?.translatedText;
  if (typeof translated !== 'string') return '';
  if (/^(MYMEMORY WARNING|INVALID|QUERY LENGTH)/i.test(translated)) return '';
  return translated.trim();
}

/**
 * A best-effort word card without a model behind it. Both services are asked at
 * once, and whatever comes back is what the reader gets.
 */
export async function lookUpLocally({ word, sourceLang = 'en', targetLang = 'ru' }) {
  const clean = String(word || '').trim();
  if (!clean) return null;

  const [dictionary, translation] = await Promise.all([
    sourceLang === 'en' ? freeDictionary(clean) : Promise.resolve(null),
    freeTranslate(clean, sourceLang, targetLang),
  ]);

  if (!dictionary && !translation) return null;

  return {
    word: clean,
    lemma: clean,
    ipa: dictionary?.ipa || '',
    audio: dictionary?.audio || '',
    pos: dictionary?.pos || '',
    translation: translation || '',
    meaning: dictionary?.senses?.[0]?.gloss || '',
    note: '',
    example: dictionary?.senses?.[0]?.example || '',
    forms: '',
    etymology: '',
    senses: (dictionary?.senses || []).slice(1, 4),
    unknown: false,
    source: 'free',
  };
}
