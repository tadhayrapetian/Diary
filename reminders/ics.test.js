/**
 * node --test reminders/ics.test.js
 *
 * Everything here is something Apple Calendar actually writes. A recurring
 * lesson is a rule, not a list, so if this file is wrong the whole program is
 * wrong in the quietest possible way: it simply never notices a lesson.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { lessonsIn, occurrencesOf, parseDuration, parseLine, readEvent, unfold } from './ics.js';
import { wallOf } from './tz.js';

const ZONE = 'Europe/Moscow';
const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR`;
const cal = (body) => [{ name: 'Уроки', text: wrap(body) }];
const at = (iso) => Date.parse(iso);

function starts(body, { from, to, zone = ZONE }) {
  return lessonsIn(cal(body), { from: at(from), to: at(to), zone }).map((l) => l.start);
}

const clock = (ms, zone = ZONE) => {
  const w = wallOf(ms, zone);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
};

test('unfolds the long lines Apple wraps at 75 characters', () => {
  assert.equal(unfold('SUMMARY:Английск\r\n ий — Аня'), 'SUMMARY:Английский — Аня');
  assert.equal(unfold('SUMMARY:one\n\ttwo'), 'SUMMARY:onetwo');
});

test('reads parameters, including a quoted one holding a colon', () => {
  const line = parseLine('DTSTART;TZID="Europe/Moscow";X-A=b:20260303T150000');
  assert.equal(line.name, 'DTSTART');
  assert.equal(line.params.TZID, 'Europe/Moscow');
  assert.equal(line.value, '20260303T150000');
});

test('durations', () => {
  assert.equal(parseDuration('PT1H30M'), 90 * 60000);
  assert.equal(parseDuration('P1DT2H'), 26 * 3600000);
  assert.equal(parseDuration('P2W'), 14 * 86400000);
});

test('a weekly lesson on two days expands to both', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:a
DTSTART;TZID=Europe/Moscow:20260303T150000
DTEND;TZID=Europe/Moscow:20260303T163000
RRULE:FREQ=WEEKLY;BYDAY=TU,TH
SUMMARY:Английский — Аня
END:VEVENT`,
    { from: '2026-03-01T00:00:00Z', to: '2026-03-15T00:00:00Z' },
  );
  assert.deepEqual(found.map((t) => clock(t)), [
    '2026-03-03 15:00',
    '2026-03-05 15:00',
    '2026-03-10 15:00',
    '2026-03-12 15:00',
  ]);
});

test('every other week, four times, minus one skipped date', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:b
DTSTART;TZID=Europe/Moscow:20260302T190000
DURATION:PT1H
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=4
EXDATE;TZID=Europe/Moscow:20260330T190000
SUMMARY:Олег
END:VEVENT`,
    { from: '2026-03-01T00:00:00Z', to: '2026-05-01T00:00:00Z' },
  );
  assert.deepEqual(found.map((t) => clock(t)), [
    '2026-03-02 19:00',
    '2026-03-16 19:00',
    '2026-04-13 19:00', // the 30th was excluded but still counted towards COUNT
  ]);
});

test('UNTIL stops the series', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:c
DTSTART;TZID=Europe/Moscow:20260303T150000
DURATION:PT1H
RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260317T115959Z
SUMMARY:Аня
END:VEVENT`,
    { from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' },
  );
  assert.deepEqual(found.map((t) => clock(t)), ['2026-03-03 15:00', '2026-03-10 15:00']);
});

test('the last Friday of the month', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:d
DTSTART;TZID=Europe/Moscow:20260227T180000
DURATION:PT1H
RRULE:FREQ=MONTHLY;BYDAY=-1FR
SUMMARY:Разбор месяца
END:VEVENT`,
    { from: '2026-02-01T00:00:00Z', to: '2026-05-01T00:00:00Z' },
  );
  assert.deepEqual(found.map((t) => clock(t)), [
    '2026-02-27 18:00',
    '2026-03-27 18:00',
    '2026-04-24 18:00',
  ]);
});

test('a moved instance replaces the one it was moved from', () => {
  const lessons = lessonsIn(
    cal(`BEGIN:VEVENT
UID:e
DTSTART;TZID=Europe/Moscow:20260303T150000
DURATION:PT1H
RRULE:FREQ=WEEKLY;BYDAY=TU
SUMMARY:Аня
END:VEVENT
BEGIN:VEVENT
UID:e
RECURRENCE-ID;TZID=Europe/Moscow:20260310T150000
DTSTART;TZID=Europe/Moscow:20260310T180000
DURATION:PT1H
SUMMARY:Аня (перенос)
END:VEVENT`),
    { from: at('2026-03-01T00:00:00Z'), to: at('2026-03-20T00:00:00Z'), zone: ZONE },
  );
  assert.deepEqual(lessons.map((l) => clock(l.start)), [
    '2026-03-03 15:00',
    '2026-03-10 18:00',
    '2026-03-17 15:00',
  ]);
  assert.equal(lessons[1].summary, 'Аня (перенос)');
});

test('a cancelled instance disappears', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:f
DTSTART;TZID=Europe/Moscow:20260303T150000
DURATION:PT1H
RRULE:FREQ=WEEKLY;BYDAY=TU
SUMMARY:Аня
END:VEVENT
BEGIN:VEVENT
UID:f
RECURRENCE-ID;TZID=Europe/Moscow:20260310T150000
DTSTART;TZID=Europe/Moscow:20260310T150000
STATUS:CANCELLED
SUMMARY:Аня
END:VEVENT`,
    { from: '2026-03-01T00:00:00Z', to: '2026-03-20T00:00:00Z' },
  );
  assert.deepEqual(found.map((t) => clock(t)), ['2026-03-03 15:00', '2026-03-17 15:00']);
});

test('a weekly lesson keeps its wall clock across a change of the clocks', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:g
DTSTART;TZID=Europe/Berlin:20260324T150000
DURATION:PT1H
RRULE:FREQ=WEEKLY;BYDAY=TU
SUMMARY:Lesson
END:VEVENT`,
    { from: '2026-03-20T00:00:00Z', to: '2026-04-05T00:00:00Z', zone: 'Europe/Berlin' },
  );
  const berlin = found.map((t) => clock(t, 'Europe/Berlin'));
  assert.deepEqual(berlin, ['2026-03-24 15:00', '2026-03-31 15:00']);
  // 15:00 both times, but an hour closer together in real time: DST moved.
  assert.equal(found[1] - found[0], 7 * 86400000 - 3600000);
});

test('a floating time is read in the teacher timezone, a Z time is not', () => {
  const floating = readEvent(
    [{ name: 'DTSTART', params: {}, value: '20260303T150000' }],
    'Europe/Moscow',
  );
  assert.equal(clock(floating.start.at), '2026-03-03 15:00');

  const utc = readEvent([{ name: 'DTSTART', params: {}, value: '20260303T150000Z' }], 'Europe/Moscow');
  assert.equal(clock(utc.start.at), '2026-03-03 18:00');
});

test('an all-day event lands at the start of its day and lasts one', () => {
  const event = readEvent(
    [{ name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20260303' }],
    ZONE,
  );
  assert.equal(event.start.allDay, true);
  assert.equal(clock(event.start.at), '2026-03-03 00:00');
  assert.equal(event.length, 86400000);
});

test('escaped commas and newlines come back as text', () => {
  const lessons = lessonsIn(
    cal(`BEGIN:VEVENT
UID:h
DTSTART;TZID=Europe/Moscow:20260303T150000
SUMMARY:Пробный урок\\, Марк
DESCRIPTION:первый раз\\nбез учебника
END:VEVENT`),
    { from: at('2026-03-01T00:00:00Z'), to: at('2026-03-05T00:00:00Z'), zone: ZONE },
  );
  assert.equal(lessons[0].summary, 'Пробный урок, Марк');
  assert.equal(lessons[0].description, 'первый раз\nбез учебника');
});

test('a lesson outside the window is not returned', () => {
  const found = starts(
    `BEGIN:VEVENT
UID:i
DTSTART;TZID=Europe/Moscow:20260601T150000
DURATION:PT1H
SUMMARY:Далеко
END:VEVENT`,
    { from: '2026-03-01T00:00:00Z', to: '2026-03-10T00:00:00Z' },
  );
  assert.deepEqual(found, []);
});

test('an unknown TZID falls back to the teacher timezone rather than vanishing', () => {
  const event = readEvent(
    [{ name: 'DTSTART', params: { TZID: 'Mars/Olympus' }, value: '20260303T150000' }],
    ZONE,
  );
  assert.equal(clock(event.start.at), '2026-03-03 15:00');
});

test('a series that started years ago still expands into this week', () => {
  const event = readEvent(
    [
      { name: 'UID', params: {}, value: 'old' },
      { name: 'DTSTART', params: { TZID: ZONE }, value: '20190107T150000' },
      { name: 'RRULE', params: {}, value: 'FREQ=WEEKLY;BYDAY=MO' },
    ],
    ZONE,
  );
  const found = occurrencesOf(event, at('2026-03-01T00:00:00Z'), at('2026-03-15T00:00:00Z'));
  assert.deepEqual(found.map((t) => clock(t)), ['2026-03-02 15:00', '2026-03-09 15:00']);
});
