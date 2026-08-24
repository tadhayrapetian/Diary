// Полка: обложки, порядок, добавление файлов.

import { api, settings } from './api.js';

const SORTS = [
  { key: 'recent', label: 'Недавние', compare: (a, b) => date(b.openedAt || b.addedAt) - date(a.openedAt || a.addedAt) },
  { key: 'added', label: 'По добавлению', compare: (a, b) => date(b.addedAt) - date(a.addedAt) },
  { key: 'title', label: 'По названию', compare: (a, b) => a.title.localeCompare(b.title, 'ru') },
  { key: 'author', label: 'По автору', compare: (a, b) => (a.authors[0] || 'яяя').localeCompare(b.authors[0] || 'яяя', 'ru') },
];

const date = (value) => (value ? new Date(value).getTime() : 0);

// Обложка, которой нет: цвет выводится из названия, поэтому одна и та же книга
// всегда одного цвета, а полка не выглядит как таблица.
const PALETTE = [
  ['#7d4b3c', '#4a2a24'], ['#3b5266', '#1f2f3d'], ['#4f5f3e', '#2b3524'],
  ['#6b4a6e', '#3a2740'], ['#8a6a30', '#4f3b18'], ['#3f5e5a', '#223735'],
  ['#7a3f4a', '#42212a'], ['#4a4f6b', '#282b3f'],
];

const hash = (text) => {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
};

function drawnCover(book) {
  const [from, to] = PALETTE[hash(book.title + (book.authors[0] || '')) % PALETTE.length];
  const author = book.authors[0] || '';
  return `<div class="cover-drawn" style="background:linear-gradient(160deg,${from},${to})">
    <div class="t">${escape(book.title)}</div>
    <div>
      ${author ? `<div class="a">${escape(author)}</div>` : ''}
      <div class="k">${escape(book.label || '')}</div>
    </div>
  </div>`;
}

const escape = (text) => String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Shelf {
  constructor({ root, empty, onOpen, onMenu }) {
    this.root = root;
    this.empty = empty;
    this.onOpen = onOpen;
    this.onMenu = onMenu;
    this.books = [];
    this.query = '';
  }

  get sort() {
    return SORTS.find((s) => s.key === settings.get('sort')) || SORTS[0];
  }

  nextSort() {
    const at = SORTS.findIndex((s) => s.key === this.sort.key);
    const next = SORTS[(at + 1) % SORTS.length];
    settings.set('sort', next.key);
    this.render();
    return next.label;
  }

  setBooks(books) {
    this.books = books;
    this.render();
  }

  search(query) {
    this.query = query.trim().toLowerCase();
    this.render();
  }

  visible() {
    const found = this.query
      ? this.books.filter((book) => `${book.title} ${book.authors.join(' ')} ${book.series}`.toLowerCase().includes(this.query))
      : this.books;
    return [...found].sort(this.sort.compare);
  }

  render() {
    const books = this.visible();
    this.root.innerHTML = books.map((book) => this.card(book)).join('');
    this.empty.hidden = books.length > 0 || Boolean(this.query);

    for (const node of this.root.querySelectorAll('.book')) {
      const { id } = node.dataset;
      node.addEventListener('click', (event) => {
        if (event.target.closest('.book-menu')) {
          this.onMenu(this.books.find((b) => b.id === id), event.target.closest('.book-menu'));
          return;
        }
        this.onOpen(id);
      });
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.onMenu(this.books.find((b) => b.id === id), node);
      });
    }
  }

  card(book) {
    const percent = Math.round(book.progress?.percent || 0);
    const drawn = !book.cover;
    const cover = drawn
      ? drawnCover(book)
      : `<img src="/api/books/${book.id}/cover" alt="" loading="lazy">`;
    return `<button class="book" data-id="${book.id}" type="button">
      <div class="cover">
        ${cover}
        ${drawn ? '' : `<span class="badge">${escape(book.label || '')}</span>`}
        <span class="book-menu" role="button" aria-label="Ещё">···</span>
        ${percent > 0 ? `<span class="book-progress"><i style="width:${Math.min(100, percent)}%"></i></span>` : ''}
      </div>
      <div class="book-title">${escape(book.title)}</div>
      <div class="book-author">${escape(book.authors.join(', ') || book.series || '')}</div>
    </button>`;
  }
}

/** Загрузка файлов с показом, что происходит. */
export async function importFiles(files, { onProgress, onDone }) {
  const list = [...files];
  const added = [];
  let index = 0;
  for (const file of list) {
    index += 1;
    onProgress?.(`${list.length > 1 ? `${index} из ${list.length}: ` : ''}${file.name}`);
    try {
      const { book, duplicate } = await api.upload(file);
      added.push({ book, duplicate });
    } catch (error) {
      onProgress?.(`${file.name}: ${error.message}`, true);
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
  }
  onDone?.(added);
  return added;
}
