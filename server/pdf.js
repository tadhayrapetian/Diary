// PDF читается в браузере, силами pdf.js, где страница — картинка, а не абзац.
// Серверу нужны только два факта, которые показывает полка: как документ себя
// называет и сколько в нём страниц.

const CONTROL = /[\x00-\x1f\x7f]/g;

const decodeBytes = (bytes) => (bytes[0] === 0xfe && bytes[1] === 0xff
  ? Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
  : bytes.toString('latin1'));

const decodeString = (raw) => {
  if (raw.startsWith('<') && raw.endsWith('>')) {
    const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    return decodeBytes(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'));
  }
  const body = raw.slice(1, -1).replace(/\\([nrtbf()\\]|\d{1,3})/g, (m, code) => {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[code];
    return simple !== undefined ? simple : String.fromCharCode(parseInt(code, 8));
  });
  return decodeBytes(Buffer.from(body, 'latin1'));
};

const clean = (s) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

/** @param {Buffer} buffer */
export function readPdfInfo(buffer) {
  // Читаем только начало и конец: каталог и сведения о документе лежат у одного
  // из краёв, а сканированная книга бывает в сотни мегабайт.
  const head = buffer.subarray(0, Math.min(buffer.length, 512 * 1024)).toString('latin1');
  const tail = buffer.subarray(Math.max(0, buffer.length - 512 * 1024)).toString('latin1');
  const source = head + tail;

  const field = (name) => {
    const match = new RegExp(`/${name}\\s*(\\((?:[^()\\\\]|\\\\.)*\\)|<[0-9a-fA-F\\s]+>)`).exec(source);
    return match ? clean(decodeString(match[1])) : '';
  };

  let title = field('Title');
  let author = field('Author');

  // Программы поновее кладут то же самое в XMP — это обычный XML внутри файла.
  if (!title) {
    const xmp = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(source);
    if (xmp) title = clean(Buffer.from(xmp[1], 'latin1').toString('utf8'));
  }
  if (!author) {
    const xmp = /<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(source);
    if (xmp) author = clean(Buffer.from(xmp[1], 'latin1').toString('utf8'));
  }

  let pages = 0;
  const whole = buffer.toString('latin1');
  for (const match of whole.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,600}?\/Count\s+(\d+)/g)) {
    pages = Math.max(pages, Number(match[1]));
  }
  if (!pages) pages = (whole.match(/\/Type\s*\/Page[^s]/g) || []).length;

  return {
    title,
    authors: author ? [author] : [],
    pages: pages || 0,
    encrypted: /\/Encrypt\s+\d+\s+\d+\s+R/.test(tail),
  };
}
