// Полка на диске: что кладётся, что достаётся и что остаётся после удаления.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Library } from '../server/library.js';
import { makeEpub, makeFb2, makePdf } from './helpers.js';

const withLibrary = async (run) => {
  const root = await mkdtemp(path.join(tmpdir(), 'polka-'));
  try {
    await run(await new Library(root).init(), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('книга кладётся на полку со всем, что о ней известно', async () => {
  await withLibrary(async (library, root) => {
    const { book, duplicate } = await library.add(makeEpub(), 'Тень горы.epub');
    assert.equal(duplicate, false);
    assert.equal(book.title, 'Тень горы');
    assert.deepEqual(book.authors, ['А. Иванова']);
    assert.equal(book.format, 'epub');
    assert.equal(book.label, 'EPUB');
    assert.equal(book.chapters, 2);
    assert.equal(book.progress.percent, 0);

    assert.ok(existsSync(path.join(root, 'files', `${book.id}.epub`)), 'файл сохранён');
    assert.ok(existsSync(path.join(root, 'covers', book.cover)), 'обложка вынута');
    assert.ok(existsSync(path.join(root, 'index.json')), 'полка записана');

    const structure = await library.structure(book.id);
    assert.equal(structure.toc.length, 3);
    assert.equal(structure.chapters.length, 2);
  });
});

test('тот же файл не ставится на полку дважды', async () => {
  await withLibrary(async (library) => {
    const first = await library.add(makeEpub(), 'книга.epub');
    const second = await library.add(makeEpub(), 'она-же-под-другим-именем.epub');
    assert.equal(second.duplicate, true);
    assert.equal(second.book.id, first.book.id);
    assert.equal(library.index.length, 1);
  });
});

test('имя файла становится названием, если книга молчит о себе', async () => {
  await withLibrary(async (library) => {
    const { book } = await library.add(Buffer.from('просто текст без заголовков'), 'Записки_на_полях.txt');
    assert.equal(book.title, 'Записки на полях');
    assert.equal(book.format, 'txt');
  });
});

test('PDF попадает на полку с числом страниц и без обложки', async () => {
  await withLibrary(async (library) => {
    const { book } = await library.add(makePdf({ title: 'Годовой отчёт', pages: 7 }), 'отчёт.pdf');
    assert.equal(book.title, 'Годовой отчёт');
    assert.equal(book.pages, 7);
    assert.equal(book.cover, null);
  });
});

test('место, на котором остановились, переживает перезапуск', async () => {
  await withLibrary(async (library, root) => {
    const { book } = await library.add(makeFb2(), 'шинель.fb2');
    await library.update(book.id, { progress: { chapter: 2, offset: 5, percent: 61, label: 'Часть вторая' } });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const reopened = await new Library(root).init();
    assert.equal(reopened.index.length, 1);
    assert.equal(reopened.get(book.id).progress.percent, 61);
    assert.equal(reopened.get(book.id).progress.chapter, 2);
  });
});

test('главы читаются по требованию и берутся из уже разобранной книги', async () => {
  await withLibrary(async (library) => {
    const { book } = await library.add(makeEpub(), 'книга.epub');
    library.open.clear();
    const document = await library.document(book.id);
    assert.match(document.chapter(0).html, /Глава первая/);
    assert.equal(document.resource('OEBPS/images/cover.png').mediaType, 'image/png');
  });
});

test('удаление уносит и файл, и обложку, и оглавление', async () => {
  await withLibrary(async (library, root) => {
    const { book } = await library.add(makeEpub(), 'книга.epub');
    assert.equal(await library.remove(book.id), true);
    assert.equal(library.index.length, 0);
    assert.deepEqual(await readdir(path.join(root, 'files')), []);
    assert.deepEqual(await readdir(path.join(root, 'covers')), []);
    assert.deepEqual(await readdir(path.join(root, 'books')), []);
  });
});

test('битый index.json не уносит с собой книги', async () => {
  await withLibrary(async (library, root) => {
    const { book } = await library.add(makeEpub(), 'книга.epub');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, 'index.json'), '{это не json');

    const reopened = await new Library(root).init();
    assert.equal(reopened.index.length, 1);
    assert.equal(reopened.get(book.id).title, 'Тень горы');
    assert.ok(existsSync(path.join(root, 'index.json.broken')));
  });
});
