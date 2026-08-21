/**
 * Just enough iCalendar to know when the next lesson is.
 *
 * Apple Calendar hands out RFC 5545 text — over CalDAV, over a subscription
 * URL, or out of a file. Recurring events arrive as a rule rather than a list,
 * so the expansion has to happen here: a lesson "every Tuesday at 15:00" is one
 * VEVENT, and the reminder for the 3rd of March has to be found inside it.
 *
 * Occurrences are generated in the event's own wall clock and converted to
 * instants one at a time, so a weekly lesson stays at 15:00 across a DST
 * change rather than sliding by an hour.
 */

import {
  dayNumber,
  daysInMonth,
  fromDayNumber,
  isZone,
  toInstant,
  wallOf,
  weekday,
} from './tz.js';

const DAY_MS = 86400000;
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** Zones written by other calendar apps that Apple's users subscribe to. */
const ZONE_ALIASES = {
  'russian standard time': 'Europe/Moscow',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'eastern standard time': 'America/New_York',
  'pacific standard time': 'America/Los_Angeles',
  'israel standard time': 'Asia/Jerusalem',
  'caucasus standard time': 'Asia/Yerevan',
  'georgian standard time': 'Asia/Tbilisi',
  'utc': 'UTC',
};

/** Stop expanding a rule after this many candidate days, whatever it says. */
const MAX_DAYS = 20000;

// ------------------------------------------------------------------- lexing

/** Undo RFC 5545 line folding and normalise line endings. */
export function unfold(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

function splitUnquoted(text, sep) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

/** `DTSTART;TZID=Europe/Moscow:20260303T150000` → name, params, value. */
export function parseLine(line) {
  let cut = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return null;
  const segments = splitUnquoted(line.slice(0, cut), ';');
  const params = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq < 1) continue;
    let value = segment.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params[segment.slice(0, eq).toUpperCase()] = value;
  }
  return { name: segments[0].toUpperCase(), params, value: line.slice(cut + 1) };
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** Pull the VEVENT blocks out of a calendar, each as a list of properties. */
export function parseEvents(text) {
  const events = [];
  let current = null;
  let depth = 0; // nested components inside a VEVENT (VALARM) are skipped
  for (const line of unfold(text).split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, value } = parsed;
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') {
      current = [];
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (name === 'END' && value.toUpperCase() === 'VEVENT') {
      events.push(current);
      current = null;
      continue;
    }
    if (name === 'BEGIN') depth += 1;
    else if (name === 'END') depth -= 1;
    else if (depth === 0) current.push(parsed);
  }
  return events;
}

// -------------------------------------------------------------------- values

function resolveZone(tzid, fallback) {
  if (!tzid) return fallback;
  const cleaned = tzid.replace(/^\//, '').trim();
  if (isZone(cleaned)) return cleaned;
  const alias = ZONE_ALIASES[cleaned.toLowerCase()];
  if (alias && isZone(alias)) return alias;
  // Apple sometimes writes /freeassociation.sourceforge.net/Europe/Moscow
  const tail = cleaned.split('/').slice(-2).join('/');
  if (isZone(tail)) return tail;
  return fallback;
}

/** A DATE or DATE-TIME property → wall-clock reading plus the zone it is in. */
export function parseWhen(value, params, fallbackZone) {
  const raw = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) return null;
  const allDay = params?.VALUE === 'DATE' || m[4] === undefined;
  const zone = m[7] ? 'UTC' : resolveZone(params?.TZID, fallbackZone);
  const wall = {
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4] || 0),
    mi: Number(m[5] || 0),
    s: Number(m[6] || 0),
  };
  return { wall, zone, allDay, at: toInstant(wall, zone) };
}

/** `PT1H30M` → milliseconds. */
export function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase(),
  );
  if (!m) return null;
  const ms =
    Number(m[2] || 0) * 7 * DAY_MS +
    Number(m[3] || 0) * DAY_MS +
    Number(m[4] || 0) * 3600000 +
    Number(m[5] || 0) * 60000 +
    Number(m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRule(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  const list = (key) => (rule[key] ? rule[key].split(',').filter(Boolean) : null);
  return {
    freq: rule.FREQ || 'WEEKLY',
    interval: Math.max(1, Number(rule.INTERVAL || 1)),
    count: rule.COUNT ? Number(rule.COUNT) : null,
    until: rule.UNTIL || null,
    byDay: list('BYDAY'),
    byMonthDay: list('BYMONTHDAY')?.map(Number) || null,
    byMonth: list('BYMONTH')?.map(Number) || null,
    weekStart: DAYS.indexOf(rule.WKST || 'MO') < 0 ? 0 : DAYS.indexOf(rule.WKST || 'MO'),
  };
}

// -------------------------------------------------------------------- events

/** One VEVENT's properties → the shape the expander wants. */
export function readEvent(properties, fallbackZone) {
  const first = (name) => properties.find((p) => p.name === name);
  const start = first('DTSTART');
  if (!start) return null;
  const when = parseWhen(start.value, start.params, fallbackZone);
  if (!when) return null;

  const end = first('DTEND');
  const duration = first('DURATION');
  let length = when.allDay ? DAY_MS : 3600000;
  if (end) {
    const stop = parseWhen(end.value, end.params, fallbackZone);
    if (stop) length = Math.max(0, stop.at - when.at);
  } else if (duration) {
    length = parseDuration(duration.value) ?? length;
  }

  const dates = (name) => {
    const out = [];
    for (const p of properties.filter((x) => x.name === name)) {
      for (const piece of p.value.split(',')) {
        const parsed = parseWhen(piece, p.params, when.zone);
        if (parsed) out.push(parsed);
      }
    }
    return out;
  };

  const rrule = first('RRULE');
  const recurrenceId = first('RECURRENCE-ID');
  return {
    uid: first('UID')?.value?.trim() || '',
    summary: unescapeText(first('SUMMARY')?.value || ''),
    description: unescapeText(first('DESCRIPTION')?.value || ''),
    location: unescapeText(first('LOCATION')?.value || ''),
    status: (first('STATUS')?.value || '').trim().toUpperCase(),
    sequence: Number(first('SEQUENCE')?.value || 0),
    attendees: properties
      .filter((p) => p.name === 'ATTENDEE')
      .map((p) => `${p.params.CN || ''} ${p.value.replace(/^mailto:/i, '')}`.trim()),
    start: when,
    length,
    rule: rrule ? parseRule(rrule.value) : null,
    exdates: dates('EXDATE').map((d) => d.at),
    rdates: dates('RDATE'),
    recurrenceId: recurrenceId
      ? parseWhen(recurrenceId.value, recurrenceId.params, when.zone)?.at ?? null
      : null,
  };
}

function startOfWeek(day, weekStart) {
  const iso = (day + 3) % 7; // 0 = Monday
  return day - ((iso - weekStart + 7) % 7);
}

function matchesDay(rule, wall, startWall) {
  const day = weekday(wall);
  const code = DAYS[day];

  if (rule.byMonth && !rule.byMonth.includes(wall.m)) return false;

  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    if (!rule.byDay) return rule.freq === 'DAILY' || day === weekday(startWall);
    return rule.byDay.some((entry) => entry.slice(-2) === code);
  }

  // MONTHLY and YEARLY: a day of the month, or an nth weekday of it
  if (rule.byMonthDay) {
    const total = daysInMonth(wall.y, wall.m);
    return rule.byMonthDay.some((n) => (n < 0 ? total + n + 1 : n) === wall.d);
  }
  if (rule.byDay) {
    return rule.byDay.some((entry) => {
      if (entry.slice(-2) !== code) return false;
      const ordinal = Number(entry.slice(0, -2));
      if (!ordinal) return true;
      const total = daysInMonth(wall.y, wall.m);
      const nth = Math.floor((wall.d - 1) / 7) + 1;
      const fromEnd = Math.floor((total - wall.d) / 7) + 1;
      return ordinal > 0 ? nth === ordinal : fromEnd === -ordinal;
    });
  }
  return wall.d === startWall.d;
}

function inCycle(rule, wall, startWall) {
  switch (rule.freq) {
    case 'DAILY':
      return (dayNumber(wall) - dayNumber(startWall)) % rule.interval === 0;
    case 'WEEKLY': {
      const weeks =
        (startOfWeek(dayNumber(wall), rule.weekStart) -
          startOfWeek(dayNumber(startWall), rule.weekStart)) /
        7;
      return weeks % rule.interval === 0;
    }
    case 'MONTHLY': {
      const months = (wall.y - startWall.y) * 12 + (wall.m - startWall.m);
      return months >= 0 && months % rule.interval === 0;
    }
    case 'YEARLY':
      return (wall.y - startWall.y) % rule.interval === 0;
    default:
      return false;
  }
}

/**
 * Every start instant this event has inside [from, to].
 *
 * Walks candidate days from DTSTART rather than jumping, because COUNT and
 * INTERVAL are both anchored there — a lesson every other week has to be
 * counted from the first one to know which week we are in.
 */
export function occurrencesOf(event, from, to) {
  const out = [];
  const rule = event.rule;
  const startWall = event.start.wall;
  const zone = event.start.zone;
  const exdates = new Set(event.exdates);

  const push = (at) => {
    if (exdates.has(at) || at > to || at + Math.max(event.length, 1) < from) return;
    out.push(at);
  };

  if (!rule) {
    push(event.start.at);
  } else {
    const until = rule.until
      ? parseWhen(rule.until, { TZID: rule.until.endsWith('Z') ? undefined : zone }, zone)?.at
      : null;
    // Day numbers rather than instants: the walk is pure arithmetic and only
    // pays for a zone conversion on the days a rule actually matches.
    const lastDay = dayNumber(wallOf(to, zone)) + 1;
    let day = dayNumber(startWall);
    let seen = 0;
    for (let step = 0; step < MAX_DAYS && day <= lastDay; step += 1, day += 1) {
      const wall = { ...fromDayNumber(day), h: startWall.h, mi: startWall.mi, s: startWall.s };
      if (!inCycle(rule, wall, startWall) || !matchesDay(rule, wall, startWall)) continue;
      const at = toInstant(wall, zone);
      if (until !== null && at > until) break;
      seen += 1;
      if (rule.count && seen > rule.count) break;
      push(at); // EXDATE'd occurrences still count towards COUNT
    }
  }

  for (const extra of event.rdates) push(extra.at);
  return [...new Set(out)].sort((a, b) => a - b);
}

// --------------------------------------------------------------- the surface

/**
 * Calendars in, lessons out: every occurrence starting inside [from, to],
 * with per-instance edits and cancellations already applied.
 *
 * @param {{name: string, text: string}[]} calendars
 * @returns {{uid, key, start, end, summary, location, description, calendar, allDay, recurring}[]}
 */
export function lessonsIn(calendars, { from, to, zone }) {
  const masters = [];
  const overrides = new Map(); // uid|recurrence-id → event

  for (const calendar of calendars) {
    for (const properties of parseEvents(calendar.text)) {
      const event = readEvent(properties, zone);
      if (!event) continue;
      event.calendar = calendar.name;
      if (event.recurrenceId !== null) {
        const existing = overrides.get(`${event.uid}|${event.recurrenceId}`);
        if (!existing || event.sequence >= existing.sequence) {
          overrides.set(`${event.uid}|${event.recurrenceId}`, event);
        }
      } else {
        masters.push(event);
      }
    }
  }

  const lessons = [];
  const taken = new Set();

  const add = (event, at, replaced) => {
    const key = `${event.uid}|${replaced ?? at}`;
    if (taken.has(key)) return;
    taken.add(key);
    if (event.status === 'CANCELLED') return;
    if (at < from || at > to) return;
    lessons.push({
      uid: event.uid,
      key,
      start: at,
      end: at + event.length,
      summary: event.summary,
      location: event.location,
      description: event.description,
      attendees: event.attendees,
      calendar: event.calendar,
      allDay: event.start.allDay,
      recurring: Boolean(event.rule),
    });
  };

  for (const master of masters) {
    // Reach back a day so a moved instance whose original slot sat just outside
    // the window is still found and replaced by its edit.
    for (const at of occurrencesOf(master, from - DAY_MS, to + DAY_MS)) {
      const override = overrides.get(`${master.uid}|${at}`);
      if (override) add(override, override.start.at, at);
      else add(master, at);
    }
  }

  // Edits to instances whose master never turned up (a single event moved out
  // of a series the server did not send) still deserve a reminder.
  for (const [key, override] of overrides) {
    if (!taken.has(key)) add(override, override.start.at, override.recurrenceId);
  }

  return lessons.sort((a, b) => a.start - b.start);
}
