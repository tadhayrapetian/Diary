/**
 * What the student actually reads.
 *
 * One rule shapes the defaults: the calendar belongs to the teacher, and what
 * is written on it is written for the teacher. "Аня — оплатить до среды" is a
 * perfectly ordinary thing to have in an event title, and it must never be
 * forwarded to Аня. So a reminder says the time and nothing else unless the
 * roster explicitly opts in (`includeTitle`) or gives the student a `subject`
 * of her own.
 */

import { dayNumber, wallOf } from './tz.js';
import { escapeHtml } from './telegram.js';

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const ON_WEEKDAY = [
  'в понедельник', 'во вторник', 'в среду', 'в четверг',
  'в пятницу', 'в субботу', 'в воскресенье',
];

export const TEMPLATES = {
  reminder: 'Привет, {name}! Напоминаю: урок {when} в {time}{lead}.{subject}{location}',
  moved: '{name}, урок {oldWhen} в {oldTime} перенесён — теперь {when} в {time}.',
  cancelled: '{name}, урок {when} в {time} отменён.',
  linked: 'Готово, {name}! Теперь я буду напоминать о занятиях здесь.',
  paused: 'Хорошо, напоминания выключены. Напишите /start, чтобы включить обратно.',
  resumed: 'Напоминания снова включены.',
  none: 'Ближайших занятий в расписании нет.',
  unknown: 'Напишите мне, пожалуйста, ссылку-приглашение от преподавателя — по ней я вас узнаю.',
};

/** Russian numerals: 1 час, 2 часа, 5 часов. */
export function plural(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** 15:00 */
export function timeIn(at, zone) {
  const w = wallOf(at, zone);
  return `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
}

/** 3 марта */
export function dateIn(at, zone) {
  const w = wallOf(at, zone);
  return `${w.d} ${MONTHS[w.m - 1]}`;
}

/** сегодня · завтра · в четверг · в четверг, 3 марта */
export function whenIn(at, now, zone) {
  const days = dayNumber(wallOf(at, zone)) - dayNumber(wallOf(now, zone));
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  if (days === 2) return 'послезавтра';
  const weekday = ON_WEEKDAY[(dayNumber(wallOf(at, zone)) + 3) % 7];
  if (days > 0 && days < 7) return `${weekday}, ${dateIn(at, zone)}`;
  return dateIn(at, zone);
}

/** " (через час)" for the reminders that land close enough for it to mean something. */
export function leadIn(minutes) {
  if (minutes > 240 || minutes < 1) return '';
  if (minutes < 60) return ` (через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')})`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return ' (через час)';
  return ` (через ${hours} ${plural(hours, 'час', 'часа', 'часов')})`;
}

/** Fill {placeholders}; every value is escaped, so a template may carry HTML. */
export function render(template, values) {
  return template
    .replace(/\{(\w+)\}/g, (_, key) => (key in values ? escapeHtml(values[key]) : ''))
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function subjectOf(lesson, student, roster) {
  const explicit = student.subject?.trim();
  if (explicit) return `\nТема: ${explicit}`;
  if (roster.includeTitle && lesson.summary) return `\nТема: ${lesson.summary}`;
  return '';
}

function locationOf(lesson, roster) {
  if (!roster.includeLocation || !lesson.location) return '';
  return `\nГде: ${lesson.location}`;
}

function templateFor(roster, name) {
  return roster.templates?.[name] || TEMPLATES[name];
}

/**
 * The reminder itself.
 *
 * `{lead}` counts from now rather than from the setting that triggered this:
 * a reminder meant for an hour ahead but sent late — a sleeping laptop, a
 * lesson added at the last minute — must say "через 18 минут", not "через час".
 */
export function reminderText({ roster, student, lesson, now }) {
  const zone = roster.timezone;
  return render(templateFor(roster, 'reminder'), {
    name: student.name,
    when: whenIn(lesson.start, now, zone),
    time: timeIn(lesson.start, zone),
    date: dateIn(lesson.start, zone),
    lead: leadIn(Math.round((lesson.start - now) / 60000)),
    subject: subjectOf(lesson, student, roster),
    location: locationOf(lesson, roster),
  });
}

/** "Moved" and "cancelled", for lessons the student was already told about. */
export function changeText({ roster, student, change, now }) {
  const zone = roster.timezone;
  const values = {
    name: student.name,
    oldWhen: whenIn(change.start, now, zone),
    oldTime: timeIn(change.start, zone),
    when: whenIn(change.newStart ?? change.start, now, zone),
    time: timeIn(change.newStart ?? change.start, zone),
  };
  return render(templateFor(roster, change.kind === 'moved' ? 'moved' : 'cancelled'), values);
}

/** A short list of what is coming, for /next and for the console. */
export function lessonList(lessons, { zone, now, limit = 5 }) {
  if (!lessons.length) return '';
  return lessons
    .slice(0, limit)
    .map((lesson) => `• ${whenIn(lesson.start, now, zone)} в ${timeIn(lesson.start, zone)}`)
    .join('\n');
}

/** One line for the log: "21.08 15:00  Аня  ← за час". */
export function logLine({ at, zone, who, note }) {
  const w = wallOf(at, zone);
  const date = `${String(w.d).padStart(2, '0')}.${String(w.m).padStart(2, '0')}`;
  return `${date} ${timeIn(at, zone)}  ${who}${note ? `  ${note}` : ''}`;
}
