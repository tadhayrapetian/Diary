/**
 * The students, and which lesson in the calendar belongs to whom.
 *
 * The calendar is the teacher's, written for the teacher — "Английский — Аня",
 * "Аня (пробный)", "урок с Аней". So a student is matched by the words that
 * appear in her lessons rather than by anything structural, and the patterns
 * live next to her name where they can be corrected in a second.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { systemZone } from './tz.js';

export const DEFAULT_REMIND = [1440, 60]; // a day before, then an hour before

/** Lowercase, ё→е, dashes and spacing flattened: how names are compared. */
export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(name, taken) {
  const base = normalise(name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'student';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

function minutesList(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const list = (Array.isArray(value) ? value : [value])
    .map((entry) => (entry && typeof entry === 'object' ? entry.minutes : entry))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return list.length ? [...new Set(list)].sort((a, b) => b - a) : fallback;
}

/**
 * Read students.json, fill in what it left out, and complain in plain language
 * about what it got wrong.
 */
export function loadRoster(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Нет файла ${file}. Скопируйте образец:\n  cp reminders/students.example.json ${file}`,
      );
    }
    throw error;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} — не читается как JSON: ${error.message}`);
  }
  if (!data || !Array.isArray(data.students)) {
    throw new Error(`${file} должен содержать поле "students" со списком учеников.`);
  }

  const zone = data.timezone?.trim() || systemZone();
  const remind = minutesList(data.remind, DEFAULT_REMIND);
  const taken = new Set(data.students.map((s) => s?.id).filter(Boolean));

  const students = data.students.map((entry, index) => {
    const name = String(entry.name ?? '').trim();
    if (!name) throw new Error(`${file}: у ученика №${index + 1} нет имени.`);
    const patterns = (entry.match?.length ? entry.match : [name])
      .map((p) => String(p).trim())
      .filter(Boolean);
    return {
      ...entry,
      id: String(entry.id || slug(name, taken)),
      name,
      match: patterns,
      remind: minutesList(entry.remind, remind),
      calendars: (entry.calendars || []).map((c) => String(c).trim()).filter(Boolean),
      telegram: entry.telegram || null,
      paused: Boolean(entry.paused),
    };
  });

  return {
    file,
    timezone: zone,
    remind,
    notifyChanges: data.notifyChanges !== false,
    includeTitle: Boolean(data.includeTitle),
    includeLocation: Boolean(data.includeLocation),
    templates: data.templates || {},
    students,
    raw: data,
  };
}

/** Write the roster back without disturbing anything the file said that we do not use. */
export function saveRoster(roster) {
  const data = {
    ...roster.raw,
    timezone: roster.timezone,
    remind: roster.remind,
    students: roster.students.map((student) => {
      const { id, name, match, remind, calendars, telegram, paused, ...rest } = student;
      const entry = { ...rest, id, name };
      if (match?.length && !(match.length === 1 && match[0] === name)) entry.match = match;
      else delete entry.match;
      if (JSON.stringify(remind) !== JSON.stringify(roster.remind)) entry.remind = remind;
      else delete entry.remind;
      if (calendars?.length) entry.calendars = calendars;
      else delete entry.calendars;
      if (paused) entry.paused = true;
      else delete entry.paused;
      if (telegram) entry.telegram = telegram;
      return entry;
    }),
  };
  const temporary = join(dirname(roster.file), `.students.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temporary, roster.file);
}

/** True if one of the student's patterns appears in the lesson. */
export function matches(student, lesson) {
  if (student.calendars.length && !student.calendars.includes(lesson.calendar)) return false;
  const haystack = normalise(
    [lesson.summary, lesson.description, lesson.location, ...(lesson.attendees || [])].join('  '),
  );
  return student.match.some((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length > 2 && trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
      const end = trimmed.lastIndexOf('/');
      try {
        return new RegExp(trimmed.slice(1, end), `${trimmed.slice(end + 1)}i`).test(haystack);
      } catch {
        return false;
      }
    }
    return haystack.includes(normalise(trimmed));
  });
}

/** Everyone whose lesson this is. */
export function studentsFor(roster, lesson) {
  return roster.students.filter((student) => matches(student, lesson));
}

/** Linked, not paused — the ones a message can actually reach. */
export function reachable(student) {
  return Boolean(student.telegram?.chatId) && !student.paused;
}

/** A short code for the t.me/<bot>?start=… link. No look-alike characters. */
export function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function findByCode(roster, code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  return roster.students.find((s) => (s.code || '').toUpperCase() === wanted) || null;
}

export function findByChat(roster, chatId) {
  return roster.students.find((s) => String(s.telegram?.chatId) === String(chatId)) || null;
}

/** Loose lookup for the command line: exact id, exact name, then prefix. */
export function findByName(roster, query) {
  const wanted = normalise(query);
  return (
    roster.students.find((s) => s.id === query) ||
    roster.students.find((s) => normalise(s.name) === wanted) ||
    roster.students.find((s) => normalise(s.name).startsWith(wanted)) ||
    null
  );
}
