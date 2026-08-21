/**
 * node --test reminders/message.test.js
 *
 * These are the words a student actually receives, so the two things worth
 * testing are that the Russian is right and that nothing from the teacher's
 * calendar leaks into them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { changeText, leadIn, plural, reminderText, render, whenIn } from './message.js';

const ZONE = 'Europe/Moscow';
const NOW = Date.parse('2026-03-03T09:00:00Z'); // вторник, 12:00 в Москве
const HOUR = 3600000;
const DAY = 24 * HOUR;

const roster = (extra = {}) => ({ timezone: ZONE, templates: {}, ...extra });
const student = (extra = {}) => ({ id: 'anya', name: 'Аня', ...extra });
const lesson = (start, extra = {}) => ({
  start,
  summary: 'Аня — оплатить до среды!',
  location: 'дома у Ани',
  ...extra,
});

test('числительные склоняются', () => {
  assert.equal(plural(1, 'час', 'часа', 'часов'), 'час');
  assert.equal(plural(2, 'час', 'часа', 'часов'), 'часа');
  assert.equal(plural(5, 'час', 'часа', 'часов'), 'часов');
  assert.equal(plural(11, 'час', 'часа', 'часов'), 'часов');
  assert.equal(plural(21, 'минуту', 'минуты', 'минут'), 'минуту');
});

test('сегодня, завтра, послезавтра, дальше — день недели', () => {
  assert.equal(whenIn(NOW + HOUR, NOW, ZONE), 'сегодня');
  assert.equal(whenIn(NOW + DAY, NOW, ZONE), 'завтра');
  assert.equal(whenIn(NOW + 2 * DAY, NOW, ZONE), 'послезавтра');
  assert.equal(whenIn(NOW + 4 * DAY, NOW, ZONE), 'в субботу, 7 марта');
  assert.equal(whenIn(NOW + 10 * DAY, NOW, ZONE), '13 марта');
});

test('«завтра» считается по календарю, а не по числу часов', () => {
  const lateEvening = Date.parse('2026-03-03T20:30:00Z'); // 23:30 в Москве
  const soonAfter = lateEvening + HOUR; // 00:30 — уже следующий день
  assert.equal(whenIn(soonAfter, lateEvening, ZONE), 'завтра');
});

test('приписка «через сколько» появляется только когда до урока близко', () => {
  assert.equal(leadIn(60), ' (через час)');
  assert.equal(leadIn(120), ' (через 2 часа)');
  assert.equal(leadIn(18), ' (через 18 минут)');
  assert.equal(leadIn(21), ' (через 21 минуту)');
  assert.equal(leadIn(1440), '');
});

test('название события из календаря по умолчанию не пересылается ученику', () => {
  const text = reminderText({
    roster: roster(),
    student: student(),
    lesson: lesson(NOW + HOUR),
    now: NOW,
  });
  assert.equal(text, 'Привет, Аня! Напоминаю: урок сегодня в 13:00 (через час).');
  assert.doesNotMatch(text, /оплатить|дома у Ани/);
});

test('тему можно задать самому или разрешить брать из календаря', () => {
  const own = reminderText({
    roster: roster(),
    student: student({ subject: 'английский' }),
    lesson: lesson(NOW + HOUR),
    now: NOW,
  });
  assert.match(own, /Тема: английский$/);

  const fromCalendar = reminderText({
    roster: roster({ includeTitle: true, includeLocation: true }),
    student: student(),
    lesson: lesson(NOW + HOUR),
    now: NOW,
  });
  assert.match(fromCalendar, /Тема: Аня — оплатить до среды!/);
  assert.match(fromCalendar, /Где: дома у Ани/);
});

test('подставляемое всегда экранируется, а сам шаблон может быть с разметкой', () => {
  const text = reminderText({
    roster: roster({ templates: { reminder: '<b>{name}</b>: {time}' } }),
    student: student({ name: '<Аня & Ко>' }),
    lesson: lesson(NOW + HOUR),
    now: NOW,
  });
  assert.equal(text, '<b>&lt;Аня &amp; Ко&gt;</b>: 13:00');
});

test('неизвестный placeholder не оставляет мусора в тексте', () => {
  assert.equal(render('Привет, {name}!{nothing}', { name: 'Аня' }), 'Привет, Аня!');
});

test('перенос называет и старое время, и новое; отмена — только старое', () => {
  const moved = changeText({
    roster: roster(),
    student: student(),
    change: { kind: 'moved', start: NOW + DAY, newStart: NOW + DAY + 3 * HOUR },
    now: NOW,
  });
  assert.equal(moved, 'Аня, урок завтра в 12:00 перенесён — теперь завтра в 15:00.');

  const cancelled = changeText({
    roster: roster(),
    student: student(),
    change: { kind: 'cancelled', start: NOW + DAY, newStart: null },
    now: NOW,
  });
  assert.equal(cancelled, 'Аня, урок завтра в 12:00 отменён.');
});
