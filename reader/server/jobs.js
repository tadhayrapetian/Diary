/**
 * The library, and the work in progress.
 *
 * Translating a book is twenty minutes of work and real money, so it does not
 * belong to a browser tab. A run is a job: it starts, it finishes whether or not
 * anyone is watching, and what it produces is written to disk as it goes. A page
 * that reloads mid-book re-attaches and catches up; a page that never comes back
 * still finds the book waiting on the shelf.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

const FLUSH_MS = 2000;
const MAX_PIECES = 200;
const MAX_BYTES = 400 * 1024 * 1024;

export class Library {
  constructor(dir) {
    this.dir = dir;
    this.jobs = new Map();
    try {
      mkdirSync(dir, { recursive: true });
      this.load();
    } catch (error) {
      console.error('[lectern] could not open the library:', error.message);
    }
  }

  load() {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8'));
        if (!record?.id) continue;
        // Anything still marked running was cut off when the server stopped.
        // What it had done by then is on disk and still worth reading.
        if (record.status === 'running') {
          record.status = 'stopped';
          record.message = 'The server stopped while this was still being worked on.';
        }
        record.listeners = new Set();
        record.pending = '';
        record.controller = null;
        this.jobs.set(record.id, record);
      } catch {
        /* a half-written record is not worth crashing over */
      }
    }
    this.prune();
  }

  paths(id) {
    return { record: join(this.dir, `${id}.json`), text: join(this.dir, `${id}.txt`) };
  }

  create(spec) {
    const job = {
      id: crypto.randomBytes(9).toString('hex'),
      mode: spec.mode || 'typeset',
      title: spec.title || '',
      sourceLang: spec.sourceLang || '',
      targetLang: spec.targetLang || '',
      words: spec.words || 0,
      pieces: spec.pieces || 1,
      progress: { piece: 0, of: spec.pieces || 1 },
      status: 'running',
      message: '',
      at: Date.now(),
      finishedAt: 0,
      bytes: 0,
      listeners: new Set(),
      pending: '',
      controller: spec.controller || null,
    };
    this.jobs.set(job.id, job);
    try {
      writeFileSync(this.paths(job.id).text, '');
    } catch {
      /* the run can still stream even if the disk will not take it */
    }
    this.save(job);
    this.prune();
    return job;
  }

  get(id) {
    return this.jobs.get(String(id || '')) || null;
  }

  /** What the shelf shows: newest first, without the text itself. */
  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.at - a.at)
      .map((job) => ({
        id: job.id,
        mode: job.mode,
        title: job.title,
        sourceLang: job.sourceLang,
        targetLang: job.targetLang,
        words: job.words,
        pieces: job.pieces,
        progress: job.progress,
        status: job.status,
        message: job.message,
        at: job.at,
      }));
  }

  protocol(id) {
    const job = this.get(id);
    if (!job) return null;
    let stored = '';
    try {
      stored = readFileSync(this.paths(id).text, 'utf8');
    } catch {
      stored = '';
    }
    return stored + job.pending;
  }

  // --------------------------------------------------------------- writing

  append(job, text) {
    if (!text) return;
    job.pending += text;
    job.bytes += text.length;
    for (const listener of job.listeners) listener('text', { text });
    if (!job.flushTimer) {
      job.flushTimer = setTimeout(() => this.flush(job), FLUSH_MS);
    }
  }

  flush(job) {
    clearTimeout(job.flushTimer);
    job.flushTimer = null;
    if (!job.pending) return;
    const text = job.pending;
    job.pending = '';
    try {
      // Appending by hand keeps the file valid at every moment, which is the
      // point: a crash leaves a readable book, not a broken one.
      const path = this.paths(job.id).text;
      const existing = (() => {
        try {
          return readFileSync(path);
        } catch {
          return Buffer.alloc(0);
        }
      })();
      writeFileSync(path, Buffer.concat([existing, Buffer.from(text, 'utf8')]));
    } catch (error) {
      console.error('[lectern] could not write the library:', error.message);
      job.pending = text + job.pending;
    }
  }

  progress(job, progress) {
    job.progress = progress;
    for (const listener of job.listeners) listener('progress', progress);
    this.save(job);
  }

  finish(job, status, message = '') {
    job.status = status;
    job.message = message;
    job.finishedAt = Date.now();
    job.controller = null;
    this.flush(job);
    this.save(job);
    for (const listener of job.listeners) listener(status === 'done' ? 'done' : 'failed', { message });
  }

  save(job) {
    const { listeners, pending, controller, flushTimer, ...record } = job;
    try {
      writeFileSync(this.paths(job.id).record, JSON.stringify(record));
    } catch {
      /* the run matters more than the bookkeeping */
    }
  }

  // -------------------------------------------------------------- attaching

  /**
   * Catch a page up and then keep it up. Everything already produced is sent
   * first, so a reload rebuilds the whole article before the live text resumes.
   *
   * @returns {() => void} detach
   */
  attach(id, send) {
    const job = this.get(id);
    if (!job) return null;

    send('start', {
      id: job.id,
      mode: job.mode,
      sourceLang: job.sourceLang,
      targetLang: job.targetLang,
      pieces: job.pieces,
      words: job.words,
      status: job.status,
      resumed: job.status !== 'running' || job.bytes > 0,
    });

    const sofar = this.protocol(id);
    if (sofar) send('text', { text: sofar });
    send('progress', job.progress);

    if (job.status !== 'running') {
      send(job.status === 'done' ? 'done' : 'failed', { message: job.message });
      return () => {};
    }

    job.listeners.add(send);
    return () => job.listeners.delete(send);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job || job.status !== 'running') return false;
    job.controller?.abort();
    this.finish(job, 'stopped', 'Stopped.');
    return true;
  }

  remove(id) {
    const job = this.get(id);
    if (!job) return false;
    job.controller?.abort();
    clearTimeout(job.flushTimer);
    this.jobs.delete(job.id);
    for (const path of Object.values(this.paths(job.id))) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  /** Keep the shelf from growing without end. Oldest finished work goes first. */
  prune() {
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => a.at - b.at);

    let total = 0;
    for (const job of this.jobs.values()) {
      try {
        total += statSync(this.paths(job.id).text).size;
      } catch {
        /* counted as nothing */
      }
    }

    while (
      finished.length &&
      (this.jobs.size > MAX_PIECES || total > MAX_BYTES)
    ) {
      const oldest = finished.shift();
      try {
        total -= statSync(this.paths(oldest.id).text).size;
      } catch {
        /* nothing to subtract */
      }
      this.remove(oldest.id);
    }
  }
}
