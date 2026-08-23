import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Library } from '../server/jobs.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'lectern-jobs-'));

test('a job is written to disk as it goes', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const job = library.create({ mode: 'translate', title: 'A Book', pieces: 3 });

    library.append(job, 'TITLE A Book\n');
    library.append(job, 'P One.\n');
    library.flush(job);

    assert.equal(readFileSync(join(dir, `${job.id}.txt`), 'utf8'), 'TITLE A Book\nP One.\n');
    assert.equal(library.protocol(job.id), 'TITLE A Book\nP One.\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text not yet flushed is still part of the job', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const job = library.create({});
    library.append(job, 'P Still in hand.\n');
    assert.match(library.protocol(job.id), /Still in hand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page that arrives late gets everything, then the rest live', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const job = library.create({ mode: 'typeset', pieces: 2 });
    library.append(job, 'TITLE Half done\n');

    const seen = [];
    const detach = library.attach(job.id, (name, data) => seen.push([name, data]));

    assert.equal(seen[0][0], 'start');
    assert.equal(seen[1][0], 'text');
    assert.equal(seen[1][1].text, 'TITLE Half done\n', 'caught up in one go');
    assert.equal(seen[2][0], 'progress');

    library.append(job, 'P And the rest.\n');
    assert.deepEqual(seen.at(-1), ['text', { text: 'P And the rest.\n' }]);

    library.finish(job, 'done');
    assert.equal(seen.at(-1)[0], 'done');

    detach();
    library.append(job, 'P Nobody hears this.\n');
    assert.ok(!seen.some(([, data]) => data?.text?.includes('Nobody hears')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attaching to something already finished replays it and says so', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const job = library.create({});
    library.append(job, 'TITLE Finished\n');
    library.finish(job, 'done');

    const seen = [];
    library.attach(job.id, (name, data) => seen.push([name, data]));
    assert.equal(seen[0][1].resumed, true);
    assert.equal(seen[1][1].text, 'TITLE Finished\n');
    assert.equal(seen.at(-1)[0], 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('work survives the server stopping, and is marked as cut short', () => {
  const dir = freshDir();
  try {
    const first = new Library(dir);
    const job = first.create({ mode: 'translate', title: 'Half a Book', pieces: 9 });
    first.append(job, 'TITLE Half a Book\nP Chapter one.\n');
    first.flush(job);
    first.save(job);

    // The process dies here, mid-run. A new server reads the shelf back.
    const second = new Library(dir);
    const found = second.list().find((piece) => piece.id === job.id);
    assert.equal(found.status, 'stopped', 'not left pretending to be running');
    assert.match(found.message, /server stopped/);
    assert.match(second.protocol(job.id), /Chapter one\./, 'the work itself is intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('taking a piece off the shelf takes its files too', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const job = library.create({});
    library.append(job, 'P Gone soon.\n');
    library.flush(job);

    assert.ok(existsSync(join(dir, `${job.id}.txt`)));
    assert.equal(library.remove(job.id), true);
    assert.ok(!existsSync(join(dir, `${job.id}.txt`)));
    assert.ok(!existsSync(join(dir, `${job.id}.json`)));
    assert.equal(library.get(job.id), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopping a run tells whoever is watching', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const controller = new AbortController();
    const job = library.create({ controller });

    const seen = [];
    library.attach(job.id, (name) => seen.push(name));
    assert.equal(library.cancel(job.id), true);
    assert.ok(controller.signal.aborted, 'the run itself is told to stop');
    assert.equal(seen.at(-1), 'failed');
    assert.equal(library.cancel(job.id), false, 'stopping twice does nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shelf shows newest first, without the text', () => {
  const dir = freshDir();
  try {
    const library = new Library(dir);
    const older = library.create({ title: 'Older' });
    older.at = Date.now() - 60_000;
    const newer = library.create({ title: 'Newer' });
    library.append(newer, 'P A lot of text.\n');

    const list = library.list();
    assert.deepEqual(list.map((piece) => piece.title), ['Newer', 'Older']);
    assert.ok(!('protocol' in list[0]), 'the shelf is a list, not a load');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
