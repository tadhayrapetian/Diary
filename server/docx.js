// Документы Word: zip, внутри которого word/document.xml — плоская лента
// абзацев. Здесь читается ровно столько, чтобы сохранить заголовки, выделение,
// списки, таблицы, ссылки и картинки — то, что переживает переливание в книгу.

import { openZip } from './zip.js';
import { parseXml, find, findAll, children, attr } from './xml.js';
import { mediaTypeFor } from './paths.js';

const escapeText = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

const HEADING = /^(?:heading|заголовок|título|überschrift)\s*([1-6])$/i;

function headingLevel(paragraph) {
  const style = attr(find(paragraph, 'pstyle'), 'val') || '';
  const match = HEADING.exec(style.replace(/([a-zа-я])(\d)/i, '$1 $2').trim());
  if (match) return Number(match[1]);
  if (/^(title|название)$/i.test(style)) return 1;
  if (/^(subtitle|подзаголовок)$/i.test(style)) return 2;
  const outline = attr(find(paragraph, 'outlinelvl'), 'val');
  if (outline !== undefined && Number(outline) < 6) return Number(outline) + 1;
  return 0;
}

function readRelationships(zip, path) {
  const rels = new Map();
  if (!zip.has(path)) return rels;
  for (const rel of findAll(parseXml(zip.text(path)), 'relationship')) {
    const id = attr(rel, 'Id') || attr(rel, 'id');
    if (id) rels.set(id, { target: attr(rel, 'Target') || '', mode: attr(rel, 'TargetMode') || '' });
  }
  return rels;
}

// Маркированный список отличается от нумерованного только в numbering.xml.
function readNumbering(zip) {
  const formats = new Map();
  if (!zip.has('word/numbering.xml')) return formats;
  try {
    const doc = parseXml(zip.text('word/numbering.xml'));
    const abstract = new Map();
    for (const node of findAll(doc, 'abstractnum')) {
      const id = attr(node, 'abstractNumId');
      const first = children(node, 'lvl')[0];
      abstract.set(id, attr(find(first || node, 'numfmt'), 'val') || 'decimal');
    }
    for (const num of findAll(doc, 'num')) {
      const id = attr(num, 'numId');
      const ref = attr(find(num, 'abstractnumid'), 'val');
      formats.set(id, abstract.get(ref) || 'decimal');
    }
  } catch {
    // Нумерация — приятная мелочь; сломанная не должна стоить нам документа.
  }
  return formats;
}

export function readDocx(buffer, options = {}) {
  const zip = openZip(buffer);
  const documentPath = ['word/document.xml', 'word/document2.xml'].find((p) => zip.has(p))
    || zip.names.find((n) => /^word\/document.*\.xml$/.test(n));
  if (!documentPath) throw new Error('не похоже на DOCX: нет word/document.xml');

  const rels = readRelationships(zip, 'word/_rels/document.xml.rels');
  const numbering = readNumbering(zip);
  const base = options.resourceBase || '';
  const doc = parseXml(zip.text(documentPath));

  const runHtml = (run) => {
    const props = find(run, 'rpr');
    let inner = '';
    for (const child of run.children) {
      if (child.type !== 'element') continue;
      if (child.name === 't') inner += escapeText(child.children.map((c) => (c.type === 'text' ? c.value : '')).join(''));
      else if (child.name === 'br') inner += '<br>';
      else if (child.name === 'tab') inner += ' ';
      else if (child.name === 'drawing' || child.name === 'pict') {
        const blip = find(child, 'blip') || find(child, 'imagedata');
        const id = blip && (attr(blip, 'embed') || attr(blip, 'id'));
        const target = id && rels.get(id)?.target;
        if (target) {
          const path = target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/\.\//g, '/');
          inner += `<img src="${escapeAttr(base + encodeURI(path))}" alt="" loading="lazy">`;
        }
      }
    }
    if (!inner) return '';
    if (find(props, 'vertalign')) {
      const align = attr(find(props, 'vertalign'), 'val');
      if (align === 'superscript') inner = `<sup>${inner}</sup>`;
      if (align === 'subscript') inner = `<sub>${inner}</sub>`;
    }
    const on = (name) => {
      const node = find(props, name);
      return node && attr(node, 'val') !== '0' && attr(node, 'val') !== 'false' && attr(node, 'val') !== 'none';
    };
    if (on('b')) inner = `<strong>${inner}</strong>`;
    if (on('i')) inner = `<em>${inner}</em>`;
    if (on('u')) inner = `<u>${inner}</u>`;
    if (on('strike')) inner = `<s>${inner}</s>`;
    return inner;
  };

  const inlineHtml = (node) => {
    let html = '';
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.name === 'r') html += runHtml(child);
      else if (child.name === 'hyperlink') {
        const target = rels.get(attr(child, 'id'))?.target;
        const label = inlineHtml(child);
        html += target && /^https?:/i.test(target)
          ? `<a href="${escapeAttr(target)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label;
      } else if (child.name === 'ins' || child.name === 'smarttag' || child.name === 'sdt' || child.name === 'sdtcontent' || child.name === 'bookmarkstart') {
        html += inlineHtml(child);
      }
    }
    return html;
  };

  const blocks = [];
  const headings = [];
  let listBuffer = null;

  const flushList = () => {
    if (!listBuffer) return;
    blocks.push(`<${listBuffer.tag}>${listBuffer.items.join('')}</${listBuffer.tag}>`);
    listBuffer = null;
  };

  const paragraph = (node) => {
    const html = inlineHtml(node);
    const level = headingLevel(node);
    const numId = attr(find(node, 'numid'), 'val');

    if (numId !== undefined && !level) {
      const tag = (numbering.get(numId) || 'decimal') === 'bullet' ? 'ul' : 'ol';
      if (!listBuffer || listBuffer.tag !== tag) {
        flushList();
        listBuffer = { tag, items: [] };
      }
      listBuffer.items.push(`<li>${html || ' '}</li>`);
      return;
    }
    flushList();
    if (!html.trim()) {
      blocks.push('<p class="empty-line"> </p>');
      return;
    }
    if (level) {
      const id = `h${headings.length + 1}`;
      headings.push({ id, level, title: html.replace(/<[^>]+>/g, '').trim() });
      blocks.push(`<h${level} id="${id}">${html}</h${level}>`);
      return;
    }
    blocks.push(`<p>${html}</p>`);
  };

  const table = (node) => {
    flushList();
    const rows = children(node, 'tr').map((row) => {
      const cells = children(row, 'tc').map((cell) => {
        const inner = children(cell, 'p').map((p) => inlineHtml(p)).filter(Boolean).join('<br>');
        const span = attr(find(cell, 'gridspan'), 'val');
        return `<td${span && span !== '1' ? ` colspan="${escapeAttr(span)}"` : ''}>${inner || ' '}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    });
    if (rows.length) blocks.push(`<table>${rows.join('')}</table>`);
  };

  const body = find(doc, 'body') || doc;
  for (const child of body.children) {
    if (child.type !== 'element') continue;
    if (child.name === 'p') paragraph(child);
    else if (child.name === 'tbl') table(child);
    else if (child.name === 'sdt') {
      for (const inner of findAll(child, 'p')) paragraph(inner);
    }
  }
  flushList();

  // Свойства документа — если Word вообще их записал.
  const core = zip.has('docProps/core.xml') ? parseXml(zip.text('docProps/core.xml')) : null;
  const coreText = (name) => {
    const node = core && find(core, name);
    return node ? node.children.map((c) => (c.type === 'text' ? c.value : '')).join('').trim() : '';
  };

  // Режем по заголовкам верхнего уровня, чтобы у длинного документа были главы.
  const topLevel = Math.min(...headings.map((h) => h.level).concat([1]));
  const splits = [];
  blocks.forEach((html, i) => {
    const match = /^<h(\d) id="(h\d+)">(.*)<\/h\d>$/s.exec(html);
    if (match && Number(match[1]) === topLevel) splits.push({ at: i, title: match[3].replace(/<[^>]+>/g, '').trim() });
  });

  const chapters = [];
  if (splits.length >= 2) {
    if (splits[0].at > 0) chapters.push({ title: '', html: blocks.slice(0, splits[0].at).join('') });
    splits.forEach((split, i) => {
      const end = i + 1 < splits.length ? splits[i + 1].at : blocks.length;
      chapters.push({ title: split.title, html: blocks.slice(split.at, end).join('') });
    });
  } else {
    chapters.push({ title: '', html: blocks.join('') });
  }

  const toc = chapters.map((c, index) => ({ title: c.title || 'Начало', chapter: index, fragment: '', level: 0 }));
  if (chapters.length === 1) {
    toc.length = 0;
    for (const heading of headings) {
      toc.push({ title: heading.title, chapter: 0, fragment: heading.id, level: Math.max(0, heading.level - topLevel) });
    }
  }

  return {
    format: 'docx',
    meta: {
      title: coreText('title'),
      authors: [coreText('creator')].filter(Boolean),
      language: coreText('language'),
      description: coreText('description'),
      subjects: [],
      date: coreText('created'),
      publisher: '',
      identifier: '',
      series: '',
      seriesIndex: '',
    },
    chapters: chapters.map((c, index) => ({ index, title: c.title, bytes: c.html.length })),
    toc,
    cover: null,
    hasResource: (path) => zip.has(path),
    resource(path) {
      const name = decodeURIComponent(path);
      if (!zip.has(name)) return null;
      return { data: zip.read(name), mediaType: mediaTypeFor(name) };
    },
    chapter(index) {
      const chapter = chapters[index];
      if (!chapter) return null;
      return {
        index,
        html: chapter.html,
        text: chapter.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        title: chapter.title,
        headings: index === 0 ? headings : [],
      };
    },
  };
}
