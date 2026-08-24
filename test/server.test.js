// Живой сервер: настоящий процесс, настоящие запросы, настоящая полка в /tmp.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeEpub, makeFb2 } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4351 + (process.pid % 120);
const base = `http://127.0.0.1:${PORT}`;

let server;
let library;

const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/api/library`);
      if (response.ok) return;
    } catch { /* ещё не поднялся */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
};

before(async () => {
  library = await mkdtemp(path.join(tmpdir(), 'polka-http-'));
  server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIBRARY_DIR: library, ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => console.error(String(chunk)));
  await waitForServer();
});

after(async () => {
  server?.kill();
  await rm(library, { recursive: true, force: true });
});

const upload = async (buffer, filename) => {
  const response = await fetch(`${base}/api/books`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(filename) },
    body: buffer,
  });
  return { status: response.status, ...(await response.json()) };
};

test('страница приложения отдаётся', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /<title>Полка<\/title>/);
});

test('книга загружается и появляется на полке', async () => {
  const added = await upload(makeEpub(), 'Тень горы.epub');
  assert.equal(added.status, 201);
  assert.equal(added.book.title, 'Тень горы');

  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  assert.equal(books.length, 1);
  assert.equal(books[0].id, added.book.id);

  const again = await upload(makeEpub(), 'дубль.epub');
  assert.equal(again.duplicate, true);
});

test('оглавление, глава, картинка и обложка отдаются', async () => {
  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  const { id } = books[0];

  const info = await fetch(`${base}/api/books/${id}`).then((r) => r.json());
  assert.equal(info.toc.length, 3);

  const chapter = await fetch(`${base}/api/books/${id}/chapter/0`).then((r) => r.json());
  assert.match(chapter.html, /Глава первая/);
  assert.equal(chapter.title, 'Глава первая');

  const image = await fetch(`${base}/api/books/${id}/res/OEBPS/images/cover.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const cover = await fetch(`${base}/api/books/${id}/cover`);
  assert.equal(cover.status, 200);

  const file = await fetch(`${base}/api/books/${id}/file`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(file.status, 206);
  assert.equal((await file.arrayBuffer()).byteLength, 4);
});

test('место в книге сохраняется', async () => {
  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  const { id } = books[0];
  const patched = await fetch(`${base}/api/books/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ progress: { chapter: 1, offset: 3, percent: 48.5, label: 'Глава вторая' } }),
  }).then((r) => r.json());
  assert.equal(patched.book.progress.chapter, 1);
  assert.equal(Math.round(patched.book.progress.percent), 49);
  assert.ok(patched.book.progress.updatedAt);
});

test('маячок при закрытии вкладки сохраняет место', async () => {
  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  const { id } = books[0];
  const beacon = await fetch(`${base}/api/books/${id}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter: 0, offset: 9, percent: 12, label: 'Глава первая' }),
  });
  assert.equal(beacon.status, 204);
  const after = await fetch(`${base}/api/books/${id}`).then((r) => r.json());
  assert.equal(after.book.progress.offset, 9);
  assert.equal(Math.round(after.book.progress.percent), 12);
});

test('поиск по книге находит слово и говорит, в какой оно главе', async () => {
  const added = await upload(makeFb2(), 'шинель.fb2');
  const { results } = await fetch(`${base}/api/books/${added.book.id}/search?q=департаменте`).then((r) => r.json());
  assert.ok(results.length >= 1);
  assert.equal(results[0].chapter, 1);
  assert.match(results[0].snippet, /департаменте/);
});

test('сноска отдаётся отдельно', async () => {
  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  const fb2 = books.find((book) => book.format === 'fb2');
  const note = await fetch(`${base}/api/books/${fb2.id}/note/n1`).then((r) => r.json());
  assert.match(note.html, /Примечание автора/);
});

test('справка без ключа честно отказывается', async () => {
  const response = await fetch(`${base}/api/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'шинель' }),
  });
  assert.equal(response.status, 501);
});

test('за пределы полки выйти нельзя', async () => {
  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  const outside = await fetch(`${base}/api/books/${books[0].id}/res/../../../../etc/passwd`);
  assert.equal(outside.status, 404);

  const traversal = await fetch(`${base}/..%2f..%2fserver/server.js`);
  assert.ok(traversal.status === 404 || traversal.status === 400, `ожидался отказ, пришло ${traversal.status}`);

  const missing = await fetch(`${base}/api/books/неттакой/chapter/0`);
  assert.equal(missing.status, 404);
});

test('книга убирается с полки', async () => {
  const { books } = await fetch(`${base}/api/library`).then((r) => r.json());
  for (const book of books) {
    const removed = await fetch(`${base}/api/books/${book.id}`, { method: 'DELETE' }).then((r) => r.json());
    assert.equal(removed.removed, true);
  }
  const after = await fetch(`${base}/api/library`).then((r) => r.json());
  assert.equal(after.books.length, 0);
});
