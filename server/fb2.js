// FictionBook 2. Один XML-файл: описание, одно или несколько тел из вложенных
// секций и картинки, закодированные в <binary> в самом конце.

import { parseXml, find, findAll, children, attr, text, trimmedText } from './xml.js';
import { decodeXml } from './encoding.js';
import { openZip, looksLikeZip } from './zip.js';

const escapeText = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

const INLINE = {
  emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code', style: 'span',
};

// В картинках почти все байты и никакой структуры. Вынимаем их до разбора,
// чтобы дерево осталось маленьким.
function extractBinaries(source) {
  const binaries = new Map();
  const stripped = source.replace(/<binary\b([^>]*)>([\s\S]*?)<\/binary>/gi, (whole, attrs, body) => {
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const type = /content-type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || 'image/jpeg';
    if (id) binaries.set(id, { mediaType: type, base64: body.replace(/\s+/g, '') });
    return '';
  });
  return { stripped, binaries };
}

function authorName(node) {
  const part = (name) => trimmedText(find(node, name));
  const nickname = part('nickname');
  const full = [part('first-name'), part('middle-name'), part('last-name')].filter(Boolean).join(' ');
  return full || nickname || '';
}

function renderer(base) {
  const render = (node, depth) => {
    let html = '';
    for (const child of node.children) {
      if (child.type === 'text') {
        html += escapeText(child.value);
        continue;
      }
      const name = child.name;
      if (INLINE[name]) {
        html += `<${INLINE[name]}>${render(child, depth)}</${INLINE[name]}>`;
        continue;
      }
      switch (name) {
        case 'p':
          html += `<p>${render(child, depth)}</p>`;
          break;
        case 'empty-line':
          html += '<p class="empty-line"> </p>';
          break;
        case 'title': {
          const level = Math.min(6, depth + 2);
          const inner = children(child, 'p').map((p) => render(p, depth)).join('<br>') || render(child, depth);
          html += `<h${level}>${inner}</h${level}>`;
          break;
        }
        case 'subtitle':
          html += `<h4 class="subtitle">${render(child, depth)}</h4>`;
          break;
        case 'epigraph':
          html += `<div class="epigraph">${render(child, depth)}</div>`;
          break;
        case 'text-author':
          html += `<p class="text-author">${render(child, depth)}</p>`;
          break;
        case 'annotation':
          html += `<div class="annotation">${render(child, depth)}</div>`;
          break;
        case 'cite':
          html += `<blockquote>${render(child, depth)}</blockquote>`;
          break;
        case 'poem':
          html += `<div class="poem">${render(child, depth)}</div>`;
          break;
        case 'stanza':
          html += `<div class="stanza">${render(child, depth)}</div>`;
          break;
        case 'v':
          html += `<p class="verse">${render(child, depth)}</p>`;
          break;
        case 'table':
          html += `<table>${render(child, depth)}</table>`;
          break;
        case 'tr':
          html += `<tr>${render(child, depth)}</tr>`;
          break;
        case 'th':
        case 'td': {
          const span = attr(child, 'colspan');
          html += `<${name}${span ? ` colspan="${escapeAttr(span)}"` : ''}>${render(child, depth)}</${name}>`;
          break;
        }
        case 'image': {
          const href = (attr(child, 'href') || attr(child, 'l:href') || '').replace(/^#/, '');
          if (href) html += `<img src="${escapeAttr(base + encodeURIComponent(href))}" alt="" loading="lazy">`;
          break;
        }
        case 'a': {
          const href = attr(child, 'href') || attr(child, 'l:href') || '';
          const label = render(child, depth);
          if (/^https?:/i.test(href)) {
            html += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
          } else if (href.startsWith('#')) {
            html += `<a class="noteref" data-note="${escapeAttr(href.slice(1))}">${label}</a>`;
          } else {
            html += label;
          }
          break;
        }
        case 'section':
          html += `<section>${render(child, depth + 1)}</section>`;
          break;
        default:
          html += render(child, depth);
      }
    }
    return html;
  };
  return render;
}

/**
 * @param {Buffer} buffer  .fb2 или .fb2.zip с ним внутри
 * @param {{ resourceBase?: string }} [options]
 */
export function readFb2(buffer, options = {}) {
  let source = buffer;
  if (looksLikeZip(buffer)) {
    const zip = openZip(buffer);
    const inner = zip.names.find((n) => n.toLowerCase().endsWith('.fb2')) || zip.names[0];
    source = zip.read(inner);
  }

  const { stripped, binaries } = extractBinaries(decodeXml(source));
  const doc = parseXml(stripped);
  const root = find(doc, 'fictionbook') || doc;

  const titleInfo = find(find(root, 'description'), 'title-info');
  const sequence = find(titleInfo, 'sequence');
  const meta = {
    title: trimmedText(find(titleInfo, 'book-title')),
    authors: children(titleInfo, 'author').map(authorName).filter(Boolean),
    language: trimmedText(find(titleInfo, 'lang')),
    description: trimmedText(find(titleInfo, 'annotation')),
    subjects: children(titleInfo, 'genre').map(trimmedText).filter(Boolean),
    date: trimmedText(find(titleInfo, 'date')),
    publisher: trimmedText(find(find(root, 'description'), 'publisher')),
    identifier: trimmedText(find(find(root, 'description'), 'id')),
    series: sequence ? attr(sequence, 'name') || '' : '',
    seriesIndex: sequence ? attr(sequence, 'number') || '' : '',
  };

  const base = options.resourceBase || '';
  const render = renderer(base);

  const bodies = children(root, 'body');
  const main = bodies.filter((b) => (attr(b, 'name') || '').toLowerCase() !== 'notes');
  const noteBodies = bodies.filter((b) => (attr(b, 'name') || '').toLowerCase() === 'notes');

  const chapters = [];
  const toc = [];

  const sectionTitle = (section) => {
    const title = find(section, 'title');
    return title ? trimmedText(title) : '';
  };

  const addChapter = (title, html, level) => {
    const index = chapters.length;
    chapters.push({ index, title, html });
    toc.push({ title: title || `Глава ${index + 1}`, chapter: index, fragment: '', level });
    return index;
  };

  const walkSection = (section, level) => {
    const subsections = children(section, 'section');
    const own = { ...section, children: section.children.filter((c) => !(c.type === 'element' && c.name === 'section')) };
    const ownHtml = render(own, level);
    if (!subsections.length) {
      addChapter(sectionTitle(section), ownHtml, level);
      return;
    }
    // Часть, в которой лежат главы: её собственные слова (заголовок, эпиграф)
    // становятся короткой заглавной страницей, а каждая глава — сама по себе.
    if (ownHtml.trim()) addChapter(sectionTitle(section), ownHtml, level);
    else toc.push({ title: sectionTitle(section) || '···', chapter: chapters.length, fragment: '', level });
    for (const sub of subsections) walkSection(sub, level + 1);
  };

  for (const body of main) {
    const sections = children(body, 'section');
    const preamble = { ...body, children: body.children.filter((c) => !(c.type === 'element' && c.name === 'section')) };
    const preambleHtml = render(preamble, 0);
    if (preambleHtml.trim()) addChapter(trimmedText(find(body, 'title')), preambleHtml, 0);
    for (const section of sections) walkSection(section, 0);
  }

  if (!chapters.length) throw new Error('в FB2 нет текста');

  const notes = new Map();
  for (const body of noteBodies) {
    for (const section of findAll(body, 'section')) {
      const id = attr(section, 'id');
      if (id) notes.set(id, render(section, 1));
    }
  }
  if (noteBodies.length) {
    const html = noteBodies.map((b) => render(b, 0)).join('');
    if (html.trim()) addChapter('Примечания', html, 0);
  }

  const coverId = (attr(find(find(titleInfo, 'coverpage'), 'image'), 'href') || '').replace(/^#/, '');
  const cover = coverId && binaries.has(coverId)
    ? { path: coverId, mediaType: binaries.get(coverId).mediaType }
    : null;

  return {
    format: 'fb2',
    meta,
    toc,
    chapters: chapters.map((c) => ({ index: c.index, title: c.title, bytes: c.html.length })),
    cover,
    hasResource: (path) => binaries.has(path),
    resource(path) {
      const binary = binaries.get(decodeURIComponent(path));
      if (!binary) return null;
      return { data: Buffer.from(binary.base64, 'base64'), mediaType: binary.mediaType };
    },
    note: (id) => notes.get(id) || null,
    chapter(index) {
      const chapter = chapters[index];
      if (!chapter) return null;
      return {
        index,
        html: chapter.html,
        text: chapter.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        title: chapter.title,
        headings: [],
      };
    },
  };
}
