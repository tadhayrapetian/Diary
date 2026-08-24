// Маленький терпимый разбор XML.
//
// Здесь всё XML: пакет EPUB, NCX, FB2, внутренности DOCX — и всё это приезжает
// слегка сломанным: необъявленная сущность, забытый закрывающий тег, префикс
// пространства имён, которого никто не объявлял. Строгий разборщик был бы прав
// и бесполезен. Этот продолжает читать.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', bdquo: '„', sbquo: '‚',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  bull: '•', dagger: '†', Dagger: '‡', prime: '′',
  copy: '©', reg: '®', trade: '™', deg: '°',
  sect: '§', para: '¶', times: '×', divide: '÷',
  plusmn: '±', frac12: '½', frac14: '¼', euro: '€',
  pound: '£', yen: '¥', cent: '¢', ensp: ' ',
  emsp: ' ', thinsp: ' ', shy: '­', minus: '−',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

export const HTML_VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const local = (name) => {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
};

function element(raw) {
  return { type: 'element', raw, name: local(raw).toLowerCase(), attrs: {}, children: [] };
}

function readAttrs(src, node) {
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    node.attrs[m[1]] = decodeEntities(value);
  }
}

/**
 * Разобрать документ в дерево `{ type, name, attrs, children }`.
 * Текст приходит как `{ type: 'text', value }`. Имена тегов приводятся к нижнему
 * регистру, префикс пространства имён отбрасывается; `raw` и ключи атрибутов
 * сохраняют его.
 *
 * @param {string} src
 * @param {{ voids?: Set<string> }} [options] теги, у которых не бывает тела
 */
export function parseXml(src, options = {}) {
  const voids = options.voids || new Set();
  const root = { type: 'element', raw: '#document', name: '#document', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().children.push({ type: 'text', value: src.slice(lt + 9, end === -1 ? n : end) });
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // В doctype бывает внутреннее подмножество в скобках — перешагиваем целиком.
      let end = lt + 2;
      let depth = 0;
      while (end < n) {
        const c = src[end];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        end++;
      }
      i = end + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = local(src.slice(lt + 2, end === -1 ? n : end).trim()).toLowerCase();
      // Закрываем ближайшего подходящего предка; чужой закрывающий тег пропускаем.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Открывающий тег. В кавычках может быть '>', поэтому идём посимвольно.
    let end = lt + 1;
    let quote = '';
    while (end < n) {
      const c = src[end];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      end++;
    }
    const inner = src.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s/]/);
    const raw = (space === -1 ? body : body.slice(0, space)).trim();
    if (raw) {
      const node = element(raw);
      if (space !== -1) readAttrs(body.slice(space), node);
      top().children.push(node);
      if (!selfClosing && !voids.has(node.name)) stack.push(node);
    }
    i = end + 1;
  }

  return root;

  function pushText(value) {
    if (!value) return;
    top().children.push({ type: 'text', value: decodeEntities(value) });
  }
}

export function children(node, name) {
  if (!node) return [];
  const wanted = name?.toLowerCase();
  return node.children.filter((c) => c.type === 'element' && (!wanted || c.name === wanted));
}

/** Первый элемент с таким именем, в глубину. */
export function find(node, name) {
  const wanted = name.toLowerCase();
  const stack = node ? [...node.children] : [];
  while (stack.length) {
    const c = stack.shift();
    if (c.type !== 'element') continue;
    if (c.name === wanted) return c;
    stack.unshift(...c.children);
  }
  return null;
}

/** Все элементы с таким именем, в порядке документа. */
export function findAll(node, name) {
  const wanted = name.toLowerCase();
  const out = [];
  const walk = (parent) => {
    for (const c of parent.children) {
      if (c.type !== 'element') continue;
      if (c.name === wanted) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** Атрибут по точному имени — или по имени без префикса, если префикс неизвестен. */
export function attr(node, name) {
  if (!node) return undefined;
  if (node.attrs[name] !== undefined) return node.attrs[name];
  const wanted = local(name).toLowerCase();
  for (const key of Object.keys(node.attrs)) {
    if (local(key).toLowerCase() === wanted) return node.attrs[key];
  }
  return undefined;
}

/** Весь текст под узлом, склеенный. */
export function text(node) {
  if (!node) return '';
  let out = '';
  const walk = (parent) => {
    for (const c of parent.children) {
      if (c.type === 'text') out += c.value;
      else walk(c);
    }
  };
  walk(node);
  return out;
}

export const trimmedText = (node) => text(node).replace(/\s+/g, ' ').trim();
