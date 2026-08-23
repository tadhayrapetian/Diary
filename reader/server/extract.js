/**
 * Anything the user drops in -> plain text with light structural hints.
 *
 * The hints are markdown-ish (`# heading`, `> quote`, `- item`) because both
 * the model typesetter and the local one read them, and because a format that
 * survives a round trip through a text box is also a format the user can paste.
 */

import zlib from 'node:zlib';
import { extractPdf } from './pdf.js';

// --------------------------------------------------------------------- zip

/**
 * Minimal reader for the zip container behind .docx and .epub. Entries are
 * found through the central directory, the one part of a zip whose location is
 * guaranteed.
 */
function readZip(buffer) {
  const entries = new Map();
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { names: [], read: null };

  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  // Zip64: the 32-bit fields saturate and the real values sit in another record.
  if (offset === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= floor; i--) {
      if (buffer.readUInt32LE(i) === 0x07064b50) {
        const at = Number(buffer.readBigUInt64LE(i + 8));
        if (at + 56 < buffer.length && buffer.readUInt32LE(at) === 0x06064b50) {
          count = Number(buffer.readBigUInt64LE(at + 32));
          offset = Number(buffer.readBigUInt64LE(at + 48));
        }
        break;
      }
    }
  }

  for (let i = 0; i < count && offset + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const read = (name) => {
    const entry = entries.get(name);
    if (!entry || entry.localOffset + 30 > buffer.length) return null;
    if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) return null;
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    let size = entry.compressedSize;
    if (!size || size === 0xffffffff) size = buffer.length - start;
    const data = buffer.subarray(start, start + size);
    try {
      return entry.method === 0 ? data : zlib.inflateRawSync(data);
    } catch {
      try {
        return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        return null;
      }
    }
  };

  return { names: [...entries.keys()], read };
}

// ----------------------------------------------------------------- entities

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00A0', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003',
  shy: '', zwj: '', zwnj: '',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
  bull: '•', middot: '·', prime: '′', Prime: '″',
  copy: '©', reg: '®', trade: '™', permil: '‰',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  minus: '−', frac12: '½', frac14: '¼', frac34: '¾',
  sect: '§', para: '¶', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à',
  aacute: 'á', acirc: 'â', auml: 'ä', aring: 'å',
  ccedil: 'ç', iacute: 'í', iuml: 'ï', ntilde: 'ñ',
  oacute: 'ó', ouml: 'ö', ocirc: 'ô', oslash: 'ø',
  uacute: 'ú', uuml: 'ü', szlig: 'ß', aelig: 'æ',
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[body] ?? whole;
  });
}

// --------------------------------------------------------------------- html

const BLOCK_TAGS =
  'address|article|aside|blockquote|div|dl|dd|dt|fieldset|figcaption|figure|' +
  'footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|' +
  'tfoot|th|thead|tr|ul';

export function htmlToText(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(script|style|noscript|svg|head|nav|footer|form|template|iframe)\b[\s\S]*?<\/\1\s*>/gi,
      '',
    );

  // Prefer the readable body when the page says plainly where it is.
  const article = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(text);
  if (article && article[2].replace(/<[^>]+>/g, '').trim().length > 400) text = article[2];

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  text = text
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n\n')
    .replace(/<[^>]+>/g, '');

  return {
    text: normalizeWhitespace(decodeEntities(text)),
    meta: { title: title ? decodeEntities(title).trim() : '' },
  };
}

// --------------------------------------------------------------------- docx

const HEADING_STYLE = /^(?:Heading|heading|Titre|Titulo)(\d)$/;

function docxToText(buffer) {
  const zip = readZip(buffer);
  if (!zip.read) return null;
  const document = zip.read('word/document.xml');
  if (!document) return null;
  const xml = document.toString('utf8');

  const meta = {};
  const core = zip.read('docProps/core.xml')?.toString('utf8');
  if (core) {
    meta.title = decodeEntities(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? '').trim();
    meta.author = decodeEntities(
      /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core)?.[1] ?? '',
    ).trim();
  }

  const out = [];
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const body = paragraph[1];
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(body)?.[1] ?? '';
    let text = '';
    for (const piece of body.matchAll(
      /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g,
    )) {
      if (piece[1] !== undefined) text += decodeEntities(piece[1]);
      else if (piece[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    text = text.replace(/[ \t]+/g, ' ').trim();
    if (!text) {
      out.push('');
      continue;
    }
    const heading = HEADING_STYLE.exec(style);
    if (heading) out.push(`${'#'.repeat(Math.min(6, Number(heading[1])))} ${text}`);
    else if (/^(Title|Titel)$/i.test(style)) out.push(`# ${text}`);
    else if (/quote|zitat/i.test(style)) out.push(`> ${text}`);
    else if (/^(ListParagraph|Listenabsatz)$/i.test(style)) out.push(`- ${text}`);
    else out.push(text);
  }

  return { text: normalizeWhitespace(out.join('\n\n')), meta };
}

// --------------------------------------------------------------------- epub

function epubToText(buffer) {
  const zip = readZip(buffer);
  if (!zip.read) return null;

  const container = zip.read('META-INF/container.xml')?.toString('utf8') ?? '';
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  const meta = {};
  let order = [];

  if (opfPath) {
    const opf = zip.read(opfPath)?.toString('utf8') ?? '';
    meta.title = decodeEntities(
      /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? '',
    ).trim();
    meta.author = decodeEntities(
      /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf)?.[1] ?? '',
    ).trim();

    const manifest = new Map();
    for (const item of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = /id="([^"]+)"/.exec(item[0])?.[1];
      const href = /href="([^"]+)"/.exec(item[0])?.[1];
      if (id && href) manifest.set(id, href);
    }
    const base = opfPath.includes('/') ? opfPath.replace(/\/[^/]*$/, '/') : '';
    for (const ref of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
      const href = manifest.get(ref[1]);
      if (href) order.push(decodeURIComponent(base + href).replace(/^\.\//, ''));
    }
  }
  if (!order.length) order = zip.names.filter((n) => /\.(x?html|htm)$/i.test(n)).sort();

  const parts = [];
  for (const name of order.slice(0, 400)) {
    const raw = zip.read(name);
    if (!raw) continue;
    const { text } = htmlToText(raw.toString('utf8'));
    if (text.trim().length > 20) parts.push(text.trim());
  }
  if (!parts.length) return null;
  return { text: normalizeWhitespace(parts.join('\n\n')), meta };
}

// ---------------------------------------------------------------------- rtf

function rtfToText(text) {
  const out = text
    .replace(/\{\\\*[\s\S]*?\}/g, '')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, code) => {
      const n = Number(code);
      return String.fromCharCode(n < 0 ? n + 65536 : n);
    })
    .replace(/\\par[d]?\b/g, '\n\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '');
  return { text: normalizeWhitespace(out), meta: {} };
}

// ------------------------------------------------------------------- cleanup

const LIGATURES = {
  '\uFB01': 'fi', '\uFB02': 'fl', '\uFB00': 'ff',
  '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'ft', '\uFB06': 'st',
};

export function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\uFEFF/g, '')
    .replace(/[\u00AD\u200B\u200C\u200D\u2060]/g, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u00A0\u2002\u2003\u2007\u2009\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Undo what a page layout does to prose: words broken across lines, ligature
 * glyphs standing in for letter pairs, and single newlines that are really only
 * line wrapping. Blank lines are left alone -- those are the paragraph breaks.
 */
export function repairProse(text) {
  let out = text;
  for (const [glyph, letters] of Object.entries(LIGATURES)) {
    if (out.includes(glyph)) out = out.split(glyph).join(letters);
  }

  // "care-\nfully" is one word; "Anglo-\nSaxon" is not.
  out = out.replace(/([a-zà-öø-ÿа-я])-\n([a-zà-öø-ÿа-я])/g, '$1$2');

  out = out.replace(/([^\n])\n(?!\n)([^\n])/g, (whole, before, after) => {
    if (/[-–—]$/.test(before)) return whole;
    if (/^[-*#>]/.test(after)) return whole; // a list or heading marker starts a real line
    return `${before} ${after}`;
  });

  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------ dispatch

const BY_EXTENSION = {
  pdf: 'pdf', docx: 'docx', docm: 'docx', epub: 'epub',
  html: 'html', htm: 'html', xhtml: 'html', rtf: 'rtf',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'text', text: 'text', log: 'text', csv: 'text',
  tex: 'text', srt: 'text', vtt: 'text',
};

function sniff(buffer, filename) {
  const extension = /\.([a-z0-9]+)$/i.exec(filename || '')?.[1]?.toLowerCase();
  if (extension && BY_EXTENSION[extension]) return BY_EXTENSION[extension];

  const head = buffer.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('PK')) {
    const zip = readZip(buffer);
    if (zip.names.includes('word/document.xml')) return 'docx';
    if (zip.names.some((name) => name.endsWith('.opf'))) return 'epub';
    return 'unknown';
  }
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (/<html|<!doctype html|<body|<article/i.test(buffer.subarray(0, 2000).toString('utf8'))) {
    return 'html';
  }
  return 'text';
}

/**
 * @param {Buffer} buffer raw bytes
 * @param {string} filename used to pick a reader; content wins when they disagree
 * @returns {{text: string, meta: object, kind: string, ok: boolean, reason: string}}
 */
export function extract(buffer, filename = '') {
  const kind = sniff(buffer, filename);
  const fromFilename = (filename || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  // The filename is a name, not a title: a document that opens with a real
  // title should use that, so the two are kept apart for the typesetter.
  const done = (result) => ({
    kind,
    meta: { title: '', name: fromFilename, ...(result?.meta || {}) },
    text: result?.text ? repairProse(result.text) : '',
    ok: Boolean(result?.text?.trim()),
    reason: result?.text?.trim() ? '' : 'the file held no readable text',
  });

  const failed = (reason) => ({
    kind,
    meta: { title: '', name: fromFilename },
    text: '',
    ok: false,
    reason,
  });

  switch (kind) {
    case 'pdf': {
      const pdf = extractPdf(buffer);
      return {
        kind,
        meta: {
          title: pdf.meta?.title || '',
          name: fromFilename,
          author: pdf.meta?.author || '',
        },
        text: pdf.ok ? repairProse(pdf.text) : '',
        ok: pdf.ok,
        reason: pdf.reason,
        pages: pdf.pageCount,
      };
    }
    case 'docx': {
      const result = docxToText(buffer);
      return result ? done(result) : failed('could not read this Word file');
    }
    case 'epub': {
      const result = epubToText(buffer);
      return result ? done(result) : failed('could not read this EPUB');
    }
    case 'html':
      return done(htmlToText(buffer.toString('utf8')));
    case 'rtf':
      return done(rtfToText(buffer.toString('latin1')));
    case 'markdown':
    case 'text':
      return done({ text: normalizeWhitespace(buffer.toString('utf8')), meta: {} });
    default:
      return failed('unsupported file - try a PDF, Word file, EPUB, HTML or plain text');
  }
}

export const readers = { readZip, docxToText, epubToText, htmlToText, rtfToText };
