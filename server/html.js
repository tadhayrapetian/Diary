// Превращение главы из файла книги в то, что не страшно показать на странице.
//
// Типографика здесь наша, а не издательская: стили и разметка оформления
// выбрасываются, остаётся структура — заголовки, абзацы, выделение, цитаты,
// стихи, таблицы, картинки. Поэтому книга 1998 года и книга прошлого месяца
// выглядят здесь одной и той же книгой.

import { parseXml, HTML_VOID, attr } from './xml.js';

const KEEP = new Set([
  'p', 'div', 'span', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'em', 'i', 'strong', 'b', 'u', 's', 'strike', 'del', 'ins', 'mark',
  'sup', 'sub', 'small', 'abbr', 'cite', 'q', 'blockquote', 'pre', 'code',
  'samp', 'kbd', 'var', 'time', 'ruby', 'rt', 'rp', 'bdi', 'bdo',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'img', 'a',
  'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'address',
]);

// Теги, которые выбрасываются вместе со всем содержимым, а не только сами.
const DROP_SUBTREE = new Set(['script', 'style', 'head', 'title', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'audio', 'video', 'canvas', 'template']);

// Старые книги всё заворачивают в это; разворачиваем и оставляем содержимое.
const UNWRAP = new Set(['html', 'body', 'center', 'font', 'big', 'tt', 'nobr', 'a11y', 'svg', 'g', 'switch']);

const KEEP_ATTRS = new Set(['id', 'alt', 'title', 'colspan', 'rowspan', 'lang', 'dir', 'start', 'value', 'datetime', 'reversed', 'type']);

const BLOCKS = new Set(['p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'tr', 'blockquote', 'figcaption', 'section', 'article', 'pre']);

const escapeText = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

/**
 * @param {string} source  XHTML или HTML изнутри книги
 * @param {{
 *   resolve?: (href: string) => ({ kind: 'res'|'chapter'|'external', url?: string, chapter?: number, fragment?: string } | null),
 * }} [options]
 * @returns {{ html: string, text: string, title: string, headings: {id: string, level: number, title: string}[] }}
 */
export function renderDocument(source, options = {}) {
  const resolve = options.resolve || (() => null);
  const doc = parseXml(source, { voids: HTML_VOID });

  let html = '';
  let plain = '';
  const headings = [];
  let anonymous = 0;

  const walk = (node, insideHeading) => {
    for (const child of node.children) {
      if (child.type === 'text') {
        const value = child.value;
        if (value) {
          html += escapeText(value);
          plain += value;
        }
        continue;
      }
      const name = child.name;
      if (DROP_SUBTREE.has(name)) continue;

      // Половина обложек нарисована именно так: <svg><image href="cover.jpg"/></svg>.
      if (name === 'image') {
        const target = resolve(attr(child, 'href') || attr(child, 'xlink:href') || '');
        if (target?.kind === 'res') html += `<img src="${escapeAttr(target.url)}" alt="">`;
        continue;
      }
      if (UNWRAP.has(name)) {
        walk(child, insideHeading);
        continue;
      }
      if (!KEEP.has(name)) {
        // Незнакомый тег: слова оставляем, обёртку выбрасываем.
        walk(child, insideHeading);
        continue;
      }

      const heading = /^h[1-6]$/.test(name);
      const attrs = [];
      let id = attr(child, 'id');

      if (name === 'img') {
        const target = resolve(attr(child, 'src') || attr(child, 'xlink:href') || '');
        if (target?.kind !== 'res') continue;
        attrs.push(`src="${escapeAttr(target.url)}"`);
        const alt = attr(child, 'alt');
        attrs.push(`alt="${escapeAttr(alt || '')}"`);
        attrs.push('loading="lazy"');
      } else if (name === 'a') {
        const target = resolve(attr(child, 'href') || attr(child, 'xlink:href') || '');
        if (target?.kind === 'external') {
          attrs.push(`href="${escapeAttr(target.url)}"`, 'target="_blank"', 'rel="noopener noreferrer"');
        } else if (target?.kind === 'chapter') {
          // Никакого href: пустая ссылка меняет адрес страницы, а переход
          // внутри книги — дело читалки, а не браузера.
          attrs.push('class="jump"', `data-chapter="${target.chapter}"`);
          if (target.fragment) attrs.push(`data-fragment="${escapeAttr(target.fragment)}"`);
        } else if (target?.kind === 'res') {
          attrs.push(`href="${escapeAttr(target.url)}"`, 'target="_blank"', 'rel="noopener noreferrer"');
        }
      }

      if (heading) {
        if (!id) id = `h${++anonymous}`;
        headings.push({ id, level: Number(name[1]), title: '' });
      }
      if (id) attrs.unshift(`id="${escapeAttr(id)}"`);
      for (const key of KEEP_ATTRS) {
        if (key === 'id' || key === 'alt' || key === 'title') continue;
        const value = attr(child, key);
        if (value !== undefined && value !== '') attrs.push(`${key}="${escapeAttr(value)}"`);
      }
      const title = attr(child, 'title');
      if (title) attrs.push(`title="${escapeAttr(title)}"`);

      const open = `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
      if (HTML_VOID.has(name)) {
        html += open;
        if (name === 'br') plain += '\n';
        continue;
      }
      html += open;
      const textBefore = plain.length;
      walk(child, insideHeading || heading);
      html += `</${name}>`;
      if (heading) {
        headings[headings.length - 1].title = plain.slice(textBefore).replace(/\s+/g, ' ').trim();
      }
      if (BLOCKS.has(name)) plain += '\n';
    }
  };

  walk(doc, false);

  html = html
    .replace(/(<p[^>]*>)\s*(<\/p>)/g, '')      // пустые абзацы от снятого оформления
    .replace(/(?:\s*<br>\s*){3,}/g, '<br><br>')
    .trim();

  const title = headings.find((h) => h.title)?.title || '';
  return { html, text: plain.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), title, headings };
}

/** Голый текст — для поиска и подсчётов, без разметки. */
export function plainText(source) {
  return renderDocument(source).text;
}
