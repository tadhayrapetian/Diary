import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Longest single note we keep. Roomy for typing, small enough to keep the file sane. */
export const TEXT_LIMIT = 100_000;

const FILE_VERSION = 1;

/**
 * Time-prefixed id: notes sort by age even without their timestamps, and the
 * random tail keeps two notes written in the same millisecond apart. The store
 * checks the result against what it already holds, so uniqueness is a promise
 * rather than a probability.
 */
export function noteId(now = Date.now()) {
  return `${now.toString(36)}${randomBytes(6).toString('hex')}`;
}

/** Normalised note text, or null if there is nothing worth keeping. */
function cleanText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').slice(0, TEXT_LIMIT);
  return text.trim() ? text : null;
}

function reviveNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  const created = Number.isFinite(raw.created) ? raw.created : Date.now();
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : noteId(created);
  return {
    id,
    text,
    created,
    updated: Number.isFinite(raw.updated) ? raw.updated : created,
    pinned: Boolean(raw.pinned),
  };
}

/** Pinned first, then most recently touched. */
function byRank(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (b.updated !== a.updated) return b.updated - a.updated;
  return b.created - a.created;
}

/**
 * Every note lives in one JSON file. Reads happen once at startup; from then on
 * the array in memory is the truth and the file is caught up behind it.
 *
 * Two things matter about the writing, because losing a note is the only bug
 * this program can have that the user cannot work around:
 *
 *   - it is atomic — a temporary file is written in full and renamed over the
 *     real one, so a crash mid-write leaves the previous version intact;
 *   - it is serialised — writes never overlap, and a burst of edits collapses
 *     into a single follow-up write instead of a queue of them.
 */
export class NoteStore {
  #notes = [];
  #writing = null;
  #queued = false;

  constructor(file) {
    this.file = file;
  }

  /**
   * Reads the file. A missing file is simply an empty store. A corrupt one is
   * moved aside rather than overwritten — a file we cannot parse may still be a
   * file someone can rescue by hand.
   */
  async load() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { count: 0, quarantined: null };
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const quarantined = `${this.file}.corrupt-${Date.now()}`;
      await rename(this.file, quarantined);
      return { count: 0, quarantined };
    }

    const list = Array.isArray(parsed) ? parsed : parsed?.notes;
    const seen = new Set();
    this.#notes = (Array.isArray(list) ? list : [])
      .map(reviveNote)
      .filter((note) => {
        if (!note || seen.has(note.id)) return false;
        seen.add(note.id);
        return true;
      });

    return { count: this.#notes.length, quarantined: null };
  }

  list() {
    return [...this.#notes].sort(byRank).map((note) => ({ ...note }));
  }

  get(id) {
    const note = this.#notes.find((candidate) => candidate.id === id);
    return note ? { ...note } : null;
  }

  /**
   * Adds a note. `id` and `created` may be supplied to put a deleted note back
   * exactly where it was — that is what undo does. A supplied id that is already
   * taken is ignored rather than allowed to overwrite the note holding it.
   */
  create({ text, pinned = false, id, created } = {}) {
    const body = cleanText(text);
    if (!body) return null;

    const now = Date.now();
    const taken = (candidate) => this.#notes.some((note) => note.id === candidate);
    const wanted = typeof id === 'string' && id.trim() ? id.trim().slice(0, 64) : null;
    const born = Number.isFinite(created) ? created : now;

    let fresh = wanted && !taken(wanted) ? wanted : noteId(now);
    while (taken(fresh)) fresh = noteId(now);

    const note = {
      id: fresh,
      text: body,
      created: born,
      updated: now,
      pinned: Boolean(pinned),
    };
    this.#notes.push(note);
    return { ...note };
  }

  /**
   * Applies a patch. Pinning on its own does not count as touching the note, so
   * a pin never reshuffles the list under the reader's hands.
   */
  update(id, patch = {}) {
    const note = this.#notes.find((candidate) => candidate.id === id);
    if (!note) return null;

    if (patch.text !== undefined) {
      const body = cleanText(patch.text);
      if (!body) return null;
      if (body !== note.text) {
        note.text = body;
        note.updated = Date.now();
      }
    }
    if (patch.pinned !== undefined) note.pinned = Boolean(patch.pinned);

    return { ...note };
  }

  remove(id) {
    const index = this.#notes.findIndex((note) => note.id === id);
    if (index === -1) return null;
    const [note] = this.#notes.splice(index, 1);
    return { ...note };
  }

  /**
   * Puts the current state on disk. Callers made to wait during a write share
   * the follow-up one, so the promise never resolves before that caller's own
   * edit has landed.
   */
  save() {
    if (this.#writing) {
      this.#queued = true;
      return this.#writing;
    }
    this.#writing = this.#drain();
    return this.#writing;
  }

  async #drain() {
    try {
      do {
        this.#queued = false;
        await this.#writeOnce();
      } while (this.#queued);
    } finally {
      // Nothing can slip in between the loop test and here: no await separates
      // them, so a save() arriving now correctly starts a fresh write.
      this.#writing = null;
    }
  }

  async #writeOnce() {
    const payload = JSON.stringify(
      { version: FILE_VERSION, saved: Date.now(), notes: this.#notes },
      null,
      2,
    );
    const tmp = `${this.file}.${process.pid}.tmp`;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.file);
  }
}
