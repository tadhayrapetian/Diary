// Полка: файлы на диске, маленький указатель рядом с ними и разбор, который
// превращает одно в другое.
//
// По умолчанию всё лежит в `library/` рядом с программой, обычными файлами:
// книга ровно в том виде, в каком её принесли, её обложка, её оглавление и
// место, на котором вы остановились. Никакой базы данных — поэтому библиотеку
// можно скопировать на другую машину через cp -r, и она останется библиотекой.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { readEpub } from './epub.js';
import { readFb2 } from './fb2.js';
import { readDocx } from './docx.js';
import { readPdfInfo } from './pdf.js';
import { readPlainText, readMarkdown, readHtmlDocument } from './text.js';
import { looksLikeZip } from './zip.js';
import { extensionOf, mediaTypeFor } from './paths.js';

const FORMATS = {
  epub: 'EPUB', fb2: 'FB2', zip: 'FB2', pdf: 'PDF', docx: 'DOCX',
  txt: 'TXT', md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML',
};

export const SUPPORTED = ['epub', 'fb2', 'fb2.zip', 'pdf', 'docx', 'txt', 'md', 'html'];

const atomicWrite = async (file, data) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, file);
};

/** Что это за документ — сначала по содержимому, потом уже по имени. */
export function detectFormat(buffer, filename = '') {
  const name = filename.toLowerCase();
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (looksLikeZip(buffer)) {
    const head = buffer.subarray(0, 2000).toString('latin1');
    if (head.includes('mimetypeapplication/epub+zip') || name.endsWith('.epub')) return 'epub';
    if (head.includes('word/') || name.endsWith('.docx')) return 'docx';
    if (name.endsWith('.fb2.zip') || name.endsWith('.zip')) return 'fb2';
    return 'epub';
  }
  const head = buffer.subarray(0, 1000).toString('latin1');
  if (/<FictionBook/i.test(head) || name.endsWith('.fb2')) return 'fb2';
  if (/^\s*<(?:!doctype\s+html|html)\b/i.test(head) || name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md';
  return 'txt';
}

// Документ, главы которого мы собрали сами (текст, markdown, docx), говорит на
// том же языке, что и остальные читалки форматов.
function staticDocument(format, meta, chapters, toc, extras = {}) {
  return {
    format,
    meta,
    chapters: chapters.map((c, index) => ({ index, title: c.title, bytes: c.html.length })),
    toc,
    cover: null,
    hasResource: () => false,
    resource: () => null,
    ...extras,
    chapter(index) {
      const chapter = chapters[index];
      if (!chapter) return null;
      return {
        index,
        html: chapter.html,
        text: chapter.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        title: chapter.title,
        headings: chapter.headings || [],
      };
    },
  };
}

const emptyMeta = () => ({
  title: '', authors: [], language: '', publisher: '', description: '',
  subjects: [], date: '', identifier: '', series: '', seriesIndex: '',
});

/** Разобрать файл в то, что понимает читалка. */
export function parseDocument(buffer, format, { filename = '', resourceBase = '' } = {}) {
  switch (format) {
    case 'epub':
      return readEpub(buffer, { resourceBase });
    case 'fb2':
      return readFb2(buffer, { resourceBase });
    case 'docx':
      return readDocx(buffer, { resourceBase });
    case 'md': {
      const doc = readMarkdown(buffer, filename);
      return staticDocument('md', { ...emptyMeta(), title: doc.title }, doc.chapters,
        doc.chapters.map((c, index) => ({ title: c.title || 'Начало', chapter: index, fragment: '', level: 0 })));
    }
    case 'html': {
      const doc = readHtmlDocument(buffer, filename);
      const toc = (doc.headings || []).map((h) => ({ title: h.title, chapter: 0, fragment: h.id, level: Math.max(0, h.level - 1) }));
      return staticDocument('html', { ...emptyMeta(), title: doc.title }, doc.chapters, toc);
    }
    case 'pdf': {
      const info = readPdfInfo(buffer);
      return staticDocument('pdf', { ...emptyMeta(), title: info.title, authors: info.authors }, [], [], { pages: info.pages, encrypted: info.encrypted });
    }
    default: {
      const doc = readPlainText(buffer, filename);
      return staticDocument('txt', { ...emptyMeta(), title: doc.title }, doc.chapters,
        doc.chapters.map((c, index) => ({ title: c.title || `Часть ${index + 1}`, chapter: index, fragment: '', level: 0 })));
    }
  }
}

const titleFromFilename = (filename) => filename
  .replace(/\.[a-z0-9]+$/i, '')
  .replace(/\.fb2$/i, '')
  .replace(/[_]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export class Library {
  /** @param {string} root папка, где лежат файлы, обложки и указатель */
  constructor(root) {
    this.root = root;
    this.files = path.join(root, 'files');
    this.covers = path.join(root, 'covers');
    this.structures = path.join(root, 'books');
    this.index = [];
    this.open = new Map();          // id -> разобранная книга, держим тёплой
    this.saving = null;
  }

  async init() {
    for (const dir of [this.root, this.files, this.covers, this.structures]) {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    }
    const indexFile = path.join(this.root, 'index.json');
    if (existsSync(indexFile)) {
      try {
        this.index = JSON.parse(await readFile(indexFile, 'utf8'));
      } catch {
        // Обрезанный указатель не должен стоить нам книг. Собираем заново по
        // тому, что есть на диске, а сломанный оставляем на память.
        await rename(indexFile, `${indexFile}.broken`).catch(() => {});
        this.index = await this.#rebuild();
        await this.save();
      }
    }
    return this;
  }

  async #rebuild() {
    const rebuilt = [];
    for (const name of await readdir(this.structures).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const structure = JSON.parse(await readFile(path.join(this.structures, name), 'utf8'));
        if (structure.record) rebuilt.push(structure.record);
      } catch { /* skip */ }
    }
    return rebuilt;
  }

  save() {
    // Склеиваем очереди записей, которые сыплются при перелистывании.
    if (this.saving) return this.saving;
    this.saving = new Promise((resolve) => setTimeout(resolve, 40)).then(async () => {
      this.saving = null;
      await atomicWrite(path.join(this.root, 'index.json'), JSON.stringify(this.index, null, 1));
    });
    return this.saving;
  }

  get(id) {
    return this.index.find((book) => book.id === id) || null;
  }

  filePath(record) {
    return path.join(this.files, `${record.id}.${record.extension}`);
  }

  async structure(id) {
    const file = path.join(this.structures, `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  }

  async writeStructure(id, structure) {
    await atomicWrite(path.join(this.structures, `${id}.json`), JSON.stringify(structure));
  }

  /**
   * Взять файл на полку: понять, что это, прочитать, что он о себе говорит,
   * сохранить обложку и запомнить, куда он лёг.
   */
  async add(buffer, filename) {
    const id = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const existing = this.get(id);
    if (existing) return { book: existing, duplicate: true };

    const format = detectFormat(buffer, filename);
    const extension = format === 'fb2' && looksLikeZip(buffer) ? 'fb2.zip' : (extensionOf(filename) || format);
    const document = parseDocument(buffer, format, { filename, resourceBase: `/api/books/${id}/res/` });

    const record = {
      id,
      format,
      label: FORMATS[extensionOf(filename)] || FORMATS[format] || format.toUpperCase(),
      extension,
      filename,
      size: buffer.length,
      addedAt: new Date().toISOString(),
      openedAt: null,
      title: (document.meta.title || titleFromFilename(filename) || 'Без названия').slice(0, 300),
      authors: (document.meta.authors || []).filter(Boolean).slice(0, 8),
      language: document.meta.language || '',
      series: document.meta.series || '',
      seriesIndex: document.meta.seriesIndex || '',
      publisher: document.meta.publisher || '',
      description: (document.meta.description || '').slice(0, 4000),
      subjects: document.meta.subjects || [],
      pages: document.pages || 0,
      chapters: document.chapters.length,
      cover: null,
      progress: { chapter: 0, offset: 0, percent: 0, updatedAt: null, label: '' },
      bookmarks: [],
    };

    await mkdir(this.files, { recursive: true });
    await writeFile(this.filePath(record), buffer);

    if (document.cover) {
      const resource = document.resource(document.cover.path);
      if (resource) {
        const kind = mediaTypeFor(document.cover.path).split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        const coverName = `${id}.${kind || 'jpg'}`;
        await writeFile(path.join(this.covers, coverName), resource.data);
        record.cover = coverName;
      }
    }

    await this.writeStructure(id, {
      record,
      chapters: document.chapters,
      toc: document.toc,
    });

    this.index.unshift(record);
    await this.save();
    this.open.set(id, document);
    return { book: record, duplicate: false };
  }

  /** Разобранная книга — из памяти или с диска. */
  async document(id) {
    if (this.open.has(id)) return this.open.get(id);
    const record = this.get(id);
    if (!record) return null;
    const file = this.filePath(record);
    if (!existsSync(file)) return null;
    const buffer = await readFile(file);
    const document = parseDocument(buffer, record.format, {
      filename: record.filename,
      resourceBase: `/api/books/${id}/res/`,
    });
    // Две книги открыты разом — человек сравнивает; десять — это уже утечка.
    if (this.open.size >= 3) this.open.delete(this.open.keys().next().value);
    this.open.set(id, document);
    return document;
  }

  async update(id, patch) {
    const record = this.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    await this.save();
    return record;
  }

  async remove(id) {
    const record = this.get(id);
    if (!record) return false;
    this.index = this.index.filter((book) => book.id !== id);
    this.open.delete(id);
    await rm(this.filePath(record), { force: true });
    await rm(path.join(this.structures, `${id}.json`), { force: true });
    if (record.cover) await rm(path.join(this.covers, record.cover), { force: true });
    await this.save();
    return true;
  }
}
