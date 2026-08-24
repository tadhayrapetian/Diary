// Текстовые файлы не говорят, что они такое. Русские особенно: .txt из старого
// архива с равной вероятностью windows-1251 и UTF-8, а ошибка превращает книгу
// в «ÐšÑ€Ð°ÑÐ½Ð¾Ðµ». Поэтому: верим объявленной кодировке, если она есть, иначе
// гадаем — и оцениваем догадки по тому, насколько они похожи на язык.

const CANDIDATES = ['utf-8', 'windows-1251', 'koi8-r', 'ibm866', 'iso-8859-5', 'windows-1252'];

const decode = (buffer, label) => {
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
};

const strictDecode = (buffer, label) => {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
};

// Буквы, обычные для русской и английской прозы, против мусора, который даёт
// неверная таблица: псевдографика, случайные диакритики, знаки замены.
function score(text) {
  let good = 0;
  let bad = 0;
  const sample = text.length > 40000 ? text.slice(0, 40000) : text;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) bad += 3;
    else if ((c >= 0x0410 && c <= 0x044f) || c === 0x0401 || c === 0x0451) good += 1;   // кириллица
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) good += 1;           // латиница
    else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) good += 1;
    else if ((c >= 0x30 && c <= 0x39) || '.,!?;:-—«»"\'()[]…'.includes(ch)) good += 0.5;
    else if (c >= 0x2500 && c <= 0x25ff) bad += 2;                                      // псевдографика
    else if (c >= 0xc0 && c <= 0xff) bad += 1;                                          // латиница-1 посреди русского текста
    else if (c < 0x20) bad += 1;
  }
  return good - bad * 2;
}

/**
 * Раскодировать текст: сначала BOM и объявленная кодировка, гадание — только
 * когда иначе никак.
 *
 * @param {Buffer} buffer
 * @param {string} [declared] кодировка, названная самим файлом
 */
export function decodeText(buffer, declared) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return decode(buffer.subarray(3), 'utf-8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return decode(buffer.subarray(2), 'utf-16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return decode(buffer.subarray(2), 'utf-16be');

  if (declared) {
    const label = declared.trim().toLowerCase().replace(/^cp/, 'windows-');
    const decoded = decode(buffer, label === 'windows-866' ? 'ibm866' : label);
    if (decoded && !decoded.includes('�')) return decoded;
  }

  const clean = strictDecode(buffer, 'utf-8');
  if (clean !== null) return clean;

  let best = null;
  let bestScore = -Infinity;
  for (const label of CANDIDATES) {
    const text = decode(buffer, label);
    if (text === null) continue;
    const value = score(text);
    if (value > bestScore) {
      bestScore = value;
      best = text;
    }
  }
  return best ?? buffer.toString('latin1');
}

/** Кодировка, которую XML называет в своём объявлении, если называет. */
export function declaredEncoding(buffer) {
  const head = buffer.subarray(0, 400).toString('latin1');
  return /<\?xml[^>]*\bencoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]
    || /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
    || null;
}

export const decodeXml = (buffer) => decodeText(buffer, declaredEncoding(buffer));
