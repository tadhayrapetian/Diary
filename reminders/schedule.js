/**
 * Deciding what to send, and to whom, right now.
 *
 * Everything here is a pure function of (lessons, roster, state, now), which is
 * the point: the awkward cases in this program are not network cases, they are
 * timing cases — a laptop that was asleep for a day, a lesson added twenty
 * minutes before it starts, a series that moved, a calendar that briefly failed
 * to load. Those are all decided here, where a test can hold the clock still.
 *
 * The rules, in the order they matter:
 *
 *   · A reminder fires once. The key carries the lesson's start time, so a
 *     lesson that moves is a new lesson and gets a fresh reminder.
 *   · A reminder that came due while nothing was running is sent late if it is
 *     still useful, and quietly written off if it is not.
 *   · A lesson that turns up too late for its reminders still gets one — but
 *     only once we are inside the last reminder window, so starting the program
 *     does not fire off a message about every lesson in the coming week.
 *   · Nothing is ever sent about a lesson that has begun.
 *   · A lesson that vanishes from the calendar is only announced as cancelled
 *     after it has been missing from two consecutive readings — and never if a
 *     whole armful goes at once, or if the calendar came back empty, both of
 *     which mean the calendar broke rather than the term ended.
 */

import { matches, reachable } from './roster.js';

const MINUTE = 60000;

/** Do not message anyone about a lesson closer than this — they are already in it. */
export const MIN_LEAD = 3 * MINUTE;

/** How late a reminder may be sent after the moment it was due. */
export const DEFAULT_GRACE = 60 * MINUTE;

/** Readings a lesson must be absent from before it counts as cancelled. */
export const CONFIRMATIONS = 2;

/** More disappearances than this at once is a broken calendar, not a cancelled lesson. */
export const MAX_CHANGES = 3;

export const sentKey = (studentId, lessonKey, minutes) => `${studentId}|${lessonKey}|${minutes}`;

/** An empty state, and the shape every state file has. */
export function emptyState() {
  return { version: 1, sent: {}, seen: {} };
}

function announced(state, studentId, lesson, offsets) {
  return offsets.some((minutes) => state.sent[sentKey(studentId, lesson.key, minutes)]?.sent);
}

/**
 * @returns {{
 *   sends: {key: string, student: object, lesson: object, minutes: number, catchUp: boolean}[],
 *   spent: {key: string, start: number}[],
 *   changes: {kind: 'moved'|'cancelled', student: object, start: number, newStart: number|null, lessonKey: string}[],
 *   seen: object,
 *   vanished: {start: number, summary: string, names: string[]}[],
 *   reason: 'empty'|'many'|null,
 * }}
 */
export function plan({
  lessons,
  roster,
  state = emptyState(),
  now = Date.now(),
  grace = DEFAULT_GRACE,
  confirmations = CONFIRMATIONS,
  maxChanges = MAX_CHANGES,
}) {
  const sends = [];
  const spent = [];

  for (const lesson of lessons) {
    if (lesson.start - now < MIN_LEAD) continue; // under way, or as good as
    for (const student of roster.students) {
      if (!reachable(student)) continue;
      if (!matches(student, lesson)) continue;

      const offsets = student.remind;
      const due = [];
      const missed = [];

      for (const minutes of offsets) {
        const key = sentKey(student.id, lesson.key, minutes);
        if (state.sent[key]) continue;
        const fireAt = lesson.start - minutes * MINUTE;
        if (now < fireAt) continue; // still ahead of us
        if (now - fireAt <= grace) due.push({ key, minutes });
        else missed.push({ key, minutes });
      }

      if (due.length) {
        // Two reminders can come due together after a long sleep; the nearest
        // one is the one worth sending, the rest are written off.
        const send = due.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
        sends.push({ ...send, student, lesson, catchUp: false });
        for (const other of [...due, ...missed]) {
          if (other.key !== send.key) spent.push({ key: other.key, start: lesson.start });
        }
        continue;
      }

      if (!missed.length) continue;

      // Nothing due, but reminders went past unsent — a lesson added minutes
      // before it starts, or a machine that was asleep. Say something now, but
      // only once the nearest reminder window has arrived: at the first run of
      // the day the day-before mark is always behind us, and that is not a
      // reason to message everyone who has a lesson this week.
      const nearest = Math.min(...offsets) * MINUTE;
      const quiet = !announced(state, student.id, lesson, offsets);
      if (quiet && lesson.start - now <= nearest) {
        const minutes = Math.round((lesson.start - now) / MINUTE);
        sends.push({ key: missed[0].key, student, lesson, minutes, catchUp: true });
        for (const other of missed.slice(1)) spent.push({ key: other.key, start: lesson.start });
      } else {
        for (const other of missed) spent.push({ key: other.key, start: lesson.start });
      }
    }
  }

  const { changes, seen, vanished, reason } = watch({
    lessons,
    roster,
    state,
    now,
    confirmations,
    maxChanges,
  });

  return { sends, spent, changes, seen, vanished, reason };
}

/**
 * Lessons that were announced and have since left the calendar.
 *
 * Absence is not read as cancellation on the first sighting: a CalDAV read can
 * come back thin, a calendar can be briefly unshared. Two readings in a row
 * with the lesson gone is the threshold, and a mass disappearance is reported
 * to the teacher instead of being passed on to the students.
 */
export function watch({ lessons, roster, state, now, confirmations = CONFIRMATIONS, maxChanges = MAX_CHANGES }) {
  const present = new Set(lessons.map((lesson) => lesson.key));
  const byUid = new Map();
  for (const lesson of lessons) {
    if (!byUid.has(lesson.uid)) byUid.set(lesson.uid, []);
    byUid.get(lesson.uid).push(lesson);
  }

  const seen = {};
  const gone = [];

  for (const [key, entry] of Object.entries(state.seen || {})) {
    if (entry.start <= now) continue; // it has happened; nothing left to say
    if (present.has(key)) {
      seen[key] = { ...entry, missing: 0 };
      continue;
    }
    const missing = (entry.missing || 0) + 1;
    if (missing < confirmations) {
      seen[key] = { ...entry, missing };
      continue;
    }
    const replacement = (byUid.get(entry.uid) || [])
      .filter((lesson) => lesson.start > now && !state.seen[lesson.key])
      .sort((a, b) => Math.abs(a.start - entry.start) - Math.abs(b.start - entry.start))[0];
    gone.push({ key, entry, newStart: replacement?.start ?? null });
  }

  // An empty reading is the shape a broken calendar takes: the wrong name in
  // APPLE_CALENDARS, a sharing link switched off, a shard that answered with
  // nothing. Cancelling everyone's lesson on the strength of that is the worst
  // thing this program could do, so it goes to the teacher instead.
  const brokenLooking = gone.length > maxChanges || (!lessons.length && gone.length > 0);

  if (!roster.notifyChanges || brokenLooking) {
    return {
      changes: [],
      seen,
      reason: lessons.length ? 'many' : 'empty',
      vanished: gone.map(({ entry }) => ({
        start: entry.start,
        summary: entry.summary || '',
        names: entry.students.map((id) => roster.students.find((s) => s.id === id)?.name || id),
      })),
    };
  }

  const changes = [];
  for (const { entry, newStart } of gone) {
    for (const id of entry.students) {
      const student = roster.students.find((s) => s.id === id);
      if (!student || !reachable(student)) continue;
      changes.push({
        kind: newStart ? 'moved' : 'cancelled',
        student,
        start: entry.start,
        newStart,
        lessonKey: entry.key,
      });
    }
  }
  return { changes, seen, vanished: [], reason: null };
}

/** Record a reminder that went out (or was written off) in the state. */
export function recordSent(state, { key, lesson, student, sent }) {
  state.sent[key] = { at: Date.now(), start: lesson.start, sent: Boolean(sent) };
  if (!sent) return state;
  const entry = state.seen[lesson.key] || {
    key: lesson.key,
    uid: lesson.uid,
    start: lesson.start,
    summary: lesson.summary,
    students: [],
    missing: 0,
  };
  if (!entry.students.includes(student.id)) entry.students.push(student.id);
  state.seen[lesson.key] = entry;
  return state;
}

/** Drop everything to do with lessons that are well behind us. */
export function prune(state, { now = Date.now(), keepMs = 14 * 24 * 3600000 } = {}) {
  const cutoff = now - keepMs;
  for (const [key, entry] of Object.entries(state.sent)) {
    if ((entry.start ?? 0) < cutoff) delete state.sent[key];
  }
  for (const [key, entry] of Object.entries(state.seen)) {
    if ((entry.start ?? 0) < now) delete state.seen[key];
  }
  return state;
}
