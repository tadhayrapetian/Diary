// Сборка: полка, читалка, панели и всё, что между ними.

import { api, settings } from './api.js';
import { Shelf, importFiles } from './shelf.js';
import { Reader, plural } from './reader.js';
import { PdfView } from './pdf-view.js';

const $ = (id) => document.getElementById(id);

const views = { library: $('library'), reader: $('reader') };
const stage = { frame: $('page-frame'), flow: $('flow'), pdf: $('pdf-stage') };
const sheets = { toc: $('sheet-toc'), find: $('sheet-find'), type: $('sheet-type') };
const scrim = $('scrim');
const toastNode = $('toast');
const selectionMenu = $('selection-menu');
const notePopover = $('note-popover');

let books = [];
let lookupEnabled = false;
let current = null;          // { book, structure, mode: 'flow' | 'pdf' }
let toastTimer = null;

// ------------------------------------------------------------------- мелочи

function toast(message, sticky = false) {
  toastNode.textContent = message;
  toastNode.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { toastNode.hidden = true; }, 2200);
}

const escape = (text) => String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function place(node, rect, { below = false } = {}) {
  node.hidden = false;
  const box = node.getBoundingClientRect();
  const gap = 10;
  let top = below ? rect.bottom + gap : rect.top - box.height - gap;
  if (top < 8) top = rect.bottom + gap;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - box.height - 8);
  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;
}

const closePopovers = () => {
  selectionMenu.hidden = true;
  notePopover.hidden = true;
};

function openSheet(sheet) {
  for (const other of Object.values(sheets)) other.hidden = other !== sheet;
  scrim.hidden = false;
  closePopovers();
}

function closeSheets() {
  for (const sheet of Object.values(sheets)) sheet.hidden = true;
  scrim.hidden = true;
}

const ui = {
  busy: (on) => { $('reader-spinner').hidden = !on; },
  toast,
  setChapter: (text) => { $('chapter-label').textContent = text; },
  setPage: (text) => { $('page-label').textContent = text; },
  setBookmark: (on) => { $('bookmark-button').classList.toggle('is-on', Boolean(on)); },
  toggleChrome: () => document.body.classList.toggle('chrome-hidden'),
  note: (html, anchor) => {
    notePopover.innerHTML = html;
    notePopover.hidden = false;
    place(notePopover, anchor.getBoundingClientRect(), { below: true });
  },
};

const reader = new Reader({ frame: stage.frame, flow: stage.flow, ui });
const pdf = new PdfView({ stage: stage.pdf, ui });

// -------------------------------------------------------------------- полка

const shelf = new Shelf({
  root: $('shelf'),
  empty: $('library-empty'),
  onOpen: (id) => openBook(id),
  onMenu: (book, anchor) => bookMenu(book, anchor),
});

async function refresh() {
  const data = await api.library();
  books = data.books;
  lookupEnabled = Boolean(data.lookup);
  shelf.setBooks(books);
}

function bookMenu(book, anchor) {
  closePopovers();
  selectionMenu.innerHTML = `
    <button data-do="open">Читать</button>
    <button data-do="file">Файл</button>
    <button data-do="rename">Переименовать</button>
    <button data-do="delete">Удалить</button>`;
  selectionMenu.hidden = false;
  place(selectionMenu, anchor.getBoundingClientRect(), { below: true });

  selectionMenu.onclick = async (event) => {
    const action = event.target.closest('button')?.dataset.do;
    closePopovers();
    if (action === 'open') openBook(book.id);
    if (action === 'file') window.open(`/api/books/${book.id}/file`, '_blank');
    if (action === 'rename') {
      const title = prompt('Название книги', book.title);
      if (title && title.trim()) {
        const authors = prompt('Автор', book.authors.join(', '));
        await api.patch(book.id, { title: title.trim(), authors: (authors || '').split(',').map((a) => a.trim()).filter(Boolean) });
        await refresh();
      }
    }
    if (action === 'delete') {
      if (!confirm(`Убрать «${book.title}» с полки? Файл будет удалён.`)) return;
      await api.remove(book.id);
      await refresh();
      toast('Убрано с полки');
    }
  };
}

async function addFiles(files) {
  const good = [...files].filter((file) => file.size > 0);
  if (!good.length) return;
  await importFiles(good, {
    onProgress: (message) => toast(message, true),
    onDone: async (added) => {
      await refresh();
      const duplicates = added.filter((entry) => entry.duplicate).length;
      const fresh = added.length - duplicates;
      toast([
        fresh ? `${fresh} ${plural(fresh, 'книга', 'книги', 'книг')} на полке` : '',
        duplicates ? `${duplicates} уже ${plural(duplicates, 'была', 'были', 'были')}` : '',
      ].filter(Boolean).join(', ') || 'Ничего не добавилось');
    },
  });
}

// ------------------------------------------------------------------ книга

async function openBook(id, startAt) {
  const book = books.find((b) => b.id === id);
  if (!book) return;
  closeSheets();
  closePopovers();

  views.library.hidden = true;
  views.reader.hidden = false;
  document.body.classList.remove('chrome-hidden');
  $('reader-title').textContent = book.title;
  history.pushState({ book: id }, '', `#/book/${id}`);

  if (book.format === 'pdf') {
    current = { book, structure: { toc: [], chapters: [] }, mode: 'pdf' };
    stage.frame.hidden = true;
    stage.pdf.hidden = false;
    await pdf.open(book, startAt);
    return;
  }

  stage.pdf.hidden = true;
  stage.frame.hidden = false;
  ui.busy(true);
  const data = await api.book(id);
  current = { book: data.book, structure: data, mode: 'flow' };
  Object.assign(book, data.book);
  reader.applySettings();
  await reader.open(book, data, startAt);
  ui.busy(false);
  setTimeout(() => document.body.classList.add('chrome-hidden'), 1600);
}

function closeBook() {
  if (current?.mode === 'pdf') {
    pdf.flush();
    pdf.close();
  } else if (current?.mode === 'flow') {
    reader.flush();
  }
  current = null;
  views.reader.hidden = true;
  views.library.hidden = false;
  document.body.classList.remove('chrome-hidden');
  closeSheets();
  closePopovers();
  refresh();
}

// ----------------------------------------------------------------- панели

function renderToc() {
  const list = $('toc-list');
  const entries = current?.structure?.toc || [];
  if (!entries.length) {
    list.innerHTML = '<li class="list-empty">В этой книге нет оглавления</li>';
    return;
  }
  list.innerHTML = entries.map((entry) => `
    <li data-level="${Math.min(2, entry.level || 0)}" data-chapter="${entry.chapter}" data-fragment="${escape(entry.fragment || '')}"
        class="${entry.chapter === reader.chapterIndex ? 'is-current' : ''}">
      <a href="#">${escape(entry.title)}</a>
    </li>`).join('');

  for (const item of list.children) {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      closeSheets();
      reader.goTo(Number(item.dataset.chapter), { fragment: item.dataset.fragment || '' });
    });
  }
  list.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
}

function renderBookmarks() {
  const list = $('bookmark-list');
  const marks = [...(current?.book?.bookmarks || [])].sort((a, b) => a.percent - b.percent);
  if (!marks.length) {
    list.innerHTML = '<li class="list-empty">Закладок пока нет. Кнопка сверху ставит закладку на текущей странице.</li>';
    return;
  }
  list.innerHTML = marks.map((mark) => `
    <li data-id="${mark.id}">
      <button type="button">
        <span class="drop" data-drop="${mark.id}">убрать</span>
        <span class="where">${escape(mark.chapterTitle || '')} · ${Math.round(mark.percent)} %</span>
        <span class="quote">${escape(mark.quote || '')}</span>
      </button>
    </li>`).join('');

  for (const item of list.children) {
    item.addEventListener('click', (event) => {
      const mark = marks.find((m) => m.id === item.dataset.id);
      if (event.target.dataset.drop) {
        reader.removeBookmark(mark.id);
        renderBookmarks();
        return;
      }
      closeSheets();
      reader.goTo(mark.chapter, { block: mark.block });
    });
  }
}

function switchTab(name) {
  for (const tab of sheets.toc.querySelectorAll('.tab')) tab.classList.toggle('is-on', tab.dataset.tab === name);
  $('toc-list').hidden = name !== 'toc';
  $('bookmark-list').hidden = name !== 'bookmarks';
  if (name === 'toc') renderToc(); else renderBookmarks();
}

let findTimer = null;
async function runFind(query) {
  const list = $('find-results');
  if (query.trim().length < 2) {
    list.innerHTML = '<li class="list-empty">Введите хотя бы два знака</li>';
    return;
  }
  list.innerHTML = '<li class="list-empty">Ищу…</li>';
  try {
    const { results } = await api.find(current.book.id, query);
    if (!results.length) {
      list.innerHTML = '<li class="list-empty">Ничего не нашлось</li>';
      return;
    }
    const counters = new Map();
    list.innerHTML = results.map((hit) => {
      const seen = counters.get(hit.chapter) || 0;
      counters.set(hit.chapter, seen + 1);
      const snippet = escape(hit.snippet).replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
      return `<li data-chapter="${hit.chapter}" data-occurrence="${seen}">
        <button type="button">
          <span class="where">${escape(hit.chapterTitle || `Глава ${hit.chapter + 1}`)}</span>
          <span class="quote">…${snippet}…</span>
        </button>
      </li>`;
    }).join('');

    for (const item of list.children) {
      item.addEventListener('click', () => {
        closeSheets();
        reader.goTo(Number(item.dataset.chapter), { query, occurrence: Number(item.dataset.occurrence) });
      });
    }
  } catch (error) {
    list.innerHTML = `<li class="list-empty">${escape(error.message)}</li>`;
  }
}

// ------------------------------------------------------------ выделение

function selectionRect() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const node = selection.anchorNode;
  if (!node || !stage.flow.contains(node.nodeType === 1 ? node : node.parentNode)) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

function showSelectionMenu() {
  const rect = selectionRect();
  if (!rect) {
    selectionMenu.hidden = true;
    return;
  }
  const buttons = [
    '<button data-do="copy">Копировать</button>',
    '<button data-do="note">Заметка</button>',
    lookupEnabled ? '<button data-do="define">Значение</button>' : '',
    lookupEnabled ? '<button data-do="translate">Перевод</button>' : '',
    lookupEnabled ? '<button data-do="explain">Объяснить</button>' : '',
  ].filter(Boolean).join('');
  selectionMenu.innerHTML = buttons;
  selectionMenu.hidden = false;
  place(selectionMenu, rect, { below: true });
  selectionMenu.onclick = (event) => onSelectionAction(event, rect);
}

async function onSelectionAction(event, rect) {
  const action = event.target.closest('button')?.dataset.do;
  const selection = window.getSelection();
  const text = selection?.toString().trim() || '';
  if (!action || !text) return;
  selectionMenu.hidden = true;

  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано');
    } catch {
      toast('Браузер не дал скопировать');
    }
    return;
  }
  if (action === 'note') {
    reader.toggleBookmark();
    return;
  }

  const context = (selection.anchorNode?.parentElement?.closest('p, li, blockquote, div')?.textContent || '').trim().slice(0, 1200);
  notePopover.innerHTML = `<div class="lookup-head">${action === 'translate' ? 'Перевод' : action === 'explain' ? 'Объяснение' : 'Значение'}</div><p class="waiting">Смотрю…</p>`;
  notePopover.hidden = false;
  place(notePopover, rect, { below: true });
  try {
    const answer = await api.lookup({
      text,
      context,
      mode: action,
      book: `${current.book.title}${current.book.authors[0] ? ` — ${current.book.authors[0]}` : ''}`,
    });
    notePopover.innerHTML = `<div class="lookup-head">${action === 'translate' ? 'Перевод' : action === 'explain' ? 'Объяснение' : 'Значение'}</div>`
      + answer.text.split(/\n{2,}/).map((part) => `<p>${escape(part)}</p>`).join('');
    place(notePopover, rect, { below: true });
  } catch (error) {
    notePopover.innerHTML = `<p>${escape(error.message)}</p>`;
  }
}

// ------------------------------------------------------------------ связи

function wireLibrary() {
  $('import-button').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });
  $('sort-button').addEventListener('click', (event) => { event.target.textContent = shelf.nextSort(); });
  $('sort-button').textContent = shelf.sort.label;
  $('library-search').addEventListener('input', (event) => shelf.search(event.target.value));

  const veil = $('drop-veil');
  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!views.library.hidden && event.dataTransfer?.types?.includes('Files')) {
      depth += 1;
      veil.hidden = false;
    }
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) veil.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    veil.hidden = true;
    if (views.library.hidden) return;
    addFiles(event.dataTransfer.files);
  });
}

function wireReader() {
  $('back-button').addEventListener('click', () => history.back());
  $('toc-button').addEventListener('click', () => {
    if (current?.mode === 'pdf') return toast('У PDF оглавление внутри самого файла');
    openSheet(sheets.toc);
    switchTab('toc');
  });
  $('find-button').addEventListener('click', () => {
    if (current?.mode === 'pdf') return toast('Поиск по PDF пока не умею');
    openSheet(sheets.find);
    $('find-input').focus();
  });
  $('bookmark-button').addEventListener('click', () => {
    if (current?.mode === 'pdf') return toast('Закладки — в книгах с текстом');
    reader.toggleBookmark();
  });
  $('type-button').addEventListener('click', () => openSheet(sheets.type));

  for (const tab of sheets.toc.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }
  for (const close of document.querySelectorAll('.sheet-close')) close.addEventListener('click', closeSheets);
  scrim.addEventListener('click', closeSheets);

  $('find-input').addEventListener('input', (event) => {
    clearTimeout(findTimer);
    const query = event.target.value;
    findTimer = setTimeout(() => runFind(query), 320);
  });

  document.addEventListener('selectionchange', () => {
    clearTimeout(window.__selectionTimer);
    window.__selectionTimer = setTimeout(showSelectionMenu, 260);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.popover')) closePopovers();
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }
    if (event.key === 'Escape') {
      if (!scrim.hidden) return closeSheets();
      if (!notePopover.hidden || !selectionMenu.hidden) return closePopovers();
      if (!views.reader.hidden) return history.back();
    }
    if (views.reader.hidden) return;
    const view = current?.mode === 'pdf' ? pdf : reader;
    if (['ArrowRight', 'PageDown', ' ', 'j'].includes(event.key)) { event.preventDefault(); view.turn(1); }
    if (['ArrowLeft', 'PageUp', 'k'].includes(event.key)) { event.preventDefault(); view.turn(-1); }
    if (event.key === 't') $('toc-button').click();
    if (event.key === 'b') $('bookmark-button').click();
    if (event.key === 'f') { event.preventDefault(); $('find-button').click(); }
  });

  window.addEventListener('popstate', () => {
    if (!views.reader.hidden) closeBook();
  });
  window.addEventListener('beforeunload', () => {
    if (current?.mode === 'pdf') pdf.flush();
    else if (current) reader.flush();
  });
}

function wireSettings() {
  const apply = () => reader.applySettings();

  for (const dot of $('theme-picker').children) {
    dot.addEventListener('click', () => {
      settings.set('theme', dot.dataset.theme);
      document.body.dataset.theme = dot.dataset.theme;
      for (const other of $('theme-picker').children) other.classList.toggle('is-on', other === dot);
      apply();
    });
  }

  const size = $('font-size');
  const bind = (node, name, transform = Number) => {
    node.addEventListener('input', () => {
      settings.set(name, node.type === 'checkbox' ? node.checked : transform(node.value));
      apply();
    });
  };
  bind(size, 'fontScale');
  bind($('line-height'), 'lineHeight');
  bind($('margins'), 'margins');
  bind($('justify'), 'justify');
  bind($('scroll-mode'), 'scroll');
  $('font-family').addEventListener('change', (event) => {
    settings.set('fontFamily', event.target.value);
    apply();
  });
  $('font-smaller').addEventListener('click', () => {
    size.value = String(Math.max(82, Number(size.value) - 6));
    size.dispatchEvent(new Event('input'));
  });
  $('font-bigger').addEventListener('click', () => {
    size.value = String(Math.min(180, Number(size.value) + 6));
    size.dispatchEvent(new Event('input'));
  });
}

function restoreSettings() {
  document.body.dataset.theme = settings.get('theme');
  $('font-size').value = settings.get('fontScale');
  $('line-height').value = settings.get('lineHeight');
  $('margins').value = settings.get('margins');
  $('justify').checked = settings.get('justify');
  $('scroll-mode').checked = settings.get('scroll');
  $('font-family').value = settings.get('fontFamily');
  for (const dot of $('theme-picker').children) dot.classList.toggle('is-on', dot.dataset.theme === settings.get('theme'));
}

// ------------------------------------------------------------------ старт

restoreSettings();
wireLibrary();
wireReader();
wireSettings();

await refresh();

const opening = /^#\/book\/([a-z0-9]+)/i.exec(location.hash);
if (opening && books.some((book) => book.id === opening[1])) {
  history.replaceState({}, '', '#');
  openBook(opening[1]);
}
