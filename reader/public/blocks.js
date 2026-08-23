/**
 * The wire format between the typesetter and the page, and the rendering of it.
 *
 * One block per line, tagged: `P Some text`. Line-delimited because the article
 * arrives as a stream and a line is the one boundary you can be sure of — a
 * half-received line is still a usable, growing paragraph, so the page fills in
 * as the words arrive rather than appearing all at once at the end.
 *
 * Pure string work, no DOM: the server, the browser and the tests all read it.
 */

export const TAGS = new Set([
  'TITLE', 'KICKER', 'DECK', 'BYLINE', 'SUMMARY',
  'H2', 'H3', 'P', 'QUOTE', 'PULL', 'LI', 'NLI', 'NOTE', 'TERM', 'HR',
]);

/** `QUOTE text :: attribution` — the separator, kept out of prose by being odd. */
const SPLIT = '::';

export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = /^([A-Z][A-Z0-9]{0,7})(?:\s+([\s\S]*))?$/.exec(trimmed);
  const tag = match?.[1];
  if (!tag || !TAGS.has(tag)) {
    // Anything unrecognised is prose. A malformed line should still be readable.
    return { type: 'p', text: trimmed };
  }
  const body = (match[2] ?? '').trim();

  switch (tag) {
    case 'HR':
      return { type: 'hr' };
    case 'TITLE':
      return { type: 'title', text: body };
    case 'KICKER':
      return { type: 'kicker', text: body };
    case 'DECK':
      return { type: 'deck', text: body };
    case 'BYLINE':
      return { type: 'byline', text: body };
    case 'SUMMARY':
      return { type: 'summary', text: body };
    case 'H2':
      return { type: 'h2', text: body };
    case 'H3':
      return { type: 'h3', text: body };
    case 'PULL':
      return { type: 'pull', text: body };
    case 'LI':
      return { type: 'li', text: body };
    case 'NLI':
      return { type: 'nli', text: body };
    case 'NOTE':
      return { type: 'note', text: body };
    case 'QUOTE': {
      const at = body.lastIndexOf(SPLIT);
      return at < 0
        ? { type: 'quote', text: body, attribution: '' }
        : {
            type: 'quote',
            text: body.slice(0, at).trim(),
            attribution: body.slice(at + SPLIT.length).trim(),
          };
    }
    case 'TERM': {
      const at = body.indexOf(SPLIT);
      if (at < 0) return null;
      return {
        type: 'term',
        word: body.slice(0, at).trim(),
        gloss: body.slice(at + SPLIT.length).trim(),
      };
    }
    default:
      return { type: 'p', text: body };
  }
}

/**
 * Feed it stream chunks; it calls back per block, repeatedly for the block
 * still being written and once more when the line closes.
 *
 * @param {(block: object, index: number, done: boolean) => void} onBlock
 */
export function createBlockStream(onBlock) {
  let buffer = '';
  let index = 0;
  let openIndex = -1;

  const flush = (line, done) => {
    const block = parseLine(line);
    if (!block) return;
    if (openIndex < 0) openIndex = index;
    onBlock(block, openIndex, done);
    if (done) {
      index = openIndex + 1;
      openIndex = -1;
    }
  };

  return {
    push(text) {
      buffer += text;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        flush(buffer.slice(0, at), true);
        buffer = buffer.slice(at + 1);
      }
      // Show the line that is still arriving, so the page keeps filling. A bare
      // run of capitals is held back: it may still turn out to be a tag, and
      // rendering it as prose first would make the block flicker.
      const pending = buffer.trim();
      if (pending && !/^[A-Z][A-Z0-9]{0,7}$/.test(pending)) flush(buffer, false);
    },
    end() {
      if (buffer.trim()) flush(buffer, true);
      buffer = '';
    },
  };
}

// ------------------------------------------------------------------ rendering

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Every word gets its own element, because every word is a thing you can ask
 * about. Punctuation and spacing stay as plain text between them.
 */
const WORD = /[\p{L}\p{M}][\p{L}\p{M}\p{Nd}]*(?:['’‐-][\p{L}\p{M}][\p{L}\p{M}\p{Nd}]*)*/gu;

export function tokenizeWords(text) {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(WORD)) {
    out += escapeHtml(text.slice(last, match.index));
    out += `<w->${escapeHtml(match[0])}</w->`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * Inline emphasis, applied around the word elements. The typesetter is asked
 * for `**bold**` and `_italic_` and nothing else, so nothing else is honoured.
 */
export function renderInline(text) {
  const marked = tokenizeWords(text);
  return marked
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(—–-])_([^_]+?)_(?=$|[\s.,;:!?)—–-])/g, '$1<em>$2</em>');
}

/** @returns {string} html for one block, or '' for blocks shown elsewhere */
export function blockToHtml(block, options = {}) {
  const inline = (text) => renderInline(text || '');
  switch (block.type) {
    case 'title':
      return `<h1 class="a-title">${inline(block.text)}</h1>`;
    case 'kicker':
      return `<p class="a-kicker">${inline(block.text)}</p>`;
    case 'deck':
      return `<p class="a-deck">${inline(block.text)}</p>`;
    case 'byline':
      return `<p class="a-byline">${inline(block.text)}</p>`;
    case 'summary':
      return `<aside class="a-summary"><span class="a-summary-label">In short</span>${inline(
        block.text,
      )}</aside>`;
    case 'h2':
      return `<h2 class="a-h2"${options.id ? ` id="${escapeHtml(options.id)}"` : ''}>${inline(
        block.text,
      )}</h2>`;
    case 'h3':
      return `<h3 class="a-h3"${options.id ? ` id="${escapeHtml(options.id)}"` : ''}>${inline(
        block.text,
      )}</h3>`;
    case 'p':
      return `<p class="a-p${options.lead ? ' a-lead' : ''}">${inline(block.text)}</p>`;
    case 'pull':
      return `<aside class="a-pull">${inline(block.text)}</aside>`;
    case 'note':
      return `<aside class="a-note">${inline(block.text)}</aside>`;
    case 'li':
      return `<li class="a-li">${inline(block.text)}</li>`;
    case 'nli':
      return `<li class="a-li">${inline(block.text)}</li>`;
    case 'quote':
      return (
        `<blockquote class="a-quote"><p>${inline(block.text)}</p>` +
        (block.attribution ? `<cite>${inline(block.attribution)}</cite>` : '') +
        '</blockquote>'
      );
    case 'hr':
      return '<div class="a-break" aria-hidden="true"></div>';
    default:
      return '';
  }
}

/** Blocks that carry the article's identity rather than its body. */
export const HEADER_TYPES = new Set(['title', 'kicker', 'deck', 'byline', 'summary']);

/** Words a reader is unlikely to need, so the tap target can be skipped. */
export const READING_TIME_WPM = 220;

export function readingMinutes(wordCount) {
  return Math.max(1, Math.round(wordCount / READING_TIME_WPM));
}
