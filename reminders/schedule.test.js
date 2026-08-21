/**
 * node --test reminders/schedule.test.js
 *
 * The clock is held still here on purpose. Every awkward case this program has
 * is a timing case — a laptop asleep for a day, a lesson added twenty minutes
 * before it starts, a calendar that briefly reads empty — and none of them can
 * be reproduced by waiting for them to happen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, plan, prune, recordSent, sentKey } from './schedule.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-03-03T09:00:00Z');

function student(name, extra = {}) {
  return {
    id: name.toLowerCase(),
    name,
    match: [name],
    remind: [1440, 60],
    calendars: [],
    telegram: { chatId: 100 },
    paused: false,
    ...extra,
  };
}

function roster(students, extra = {}) {
  return {
    timezone: 'Europe/Moscow',
    remind: [1440, 60],
    notifyChanges: true,
    templates: {},
    students,
    ...extra,
  };
}

function lesson(start, { uid = 'u1', summary = 'Аня' } = {}) {
  return { uid, key: `${uid}|${start}`, start, end: start + HOUR, summary, location: '', calendar: 'Уроки' };
}

const names = (sends) => sends.map((s) => `${s.student.name}@${s.minutes}${s.catchUp ? '+' : ''}`);

test('the hour-before reminder goes out once, and not again', () => {
  const lessons = [lesson(NOW + HOUR)];
  const state = emptyState();
  const first = plan({ lessons, roster: roster([student('Аня')]), state, now: NOW });
  assert.deepEqual(names(first.sends), ['Аня@60']);

  for (const send of first.sends) recordSent(state, { ...send, sent: true });
  const second = plan({ lessons, roster: roster([student('Аня')]), state, now: NOW + 5 * MIN });
  assert.deepEqual(second.sends, []);
});

test('nothing goes out before its moment', () => {
  const result = plan({
    lessons: [lesson(NOW + 3 * HOUR)],
    roster: roster([student('Аня')]),
    now: NOW,
  });
  assert.deepEqual(result.sends, []);
});

test('nothing goes out about a lesson that has already begun', () => {
  const result = plan({
    lessons: [lesson(NOW - MIN), lesson(NOW + MIN, { uid: 'u2' })],
    roster: roster([student('Аня')]),
    now: NOW,
  });
  assert.deepEqual(result.sends, []);
});

test('a reminder missed while nothing was running is still sent if it is fresh', () => {
  const result = plan({
    lessons: [lesson(NOW + 20 * MIN)], // the hour mark passed 40 minutes ago
    roster: roster([student('Аня')]),
    now: NOW,
    grace: HOUR,
  });
  assert.deepEqual(names(result.sends), ['Аня@60']);
});

test('a lesson added at the last minute still gets one reminder, once', () => {
  const lessons = [lesson(NOW + 20 * MIN)];
  const state = emptyState();
  const result = plan({ lessons, roster: roster([student('Аня')]), state, now: NOW, grace: 5 * MIN });
  assert.deepEqual(names(result.sends), ['Аня@20+']); // caught up, and honest about the time left

  for (const send of result.sends) recordSent(state, { ...send, sent: true });
  for (const { key, start } of result.spent) state.sent[key] = { at: NOW, start, sent: false };
  const again = plan({ lessons, roster: roster([student('Аня')]), state, now: NOW + MIN, grace: 5 * MIN });
  assert.deepEqual(again.sends, []);
});

test('a reminder long past its moment is written off in silence', () => {
  const state = emptyState();
  // The day-before mark passed four hours ago, but the hour-before one is
  // still ahead: nothing is said now, and the usual reminder follows later.
  const lessons = [lesson(NOW + 20 * HOUR)];
  const result = plan({ lessons, roster: roster([student('Аня')]), state, now: NOW, grace: HOUR });
  assert.deepEqual(result.sends, []);
  assert.equal(result.spent.length, 1);
  assert.match(result.spent[0].key, /1440$/);

  for (const { key, start } of result.spent) state.sent[key] = { at: NOW, start, sent: false };
  const later = plan({ lessons, roster: roster([student('Аня')]), state, now: NOW + 19 * HOUR, grace: HOUR });
  assert.deepEqual(names(later.sends), ['Аня@60']);
});

test('when two reminders come due together only the nearest is sent', () => {
  const lessons = [lesson(NOW + 30 * MIN)];
  const student1 = student('Аня', { remind: [90, 45] });
  const result = plan({ lessons, roster: roster([student1]), state: emptyState(), now: NOW, grace: 2 * HOUR });
  assert.deepEqual(names(result.sends), ['Аня@45']);
  assert.equal(result.spent.length, 1);
  assert.match(result.spent[0].key, /90$/);
});

test('a lesson that moves is a new lesson, and gets its own reminder', () => {
  const state = emptyState();
  const before = lesson(NOW + HOUR);
  const first = plan({ lessons: [before], roster: roster([student('Аня')]), state, now: NOW });
  for (const send of first.sends) recordSent(state, { ...send, sent: true });

  const after = lesson(NOW + 3 * HOUR); // same uid, new start
  const second = plan({ lessons: [after], roster: roster([student('Аня')]), state, now: NOW + 2 * HOUR });
  assert.deepEqual(names(second.sends), ['Аня@60']);
});

test('students who are paused or not linked hear nothing', () => {
  const result = plan({
    lessons: [lesson(NOW + HOUR, { summary: 'Аня и Олег и Катя' })],
    roster: roster([
      student('Аня', { paused: true }),
      student('Олег', { telegram: null }),
      student('Катя'),
    ]),
    now: NOW,
  });
  assert.deepEqual(names(result.sends), ['Катя@60']);
});

test('a lesson only counts as cancelled after it is missing twice', () => {
  const start = NOW + 30 * HOUR;
  const state = emptyState();
  const seen = {
    key: `u1|${start}`,
    uid: 'u1',
    start,
    summary: 'Аня',
    students: ['аня'],
    missing: 0,
  };
  state.seen[seen.key] = seen;

  // Календарь не пустой — в нём есть другой урок, значит чтение состоялось.
  const others = [lesson(NOW + 50 * HOUR, { uid: 'u9' })];
  const once = plan({ lessons: others, roster: roster([student('Аня')]), state, now: NOW });
  assert.deepEqual(once.changes, []);
  assert.equal(once.seen[seen.key].missing, 1);

  state.seen = once.seen;
  const twice = plan({ lessons: others, roster: roster([student('Аня')]), state, now: NOW });
  assert.equal(twice.changes.length, 1);
  assert.equal(twice.changes[0].kind, 'cancelled');
  assert.equal(twice.changes[0].student.name, 'Аня');
});

test('a lesson that reappears elsewhere is a move, not a cancellation', () => {
  const start = NOW + 30 * HOUR;
  const moved = lesson(start + 2 * HOUR);
  const state = emptyState();
  state.seen[`u1|${start}`] = {
    key: `u1|${start}`,
    uid: 'u1',
    start,
    summary: 'Аня',
    students: ['аня'],
    missing: 1,
  };
  const result = plan({ lessons: [moved], roster: roster([student('Аня')]), state, now: NOW });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'moved');
  assert.equal(result.changes[0].newStart, moved.start);
});

test('a calendar that empties out tells the teacher and says nothing to the students', () => {
  const state = emptyState();
  for (let i = 0; i < 5; i += 1) {
    const start = NOW + (30 + i) * HOUR;
    state.seen[`u${i}|${start}`] = {
      key: `u${i}|${start}`,
      uid: `u${i}`,
      start,
      summary: 'Аня',
      students: ['аня'],
      missing: 1,
    };
  }
  const result = plan({ lessons: [], roster: roster([student('Аня')]), state, now: NOW });
  assert.deepEqual(result.changes, []);
  assert.equal(result.vanished.length, 5);
  assert.deepEqual(result.vanished[0].names, ['Аня']);
});

test('a calendar that reads back empty is treated as broken, not as cancelled lessons', () => {
  const start = NOW + 30 * HOUR;
  const state = emptyState();
  state.seen[`u1|${start}`] = { key: `u1|${start}`, uid: 'u1', start, summary: 'Аня', students: ['аня'], missing: 1 };
  const result = plan({ lessons: [], roster: roster([student('Аня')]), state, now: NOW });
  assert.deepEqual(result.changes, []);
  assert.equal(result.vanished.length, 1);
});

test('but one lesson gone from a calendar that still has others is a real cancellation', () => {
  const start = NOW + 30 * HOUR;
  const state = emptyState();
  state.seen[`u1|${start}`] = { key: `u1|${start}`, uid: 'u1', start, summary: 'Аня', students: ['аня'], missing: 1 };
  const result = plan({
    lessons: [lesson(NOW + 50 * HOUR, { uid: 'u9' })],
    roster: roster([student('Аня')]),
    state,
    now: NOW,
  });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'cancelled');
});

test('notifyChanges: false keeps quiet about cancellations', () => {
  const start = NOW + 30 * HOUR;
  const state = emptyState();
  state.seen[`u1|${start}`] = { key: `u1|${start}`, uid: 'u1', start, summary: 'Аня', students: ['аня'], missing: 1 };
  const result = plan({
    lessons: [],
    roster: roster([student('Аня')], { notifyChanges: false }),
    state,
    now: NOW,
  });
  assert.deepEqual(result.changes, []);
});

test('a lesson nobody was told about is never announced as cancelled', () => {
  // Nothing was ever sent, so nothing entered `seen` — and so nothing is said.
  const state = emptyState();
  const first = plan({ lessons: [lesson(NOW + 30 * HOUR)], roster: roster([student('Аня')]), state, now: NOW });
  assert.deepEqual(first.sends, []);
  assert.deepEqual(Object.keys(state.seen), []);
  const second = plan({ lessons: [], roster: roster([student('Аня')]), state, now: NOW });
  assert.deepEqual(second.changes, []);
});

test('a sent reminder is remembered per student, lesson and offset', () => {
  const state = emptyState();
  const one = lesson(NOW + HOUR);
  recordSent(state, { key: sentKey('аня', one.key, 60), lesson: one, student: student('Аня'), sent: true });
  assert.equal(state.sent[`аня|${one.key}|60`].sent, true);
  assert.deepEqual(state.seen[one.key].students, ['аня']);
});

test('old records are dropped, current ones are kept', () => {
  const state = emptyState();
  const old = lesson(NOW - 30 * 24 * HOUR, { uid: 'old' });
  const soon = lesson(NOW + HOUR, { uid: 'soon' });
  recordSent(state, { key: 'a', lesson: old, student: student('Аня'), sent: true });
  recordSent(state, { key: 'b', lesson: soon, student: student('Аня'), sent: true });
  prune(state, { now: NOW });
  assert.deepEqual(Object.keys(state.sent), ['b']);
  assert.deepEqual(Object.keys(state.seen), [soon.key]);
});
