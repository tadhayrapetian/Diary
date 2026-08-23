import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoteStore, TEXT_LIMIT, noteId } from './store.js';
import { toMarkdown } from './export.js';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'notes-'));
  const file = join(dir, 'notes.json');
  const store = new NoteStore(file);
  await store.load();
  return { store, file, dir };
}

// ------------------------------------------------------------------ the basics

test('a note survives being written and read back', async () => {
  const { store, file } = await freshStore();
  const made = store.create({ text: 'купить хлеб' });
  await store.save();

  const reopened = new NoteStore(file);
  const { count } = await reopened.load();

  assert.equal(count, 1);
  assert.deepEqual(reopened.get(made.id), made);
});

test('an empty note is not a note', async () => {
  const { store } = await freshStore();
  assert.equal(store.create({ text: '   \n\t ' }), null);
  assert.equal(store.create({ text: '' }), null);
  assert.equal(store.create({}), null);
  assert.equal(store.create({ text: 42 }), null);
  assert.equal(store.list().length, 0);
});

test('an update to nothing is refused, and leaves the note as it was', async () => {
  const { store } = await freshStore();
  const note = store.create({ text: 'важное' });
  assert.equal(store.update(note.id, { text: '  ' }), null);
  assert.equal(store.get(note.id).text, 'важное');
});

test('updating an unknown id reports it rather than inventing a note', async () => {
  const { store } = await freshStore();
  assert.equal(store.update('нет-такого', { text: 'привет' }), null);
  assert.equal(store.remove('нет-такого'), null);
  assert.equal(store.list().length, 0);
});

test('text is normalised and capped', async () => {
  const { store } = await freshStore();
  const crlf = store.create({ text: 'первая\r\nвторая\rтретья' });
  assert.equal(crlf.text, 'первая\nвторая\nтретья');

  const huge = store.create({ text: 'я'.repeat(TEXT_LIMIT + 5000) });
  assert.equal(huge.text.length, TEXT_LIMIT);
});

test('editing moves a note up the list; pinning lifts it without touching it', async (t) => {
  // Real clocks are too fast here: two notes made in the same millisecond have
  // nothing to sort by. A fake one puts real gaps between the writes.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { store } = await freshStore();

  const first = store.create({ text: 'старая' });
  t.mock.timers.tick(1000);
  const second = store.create({ text: 'новая' });
  const ids = () => store.list().map((note) => note.id);
  assert.deepEqual(ids(), [second.id, first.id]);

  t.mock.timers.tick(1000);
  store.update(first.id, { text: 'старая, но тронутая' });
  assert.deepEqual(ids(), [first.id, second.id]);

  t.mock.timers.tick(1000);
  store.update(second.id, { pinned: true });
  assert.deepEqual(ids(), [second.id, first.id]);
  assert.equal(store.get(second.id).updated, second.updated, 'закрепление — не правка');

  store.update(second.id, { pinned: false });
  assert.deepEqual(ids(), [first.id, second.id], 'и открепление возвращает на место');
});

test('an identical edit does not count as a change', async () => {
  const { store } = await freshStore();
  const note = store.create({ text: 'то же самое' });
  const again = store.update(note.id, { text: 'то же самое' });
  assert.equal(again.updated, note.updated);
});

// ------------------------------------------------------------------ deleting

test('a deleted note comes back exactly where it was', async () => {
  const { store } = await freshStore();
  const note = store.create({ text: 'случайно удалю' });
  const removed = store.remove(note.id);
  assert.equal(store.list().length, 0);

  const back = store.create({
    id: removed.id,
    text: removed.text,
    created: removed.created,
    pinned: removed.pinned,
  });
  assert.equal(back.id, note.id);
  assert.equal(back.created, note.created);
  assert.equal(store.list().length, 1);
});

test('restoring onto a taken id does not overwrite the note holding it', async () => {
  const { store } = await freshStore();
  const original = store.create({ text: 'я тут первый' });
  const intruder = store.create({ id: original.id, text: 'а я подменю' });

  assert.notEqual(intruder.id, original.id);
  assert.equal(store.get(original.id).text, 'я тут первый');
  assert.equal(store.list().length, 2);
});

// ------------------------------------------------------------------ the file

test('writing is atomic and leaves no litter', async () => {
  const { store, file, dir } = await freshStore();
  store.create({ text: 'на диск' });
  await store.save();

  const left = await readdir(dir);
  assert.deepEqual(left, ['notes.json'], 'the temporary file must be gone');

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.notes.length, 1);
});

test('a burst of saves collapses, and the last state is the one on disk', async () => {
  const { store, file } = await freshStore();
  const note = store.create({ text: 'раз' });

  const waits = [];
  for (const text of ['два', 'три', 'четыре']) {
    store.update(note.id, { text });
    waits.push(store.save());
  }
  await Promise.all(waits);

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.notes[0].text, 'четыре');
});

test('a save started during a save still lands', async () => {
  const { store, file } = await freshStore();
  const note = store.create({ text: 'первое' });
  const early = store.save();

  store.update(note.id, { text: 'второе' });
  await store.save();
  await early;

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.notes[0].text, 'второе');
});

test('a missing file is an empty notebook, and its folder is made on the way', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-'));
  const file = join(dir, 'nested', 'deeper', 'notes.json');

  const store = new NoteStore(file);
  assert.deepEqual(await store.load(), { count: 0, quarantined: null });

  store.create({ text: 'создаст и папку тоже' });
  await store.save();

  const reopened = new NoteStore(file);
  assert.equal((await reopened.load()).count, 1);
  assert.equal(reopened.list()[0].text, 'создаст и папку тоже');
});

test('a corrupt file is moved aside, never overwritten', async () => {
  const { store, file, dir } = await freshStore();
  await writeFile(file, '{ это не json', 'utf8');

  const { count, quarantined } = await store.load();
  assert.equal(count, 0);
  assert.ok(quarantined, 'the unreadable file must be kept');
  assert.equal(await readFile(quarantined, 'utf8'), '{ это не json');

  store.create({ text: 'жизнь продолжается' });
  await store.save();
  assert.equal((await readdir(dir)).length, 2);
});

test('rubbish inside a readable file is dropped, not spread', async () => {
  const { store, file } = await freshStore();
  const shared = noteId();
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      notes: [
        { id: shared, text: 'настоящая' },
        { id: shared, text: 'дубликат' },
        { id: 'x1', text: '   ' },
        null,
        'строка',
        { id: 'x2', text: 'вторая настоящая', created: 111, updated: 222, pinned: true },
      ],
    }),
    'utf8',
  );

  const { count } = await store.load();
  assert.equal(count, 2);
  assert.equal(store.get(shared).text, 'настоящая');

  const revived = store.get('x2');
  assert.deepEqual(revived, { id: 'x2', text: 'вторая настоящая', created: 111, updated: 222, pinned: true });
});

test('a note read back from a bare array still loads', async () => {
  const { store, file } = await freshStore();
  await writeFile(file, JSON.stringify([{ id: 'a', text: 'старый формат' }]), 'utf8');
  const { count } = await store.load();
  assert.equal(count, 1);
});

test('the caller cannot reach into the store', async () => {
  const { store } = await freshStore();
  const note = store.create({ text: 'не трогай' });
  store.list()[0].text = 'тронул';
  store.get(note.id).text = 'и ещё раз';
  assert.equal(store.get(note.id).text, 'не трогай');
});

test('ids stay unique with the clock standing still', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { store } = await freshStore();

  for (let i = 0; i < 2000; i += 1) store.create({ text: `заметка ${i}` });

  const ids = new Set(store.list().map((note) => note.id));
  assert.equal(ids.size, 2000);
  assert.ok(noteId(1_700_000_000_000).startsWith((1_700_000_000_000).toString(36)));
});

// ------------------------------------------------------------------ export

test('markdown export carries every note, pins marked', () => {
  const notes = [
    { id: 'a', text: 'первая', created: 0, updated: 1_700_000_000_000, pinned: true },
    { id: 'b', text: 'вторая\nв две строки', created: 0, updated: 1_700_000_100_000, pinned: false },
  ];
  const md = toMarkdown(notes, 1_700_000_200_000);

  assert.match(md, /^# Заметки/);
  assert.match(md, /всего: 2/);
  assert.ok(md.includes('первая'));
  assert.ok(md.includes('вторая\nв две строки'));
  assert.equal(md.match(/^---$/gm).length, 2);
  assert.ok(md.includes('📌'));
});
