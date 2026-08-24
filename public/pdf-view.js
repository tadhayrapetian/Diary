// PDF: страницы здесь — картинки, а не текст, поэтому листается он прокруткой с
// притягиванием к странице. pdf.js берётся из node_modules и не лежит в репозитории;
// если его нет, включается встроенный просмотрщик браузера.

import { api, lastPlace } from './api.js';

// Берём legacy-сборку: она собрана под браузеры на пару лет старше, а Safari на
// планшете почти всегда старше, чем кажется.
const WORKER = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
const LIBRARY = '/vendor/pdfjs/legacy/build/pdf.min.mjs';

let pdfjs = null;

async function load() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(LIBRARY);
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
  return pdfjs;
}

export class PdfView {
  constructor({ stage, ui }) {
    this.stage = stage;
    this.ui = ui;
    this.rendered = new Set();
  }

  async open(book, place) {
    this.book = book;
    this.stage.innerHTML = '';
    this.rendered.clear();
    this.ui.busy(true);

    let library;
    try {
      library = await load();
    } catch {
      this.ui.busy(false);
      this.stage.innerHTML = `<iframe class="pdf-fallback" src="/api/books/${book.id}/file"></iframe>`;
      this.ui.setChapter('PDF');
      this.ui.setPage('встроенный просмотрщик');
      return;
    }

    try {
      this.document = await library.getDocument({
        url: `/api/books/${book.id}/file`,
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      }).promise;
    } catch (error) {
      this.ui.busy(false);
      this.ui.toast(`Не удалось открыть PDF: ${error.message}`);
      return;
    }

    this.count = this.document.numPages;
    if (this.count !== book.pages) api.patch(book.id, { pages: this.count }).catch(() => {});

    // Страница шириной с экран на большом мониторе читается плохо: держим её
    // в размере книги, как в бумажном оригинале.
    const width = Math.min(this.stage.clientWidth - 32, 920);
    const first = await this.document.getPage(1);
    const natural = first.getViewport({ scale: 1 });
    this.scale = Math.min(3, Math.max(0.4, width / natural.width));

    for (let number = 1; number <= this.count; number++) {
      const holder = document.createElement('div');
      holder.className = 'pdf-page';
      holder.dataset.page = String(number);
      holder.style.width = `${Math.round(natural.width * this.scale)}px`;
      holder.style.height = `${Math.round(natural.height * this.scale)}px`;
      holder.innerHTML = `<span class="num">${number}</span>`;
      this.stage.append(holder);
    }

    // Рисуем то, что близко к экрану, и отпускаем то, что далеко: книга в
    // тысячу страниц не должна съедать память.
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const number = Number(entry.target.dataset.page);
        if (entry.isIntersecting) this.#render(number);
        else if (Math.abs(number - this.current) > 6) this.#release(entry.target);
      }
    }, { root: this.stage, rootMargin: '250% 0px' });

    for (const holder of this.stage.children) this.observer.observe(holder);

    this.stage.addEventListener('scroll', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#report(), 140);
    }, { passive: true });

    const start = place || lastPlace.get(book.id) || book.progress || {};
    this.ui.busy(false);
    this.goToPage(Math.max(1, Number(start.chapter) + 1 || 1), false);
    this.#report();
  }

  async #render(number) {
    const holder = this.stage.querySelector(`.pdf-page[data-page="${number}"]`);
    if (!holder || this.rendered.has(number)) return;
    this.rendered.add(number);
    const page = await this.document.getPage(number);
    const viewport = page.getViewport({ scale: this.scale });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext('2d', { alpha: false });
    context.scale(ratio, ratio);
    await page.render({ canvasContext: context, viewport }).promise;
    holder.prepend(canvas);

    // Первая страница заодно становится обложкой на полке.
    if (number === 1 && !this.book.cover) this.#saveCover(canvas);
  }

  #release(holder) {
    const canvas = holder.querySelector('canvas');
    if (!canvas) return;
    this.rendered.delete(Number(holder.dataset.page));
    canvas.remove();
  }

  #saveCover(canvas) {
    const width = 400;
    const thumb = document.createElement('canvas');
    thumb.width = width;
    thumb.height = Math.round((canvas.height / canvas.width) * width);
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    thumb.toBlob((blob) => {
      if (!blob) return;
      api.putCover(this.book.id, blob)
        .then(({ cover }) => { this.book.cover = cover; })
        .catch(() => {});
    }, 'image/png');
  }

  get current() {
    const middle = this.stage.scrollTop + this.stage.clientHeight / 2;
    for (const holder of this.stage.children) {
      if (holder.offsetTop + holder.offsetHeight >= middle) return Number(holder.dataset.page);
    }
    return this.count || 1;
  }

  goToPage(number, smooth = true) {
    const holder = this.stage.querySelector(`.pdf-page[data-page="${number}"]`);
    if (!holder) return;
    this.stage.scrollTo({ top: holder.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
  }

  turn(delta) {
    this.goToPage(Math.min(this.count, Math.max(1, this.current + delta)));
  }

  #report() {
    const number = this.current;
    const percent = (number / (this.count || 1)) * 100;
    this.ui.setChapter(`Страница ${number} из ${this.count}`);
    this.ui.setPage(`${Math.round(percent)} %`);
    const place = { chapter: number - 1, offset: 0, percent, label: `с. ${number}` };
    lastPlace.set(this.book.id, place);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api.patch(this.book.id, { progress: place })
        .then(({ book }) => Object.assign(this.book, book))
        .catch(() => {});
    }, 900);
  }

  flush() {
    if (!this.book || !this.document) return;
    const number = this.current;
    const place = { chapter: number - 1, offset: 0, percent: (number / (this.count || 1)) * 100, label: `с. ${number}` };
    lastPlace.set(this.book.id, place);
    api.saveProgress(this.book.id, place);
  }

  close() {
    this.observer?.disconnect();
    this.document?.destroy?.();
    this.document = null;
    this.stage.innerHTML = '';
  }
}
