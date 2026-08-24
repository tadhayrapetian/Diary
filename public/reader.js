// Читалка.
//
// Страница — это колонка. Текст льётся в CSS-колонки шириной со страницу, а
// перелистывание — это сдвиг всей ленты на одну ширину. Отсюда все размеры:
// поле M с каждой стороны, промежуток между колонками 2M, и тогда шаг между
// страницами всегда равен ширине окна — и для одной колонки, и для разворота.

import { api, settings, lastPlace } from './api.js';

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table, img, figure, .verse, .verse-block, .empty-line';

export class Reader {
  constructor({ frame, flow, ui }) {
    this.frame = frame;
    this.flow = flow;
    this.ui = ui;                 // { setChapter, setPage, setBookmark, toast, note, busy }
    this.book = null;
    this.structure = null;
    this.chapters = [];
    this.total = 1;
    this.chapterTitle = '';
    this.chapterIndex = 0;
    this.page = 0;
    this.pages = 1;
    this.cache = new Map();
    this.saveTimer = null;
    this.#listen();
  }

  // ------------------------------------------------------------- открытие

  async open(book, structure, place) {
    this.book = book;
    this.structure = structure;
    this.cache.clear();
    this.chapters = structure.chapters || [];
    this.total = this.chapters.reduce((sum, c) => sum + Math.max(400, c.bytes || 0), 0) || 1;
    const start = place || lastPlace.get(book.id) || book.progress || { chapter: 0, offset: 0 };
    await this.goTo(Number(start.chapter) || 0, { block: Number(start.offset) || 0 });
  }

  async chapterHtml(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const chapter = await api.chapter(this.book.id, index);
    if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(index, chapter);
    return chapter;
  }

  /**
   * Перейти в главу. `target` говорит, куда именно:
   * { block } — к блоку с таким номером, { fragment } — к якорю,
   * { end: true } — на последнюю страницу, { query, occurrence } — к найденному.
   */
  async goTo(index, target = {}) {
    const clamped = Math.max(0, Math.min(index, this.chapters.length - 1));
    if (!this.chapters.length) return;
    this.ui.busy(true);
    let chapter;
    try {
      chapter = await this.chapterHtml(clamped);
    } catch (error) {
      this.ui.toast(error.message);
      this.ui.busy(false);
      return;
    }
    this.chapterIndex = clamped;
    this.flow.innerHTML = chapter.html || '<p class="chapter-end">···</p>';
    this.chapterTitle = chapter.title || this.chapters[clamped]?.title || '';
    this.#markBlocks();
    this.#watchImages();
    this.layout({ restore: false });

    if (target.fragment) this.#toElement(this.flow.querySelector(`#${CSS.escape(target.fragment)}`));
    else if (target.query) this.#toMatch(target.query, target.occurrence || 0);
    else if (target.end) this.goToPage(this.pages - 1, false);
    else if (target.block) this.#toBlock(target.block);
    else this.goToPage(0, false);

    this.ui.busy(false);
    this.#report();
  }

  // ------------------------------------------------------------- раскладка

  applySettings() {
    const root = document.documentElement;
    root.style.setProperty('--font-scale', settings.get('fontScale') / 100);
    root.style.setProperty('--line-height', settings.get('lineHeight') / 100);
    this.flow.dataset.font = settings.get('fontFamily');
    this.flow.classList.toggle('ragged', !settings.get('justify'));
    document.body.classList.toggle('scrolling', Boolean(settings.get('scroll')));
    this.layout();
  }

  layout({ restore = true } = {}) {
    const block = restore ? this.currentBlock() : null;
    const width = this.frame.clientWidth;
    const height = this.frame.clientHeight;
    if (!width) return;

    this.margin = Math.round(Math.min(120, Math.max(18, (width * settings.get('margins')) / 100)));
    this.columns = !settings.get('scroll') && width >= 780 ? 2 : 1;
    this.stride = width;

    const style = this.flow.style;
    style.paddingLeft = `${this.margin}px`;
    style.paddingRight = `${this.margin}px`;

    if (settings.get('scroll')) {
      style.columnCount = '1';
      style.columnGap = '0';
      style.height = 'auto';
      style.transform = 'none';
      this.pages = 1;
    } else {
      const gap = this.margin * 2;
      style.columnCount = String(this.columns);
      style.columnGap = `${gap}px`;

      // Высота колонки — целое число строк: иначе последняя строка страницы
      // обрезается пополам, и это первое, что видно.
      style.height = `${height}px`;
      const line = parseFloat(getComputedStyle(this.flow).lineHeight);
      if (Number.isFinite(line) && line > 4) {
        style.height = `${Math.max(line, Math.floor(height / line) * line)}px`;
      }

      // Сколько получилось колонок: ширина ленты за вычетом левого поля, делённая
      // на «колонка плюс промежуток». Страница — это одна колонка или две.
      const column = (width - this.margin * 2 - gap * (this.columns - 1)) / this.columns;
      const spread = Math.max(0, this.flow.scrollWidth - this.margin);
      const columns = Math.max(1, Math.round((spread + gap) / (column + gap)));
      this.pages = Math.max(1, Math.ceil(columns / this.columns));

      // Картинка или таблица может выехать дальше, чем считает арифметика, —
      // спросим последний блок, на какой он странице.
      const last = this.blocks?.[this.blocks.length - 1];
      if (last) this.pages = Math.max(this.pages, this.#pageOf(last) + 1);

      this.page = Math.min(this.page, this.pages - 1);
      this.goToPage(this.page, false);
    }

    if (block !== null) this.#toBlock(block, false);
    this.#report();
  }

  goToPage(page, animate = true) {
    if (settings.get('scroll')) return;
    this.page = Math.max(0, Math.min(page, this.pages - 1));
    this.flow.classList.toggle('animate', animate);
    this.flow.style.transform = `translateX(${-this.page * this.stride}px)`;
    this.#report();
    this.#save();
  }

  /** Листнуть. За краем главы — соседняя глава. */
  async turn(delta) {
    if (settings.get('scroll')) {
      const step = this.frame.clientHeight * 0.9;
      const before = this.frame.scrollTop;
      this.frame.scrollBy({ top: delta * step, behavior: 'smooth' });
      if (delta > 0 && before + step >= this.frame.scrollHeight - this.frame.clientHeight - 4) {
        if (this.chapterIndex < this.chapters.length - 1) await this.goTo(this.chapterIndex + 1);
      } else if (delta < 0 && before <= 2 && this.chapterIndex > 0) {
        await this.goTo(this.chapterIndex - 1, { end: true });
      }
      return;
    }
    const next = this.page + delta;
    if (next < 0) {
      if (this.chapterIndex > 0) await this.goTo(this.chapterIndex - 1, { end: true });
      else this.ui.toast('Это самое начало');
      return;
    }
    if (next > this.pages - 1) {
      if (this.chapterIndex < this.chapters.length - 1) await this.goTo(this.chapterIndex + 1);
      else this.ui.toast('Книга кончилась');
      return;
    }
    this.goToPage(next);
  }

  // ------------------------------------------------------------ положение

  #markBlocks() {
    this.blocks = [...this.flow.querySelectorAll(BLOCKS)];
    this.blocks.forEach((node, index) => { node.dataset.b = index; });
  }

  #watchImages() {
    // Картинки приходят после текста и меняют разбивку — пересчитать, когда всё
    // догрузится, но не чаще раза в кадр.
    let timer = null;
    for (const image of this.flow.querySelectorAll('img')) {
      if (image.complete) continue;
      image.addEventListener('load', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.layout(), 120);
      }, { once: true });
      image.addEventListener('error', () => image.remove(), { once: true });
    }
  }

  /** Номер блока, с которого начинается текущая страница. */
  currentBlock() {
    if (!this.blocks?.length) return 0;
    if (settings.get('scroll')) {
      const top = this.frame.getBoundingClientRect().top;
      const found = this.blocks.find((node) => node.getBoundingClientRect().bottom > top + 4);
      return found ? Number(found.dataset.b) : 0;
    }
    const left = this.frame.getBoundingClientRect().left;
    const found = this.blocks.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.right > left + 2 && rect.width > 0;
    });
    return found ? Number(found.dataset.b) : 0;
  }

  #pageOf(node) {
    if (!node) return 0;
    const x = node.getBoundingClientRect().left - this.frame.getBoundingClientRect().left + this.page * this.stride;
    return Math.max(0, Math.floor((x - this.margin + 4) / this.stride));
  }

  #toBlock(index, animate = false) {
    const node = this.blocks?.[Math.min(index, (this.blocks?.length || 1) - 1)];
    this.#toElement(node, animate);
  }

  #toElement(node, animate = false) {
    if (!node) return;
    if (settings.get('scroll')) {
      this.frame.scrollTop += node.getBoundingClientRect().top - this.frame.getBoundingClientRect().top - 12;
      this.#report();
      this.#save();
      return;
    }
    this.goToPage(this.#pageOf(node), animate);
  }

  /** Подсветить нужное вхождение и открыть страницу с ним. */
  #toMatch(query, occurrence) {
    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(this.flow, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.toLowerCase();
      let at = text.indexOf(needle);
      while (at !== -1) {
        if (seen === occurrence) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const mark = document.createElement('mark');
          mark.className = 'hit';
          try {
            range.surroundContents(mark);
          } catch {
            this.#toElement(node.parentElement);
            return;
          }
          this.#markBlocks();
          this.#toElement(mark);
          setTimeout(() => {
            if (!mark.isConnected) return;
            mark.replaceWith(...mark.childNodes);
          }, 6000);
          return;
        }
        seen += 1;
        at = text.indexOf(needle, at + needle.length);
      }
    }
  }

  get percent() {
    if (!this.chapters.length) return 0;
    const before = this.chapters.slice(0, this.chapterIndex)
      .reduce((sum, c) => sum + Math.max(400, c.bytes || 0), 0);
    const current = Math.max(400, this.chapters[this.chapterIndex]?.bytes || 0);
    const within = settings.get('scroll')
      ? this.frame.scrollTop / Math.max(1, this.frame.scrollHeight - this.frame.clientHeight)
      : this.page / Math.max(1, this.pages);
    return Math.min(100, ((before + current * (Number.isFinite(within) ? within : 0)) / this.total) * 100);
  }

  place() {
    return {
      chapter: this.chapterIndex,
      offset: this.currentBlock(),
      percent: this.percent,
      label: this.chapterTitle || '',
    };
  }

  #report() {
    if (!this.chapters.length) return;
    const left = this.pages - this.page - 1;
    this.frame.dataset.page = String(this.page + 1);
    this.frame.dataset.pages = String(this.pages);
    this.frame.dataset.chapter = String(this.chapterIndex);
    this.ui.setChapter(this.chapterTitle || `Глава ${this.chapterIndex + 1}`);
    this.ui.setPage(settings.get('scroll')
      ? `${Math.round(this.percent)} %`
      : `${left > 0 ? `осталось ${left} ${plural(left, 'страница', 'страницы', 'страниц')}` : 'конец главы'} · ${Math.round(this.percent)} %`);
    this.ui.setBookmark(this.hasBookmark());
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      if (!this.book) return;
      const place = this.place();
      lastPlace.set(this.book.id, place);
      try {
        const { book } = await api.patch(this.book.id, { progress: place });
        Object.assign(this.book, book);
      } catch { /* сеть моргнула — место всё равно сохранено локально */ }
    }, 900);
  }

  flush() {
    clearTimeout(this.saveTimer);
    if (!this.book) return null;
    const place = this.place();
    lastPlace.set(this.book.id, place);
    api.saveProgress(this.book.id, place);
    return place;
  }

  // ------------------------------------------------------------- закладки

  hasBookmark() {
    const block = this.currentBlock();
    return (this.book?.bookmarks || []).some((mark) => mark.chapter === this.chapterIndex
      && Math.abs(mark.block - block) <= 1);
  }

  toggleBookmark() {
    if (!this.book) return false;
    const block = this.currentBlock();
    const marks = this.book.bookmarks || [];
    const existing = marks.find((mark) => mark.chapter === this.chapterIndex && Math.abs(mark.block - block) <= 1);
    if (existing) {
      this.book.bookmarks = marks.filter((mark) => mark !== existing);
      this.ui.toast('Закладка снята');
    } else {
      const node = this.blocks?.[block];
      this.book.bookmarks = [...marks, {
        id: `${Date.now().toString(36)}`,
        chapter: this.chapterIndex,
        block,
        percent: this.percent,
        chapterTitle: this.chapterTitle,
        quote: (node?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        createdAt: new Date().toISOString(),
      }];
      this.ui.toast('Закладка поставлена');
    }
    api.patch(this.book.id, { bookmarks: this.book.bookmarks }).catch(() => {});
    this.ui.setBookmark(this.hasBookmark());
    return this.hasBookmark();
  }

  removeBookmark(id) {
    if (!this.book) return;
    this.book.bookmarks = (this.book.bookmarks || []).filter((mark) => mark.id !== id);
    api.patch(this.book.id, { bookmarks: this.book.bookmarks }).catch(() => {});
    this.ui.setBookmark(this.hasBookmark());
  }

  // ------------------------------------------------------------- события

  #listen() {
    let start = null;

    this.flow.addEventListener('click', (event) => {
      const link = event.target.closest('a');
      if (!link) return;
      event.preventDefault();
      this.#openLink(link);
    });

    this.frame.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY, at: Date.now(), moved: false };
    });

    this.frame.addEventListener('pointermove', (event) => {
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8) start.moved = true;
    });

    this.frame.addEventListener('pointerup', (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const quick = Date.now() - start.at < 600;
      const selection = window.getSelection();
      start = null;

      if (event.target.closest('a')) return;      // ссылками занимается click
      if (selection && !selection.isCollapsed) return;

      // Свайп листает, короткое касание по краю листает, по середине —
      // показывает полосы управления. Так же, как в Books.
      if (quick && Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        this.turn(dx < 0 ? 1 : -1);
        return;
      }
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;

      const zone = (event.clientX - this.frame.getBoundingClientRect().left) / this.frame.clientWidth;
      if (zone < 0.28) this.turn(-1);
      else if (zone > 0.72) this.turn(1);
      else this.ui.toggleChrome();
    });

    this.frame.addEventListener('scroll', () => {
      if (!settings.get('scroll')) return;
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        this.#report();
        this.#save();
      }, 180);
    }, { passive: true });

    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.layout(), 160);
    });
  }

  async #openLink(link) {
    const external = link.getAttribute('target') === '_blank';
    if (external) {
      window.open(link.href, '_blank', 'noopener');
      return;
    }
    const note = link.dataset.note;
    if (note) {
      try {
        const { html } = await api.note(this.book.id, note);
        this.ui.note(html, link);
      } catch {
        this.ui.toast('Примечание не найдено');
      }
      return;
    }
    if (link.dataset.chapter !== undefined) {
      const chapter = Number(link.dataset.chapter);
      const fragment = link.dataset.fragment || '';
      // Сноска — это ссылка на короткий кусок в другом файле. Такое показываем
      // на месте, а не уводим со страницы.
      if (fragment) {
        try {
          const target = await this.chapterHtml(chapter < 0 ? this.chapterIndex : chapter);
          const parsed = new DOMParser().parseFromString(target.html, 'text/html');
          const node = parsed.getElementById(fragment);
          const text = node?.textContent?.trim() || '';
          if (node && text.length < 700) {
            this.ui.note(node.outerHTML, link);
            return;
          }
        } catch { /* ниже просто перейдём */ }
      }
      if (chapter < 0 || chapter === this.chapterIndex) this.#toElement(this.flow.querySelector(`#${CSS.escape(fragment)}`), true);
      else this.goTo(chapter, { fragment });
    }
  }
}

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
