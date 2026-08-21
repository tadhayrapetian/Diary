/**
 * Where the lessons come from.
 *
 * Three ways in, all ending in the same iCalendar text:
 *
 *   caldav  — the real thing. Your Apple ID and an app-specific password;
 *             reads the calendars live, sees edits within the minute.
 *   url     — a calendar you shared as public in Apple Calendar (webcal://…).
 *             No password anywhere, but Apple refreshes the published copy on
 *             its own schedule, so an edit can take a while to show up.
 *   file    — an .ics on disk. For trying the thing out, and for tests.
 */

import { readFile } from 'node:fs/promises';

import { fetchCalendars } from './caldav.js';
import { lessonsIn } from './ics.js';

const HOUR = 3600000;

/** Which source the settings describe, and everything it needs. */
export function calendarSource(env = process.env) {
  const appleId = env.APPLE_ID?.trim();
  const password = env.APPLE_APP_PASSWORD?.trim();
  const url = env.CALENDAR_ICS_URL?.trim();
  const file = env.CALENDAR_ICS_FILE?.trim();
  const only = (env.APPLE_CALENDARS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  if (appleId && password) return { kind: 'caldav', appleId, password, only };
  if (url) return { kind: 'url', url, only };
  if (file) return { kind: 'file', file, only };
  return {
    kind: 'none',
    reason:
      'Не настроен календарь. Задайте APPLE_ID и APPLE_APP_PASSWORD в .env ' +
      '(или CALENDAR_ICS_URL для публичной ссылки на календарь).',
  };
}

async function fetchIcs(url, signal) {
  const https = url.replace(/^webcal:/i, 'https:');
  const response = await fetch(https, {
    signal,
    headers: { 'User-Agent': 'lesson-reminders/1.0', Accept: 'text/calendar' },
  });
  if (!response.ok) throw new Error(`Календарь по ссылке ответил ${response.status}`);
  return response.text();
}

/** Raw calendars for a window, whichever source is configured. */
export async function readCalendars(source, { from, to, signal } = {}) {
  switch (source.kind) {
    case 'caldav':
      return fetchCalendars({ ...source, from, to, signal });
    case 'url':
      return [{ name: 'Календарь', text: await fetchIcs(source.url, signal) }];
    case 'file':
      return [{ name: 'Календарь', text: await readFile(source.file, 'utf8') }];
    default:
      throw new Error(source.reason || 'Календарь не настроен');
  }
}

/**
 * Lessons starting between now and `days` from now.
 *
 * The window reaches an hour into the past so a lesson that has just begun is
 * still visible — a reminder for it is already spent, but the change watcher
 * wants to know it happened rather than deciding it was cancelled.
 */
export async function upcomingLessons(source, { now = Date.now(), days = 8, zone, signal } = {}) {
  const from = now - HOUR;
  const to = now + days * 24 * HOUR;
  const calendars = await readCalendars(source, { from, to, signal });
  return lessonsIn(calendars, { from, to, zone });
}
