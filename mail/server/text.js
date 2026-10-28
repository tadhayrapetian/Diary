// Plain text helpers with no dependencies, shared by the server and the browser demo.

/** "Re: Fwd: RE: Hello" → "Hello": the subject without reply and forward prefixes. */
export function stripSubject(subject = '') {
  let s = String(subject).trim();
  for (;;) {
    const next = s
      .replace(/^\s*((re|fw|fwd|aw|wg|sv|vs|ответ|отв|пересл)(\[\d+\])?\s*:\s*)/i, '')
      .replace(/^\s*\[[^\]]{1,40}\]\s*/, (m) => (/^\s*\[(ext|external)\]/i.test(m) ? '' : m))
      .trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ');
}

/** The case-folded stripped subject. Used to stitch conversations together. */
export const normalizeSubject = (subject = '') => stripSubject(subject).toLowerCase();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Rough but dependable HTML → plain text, good enough for previews and prompts. */
export function htmlToText(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One line of preview text: no quoted history, no signatures, no whitespace runs. */
export function snippetFrom(text = '', max = 180) {
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^--\s*$/.test(line)) break;
    if (/^(On|В|Le|Am) .{4,120}(wrote|написал|a écrit|schrieb)/i.test(line)) break;
    kept.push(line);
  }
  const flat = kept.join(' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function addressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.value || [value];
  return list
    .flatMap((a) => (a.group ? addressList(a.group) : [a]))
    .filter((a) => a && (a.address || a.name))
    .map((a) => ({ name: a.name || '', address: (a.address || '').toLowerCase() }));
}

/** Parse "Name <a@b>, c@d" as typed into a recipient field. */
export function parseRecipients(value) {
  if (Array.isArray(value)) return value.flatMap(parseRecipients);
  if (!value) return [];
  if (typeof value === 'object') return value.address ? [{ name: value.name || '', address: value.address }] : [];
  return String(value)
    .split(/[,;\n]/)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const m = /^(.*?)<([^>]+)>$/.exec(piece);
      if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() };
      return { name: '', address: piece };
    })
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address));
}

export function escapeHtml(text = '') {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Plain text → minimal HTML, keeping line breaks and making links clickable. */
export function textToHtml(text = '') {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, '<br>');
}
