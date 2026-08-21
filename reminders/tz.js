/**
 * Wall-clock time in a named zone, without a dependency.
 *
 * A lesson at 15:00 every Tuesday is 15:00 in the teacher's zone in January and
 * 15:00 in July — the instant it lands on moves by an hour, the wall clock does
 * not. So the whole reminder pipeline carries wall-clock readings plus a zone,
 * and only converts to a real instant at the last moment. That conversion is
 * this file.
 */

const cache = new Map();

function formatter(timeZone) {
  let dtf = cache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cache.set(timeZone, dtf);
  }
  return dtf;
}

/** True if the runtime's ICU knows this zone. */
export function isZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading in `timeZone` at instant `utcMs`. */
export function wallOf(utcMs, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const at = {};
  for (const p of parts) if (p.type !== 'literal') at[p.type] = Number(p.value);
  return {
    y: at.year,
    m: at.month,
    d: at.day,
    h: at.hour % 24, // h23 can still say 24 on some ICU builds
    mi: at.minute,
    s: at.second,
  };
}

/** Zone offset in ms at a given instant (east of UTC is positive). */
export function offsetAt(utcMs, timeZone) {
  const w = wallOf(utcMs, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - utcMs;
}

/**
 * The instant at which the clocks in `timeZone` read `wall`.
 *
 * Two passes: the first guesses using the offset near the naive instant, the
 * second corrects it when the guess landed on the far side of a DST change.
 * For a reading that a DST jump skipped entirely (02:30 on a spring-forward
 * night) this lands on the same instant the wall clock jumps to, which is what
 * calendars do.
 */
export function toInstant(wall, timeZone) {
  const naive = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h || 0, wall.mi || 0, wall.s || 0);
  let utc = naive - offsetAt(naive, timeZone);
  utc = naive - offsetAt(utc, timeZone);
  return utc;
}

/** Day number since the epoch for a wall-clock date (calendar arithmetic). */
export function dayNumber(wall) {
  return Math.floor(Date.UTC(wall.y, wall.m - 1, wall.d) / 86400000);
}

/** Inverse of `dayNumber`. */
export function fromDayNumber(n) {
  const at = new Date(n * 86400000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/** 0 = Monday … 6 = Sunday, for a wall-clock date. */
export function weekday(wall) {
  return (dayNumber(wall) + 3) % 7; // 1970-01-01 was a Thursday
}

/** Days in the month a wall-clock date falls in. */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The zone the machine itself is in, as a fallback when nothing is configured. */
export function systemZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
