// Простой текст, Markdown и просто HTML — документы, которые приезжают вовсе
// без структуры, и её приходится придумать, прежде чем читать их как книгу.

import { decodeText, declaredEncoding } from './encoding.js';
import { renderDocument } from './html.js';

const escapeText = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

// Начала глав на двух языках, которые тут вероятнее всего встретятся, плюс
// одинокая римская цифра — так помечена глава в половине старых .txt.
// `\b` здесь не помощник: после кириллической буквы он не видит границы слова,
// поэтому ключевые слова закрепляются тем, что может идти следом.
const CHAPTER = /^\s*(?:(?:глава|часть|книга|том|раздел|пролог|эпилог|chapter|part|book|prologue|epilogue)(?=$|[\s.:;,№—-])[^\n]{0,80}|[IVXLC]{1,7}\.?|\d{1,3}\.?)\s*$/i;

const isChapterHeading = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return false;
  if (CHAPTER.test(trimmed)) return true;
  // Короткая строка прописными, в которой есть буквы, — это заголовок.
  return trimmed.length <= 60
    && /\p{Lu}/u.test(trimmed)
    && trimmed === trimmed.toUpperCase()
    && /[\p{L}]{3,}/u.test(trimmed);
};

function paragraphsToHtml(lines) {
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const average = buffer.reduce((sum, l) => sum + l.length, 0) / buffer.length;
    // Проза, перенесённая по строкам, склеивается в абзац; стихи сохраняют
    // разбивку. Отличает их вот что: стих короткий *и* каждая строка начинается
    // с прописной, а перенесённый абзац продолжается со строчной.
    const opensWithCapital = buffer.filter((l) => /^[\p{Lu}«"'(\[—-]/u.test(l)).length / buffer.length;
    const verse = buffer.length > 1 && average < 46 && opensWithCapital > 0.6;
    if (buffer.length === 1) blocks.push(`<p>${escapeText(buffer[0])}</p>`);
    else if (verse) blocks.push(`<p class="verse-block">${buffer.map(escapeText).join('<br>')}</p>`);
    else blocks.push(`<p>${escapeText(buffer.join(' '))}</p>`);
    buffer = [];
  };
  for (const line of lines) {
    if (!line.trim()) flush();
    else buffer.push(line.trim());
  }
  flush();
  return blocks.join('');
}

export function readPlainText(buffer, name = '') {
  const source = decodeText(buffer, declaredEncoding(buffer))
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '');
  const lines = source.split('\n');

  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const before = i === 0 || !lines[i - 1].trim();
    const after = i + 1 >= lines.length || !lines[i + 1].trim();
    if (before && after && isChapterHeading(lines[i])) marks.push({ at: i, title: lines[i].trim() });
  }

  // Строка прописными в самом верху — это название книги, а не первая глава;
  // снимаем её с кучи до того, как резать.
  let title = '';
  let start = 0;
  const firstLine = lines.findIndex((l) => l.trim());
  if (marks.length && marks[0].at === firstLine && !CHAPTER.test(lines[firstLine].trim())) {
    title = marks.shift().title;
    start = firstLine + 1;
  }

  const chapters = [];
  if (marks.length >= 3) {
    if (marks[0].at > start) {
      const html = paragraphsToHtml(lines.slice(start, marks[0].at));
      if (html) chapters.push({ title: '', html });
    }
    marks.forEach((mark, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].at : lines.length;
      const html = paragraphsToHtml(lines.slice(mark.at + 1, end));
      chapters.push({ title: mark.title, html: `<h2>${escapeText(mark.title)}</h2>${html}` });
    });
  } else {
    chapters.push({ title: '', html: paragraphsToHtml(lines.slice(start)) });
  }

  return { title, chapters, name };
}

// Маленький Markdown: всё, чем пользуются заметка, README или выгрузка.
export function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const headings = [];
  let list = null;
  let paragraph = [];
  let quote = [];

  const inline = (s) => {
    let out = escapeText(s);
    out = out.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, src) => `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, label, href) => (/^https?:/i.test(href)
      ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label));
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return out;
  };

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) blocks.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushAll();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push(`<pre><code>${escapeText(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const id = `h${headings.length + 1}`;
      const title = heading[2].replace(/#+\s*$/, '').trim();
      headings.push({ id, level, title });
      blocks.push(`<h${level} id="${id}">${inline(title)}</h${level}>`);
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushAll();
      blocks.push('<hr>');
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flushAll();

  return { html: blocks.join(''), headings };
}

export function readMarkdown(buffer, name = '') {
  const source = decodeText(buffer, declaredEncoding(buffer));
  const { html, headings } = renderMarkdown(source);
  const top = Math.min(...headings.map((h) => h.level).concat([1]));

  // Режем по верхнему уровню заголовков, если их больше одного: документ из
  // глав читается лучше главами.
  const parts = html.split(new RegExp(`(?=<h${top} id=)`)).filter(Boolean);
  const chapters = headings.filter((h) => h.level === top).length > 1
    ? parts.map((part) => ({
      title: /<h\d id="h\d+">(.*?)<\/h\d>/s.exec(part)?.[1].replace(/<[^>]+>/g, '').trim() || '',
      html: part,
    }))
    : [{ title: '', html }];

  return {
    title: headings.find((h) => h.level === top)?.title || '',
    chapters,
    headings,
    name,
  };
}

export function readHtmlDocument(buffer, name = '') {
  const source = decodeText(buffer, declaredEncoding(buffer));
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1].trim() || '';
  const { html, headings } = renderDocument(source, {
    resolve: (href) => (/^(https?|mailto):/i.test(href) ? { kind: 'external', url: href } : null),
  });
  return { title, chapters: [{ title: '', html }], headings, name };
}
