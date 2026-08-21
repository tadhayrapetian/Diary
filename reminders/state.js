/**
 * What has already been sent.
 *
 * The one thing this program must never do is remind the same student of the
 * same lesson twice, and the only defence against that is this file surviving a
 * restart. Written whole and moved into place, so a process killed mid-write
 * leaves the previous state intact rather than half a file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { emptyState, prune } from './schedule.js';

export function loadState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return {
      version: 1,
      sent: state.sent && typeof state.sent === 'object' ? state.sent : {},
      seen: state.seen && typeof state.seen === 'object' ? state.seen : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`! ${file} не читается (${error.message}) — начинаю с чистого листа`);
    }
    return emptyState();
  }
}

export function saveState(file, state, { now = Date.now() } = {}) {
  prune(state, { now });
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.state.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}
