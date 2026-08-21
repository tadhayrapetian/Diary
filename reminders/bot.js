#!/usr/bin/env node
/**
 * Напоминания об уроках — Apple Calendar → Telegram.
 *
 * Один процесс делает две вещи одновременно: раз в несколько минут читает
 * календарь и рассылает то, что подошло по времени, и параллельно слушает
 * Telegram, чтобы ученик мог подключиться по ссылке, поставить напоминания на
 * паузу или спросить, когда следующий урок.
 *
 *   node reminders/bot.js                 запустить и оставить работать
 *   node reminders/bot.js --once          одна проверка и выход (для cron)
 *   node reminders/bot.js next            что и кому уйдёт в ближайшие дни
 *   node reminders/bot.js link Аня        ссылка-приглашение для ученика
 *   node reminders/bot.js students        кто подключён
 *   node reminders/bot.js calendars       какие календари видны в iCloud
 *   node reminders/bot.js test Аня        отправить пробное напоминание
 *
 * Флаг --dry-run: всё то же самое, но ничего не отправляется и состояние не
 * записывается — только печатается в консоль.
 */

import { join } from 'node:path';

import { loadEnv, root } from '../server/env.js';
import { calendarSource, upcomingLessons } from './calendar.js';
import { listCalendars } from './caldav.js';
import {
  changeText,
  lessonList,
  logLine,
  reminderText,
  render,
  TEMPLATES,
  timeIn,
  whenIn,
} from './message.js';
import {
  findByChat,
  findByCode,
  findByName,
  loadRoster,
  newCode,
  reachable,
  saveRoster,
  studentsFor,
} from './roster.js';
import { plan, recordSent, sentKey } from './schedule.js';
import { loadState, saveState } from './state.js';
import { describeChat, escapeHtml, readCommand, Telegram } from './telegram.js';

loadEnv();

const MINUTE = 60000;

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const words = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY = flags.has('--dry-run');

const settings = {
  token: process.env.TELEGRAM_BOT_TOKEN?.trim(),
  teacherChat: process.env.TEACHER_CHAT_ID?.trim(),
  rosterFile: process.env.REMINDERS_STUDENTS?.trim() || join(root, 'reminders', 'students.json'),
  stateFile: process.env.REMINDERS_STATE?.trim() || join(root, 'reminders', 'state.json'),
  everySeconds: Math.max(30, Number(process.env.REMINDERS_EVERY_SECONDS || 300)),
  horizonDays: Math.max(1, Number(process.env.REMINDERS_HORIZON_DAYS || 8)),
  graceMinutes: Math.max(0, Number(process.env.REMINDERS_GRACE_MINUTES || 60)),
  source: calendarSource(),
};

// ------------------------------------------------------------------- printing

const clock = () =>
  new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const say = (line = '') => console.log(line);
const note = (line) => console.log(`${clock()}  ${line}`);
const oops = (line) => console.error(`${clock()}  ! ${line}`);

function describeSource(source) {
  switch (source.kind) {
    case 'caldav':
      return `iCloud (${source.appleId})${source.only.length ? ` · ${source.only.join(', ')}` : ' · все календари'}`;
    case 'url':
      return 'публичная ссылка на календарь';
    case 'file':
      return `файл ${source.file}`;
    default:
      return 'не настроен';
  }
}

function describeOffsets(minutes) {
  return minutes
    .map((m) => {
      if (m % 1440 === 0) return m === 1440 ? 'за сутки' : `за ${m / 1440} дн.`;
      if (m % 60 === 0) return m === 60 ? 'за час' : `за ${m / 60} ч.`;
      return `за ${m} мин.`;
    })
    .join(' и ');
}

function banner(roster, bot) {
  say('Напоминания об уроках');
  if (bot) say(`  бот           @${bot.username}`);
  say(`  календарь     ${describeSource(settings.source)}`);
  say(`  часовой пояс  ${roster.timezone}`);
  say(`  напоминаю     ${describeOffsets(roster.remind)}`);
  const linked = roster.students.filter((s) => s.telegram?.chatId).length;
  const waiting = roster.students.length - linked;
  say(
    `  ученики       ${roster.students.length}` +
      `${linked ? `, подключены ${linked}` : ''}${waiting ? `, ждут ссылку ${waiting}` : ''}`,
  );
  if (DRY) say('  режим         --dry-run: ничего не отправляется');

  // Напоминание за неделю не сработает, если календарь читается на 8 дней:
  // урок попадёт в поле зрения уже после того, как момент прошёл, — и будет
  // молча списан. Лучше сказать об этом сразу, чем оставить тихий провал.
  const widest = Math.max(0, ...roster.students.map((s) => Math.max(...s.remind)));
  if (widest * MINUTE > settings.horizonDays * 24 * 3600000 - 6 * 3600000) {
    say(
      `  внимание      напоминание ${describeOffsets([widest])} не успеет: ` +
        `календарь читается на ${settings.horizonDays} дн. вперёд.`,
    );
    say(`                поднимите REMINDERS_HORIZON_DAYS в .env хотя бы до ${Math.ceil(widest / 1440) + 1}`);
  }
  say();
}

// -------------------------------------------------------------------- sending

function makeTelegram() {
  if (!settings.token) {
    throw new Error(
      'Нет TELEGRAM_BOT_TOKEN. Создайте бота у @BotFather (/newbot), скопируйте токен в .env.',
    );
  }
  return new Telegram(settings.token);
}

async function tellTeacher(telegram, text) {
  if (!settings.teacherChat) return;
  if (DRY) {
    say(`   (преподавателю) ${text}`);
    return;
  }
  const result = await telegram.send(settings.teacherChat, text);
  if (!result.ok) oops(`не удалось написать вам самому: ${result.error.message}`);
}

/**
 * Одна проверка: прочитать календарь, разослать то, что подошло, записать
 * состояние. Возвращает уроки — их же использует /next в чате.
 */
async function tick(telegram, { verbose = true } = {}) {
  const roster = loadRoster(settings.rosterFile);
  const state = loadState(settings.stateFile);
  const now = Date.now();

  const lessons = await upcomingLessons(settings.source, {
    now,
    days: settings.horizonDays,
    zone: roster.timezone,
  });

  const result = plan({
    lessons,
    roster,
    state,
    now,
    grace: settings.graceMinutes * MINUTE,
  });

  if (verbose) {
    const mine = lessons.filter((lesson) => studentsFor(roster, lesson).length).length;
    note(
      `календарь прочитан: уроков ${lessons.length}` +
        `${mine !== lessons.length ? ` (с учениками из списка — ${mine})` : ''}`,
    );
  }

  state.seen = result.seen;
  let rosterChanged = false;

  for (const { key, student, lesson, minutes, catchUp } of result.sends) {
    const text = reminderText({ roster, student, lesson, now });
    const label = `${student.name}: ${whenIn(lesson.start, now, roster.timezone)} в ${timeIn(lesson.start, roster.timezone)}`;

    if (DRY) {
      note(`→ ${label} ${catchUp ? '(вдогонку)' : `(${describeOffsets([minutes])})`}`);
      say(`   ${text.replace(/\n/g, '\n   ')}`);
      continue;
    }

    const sent = await telegram.send(student.telegram.chatId, text);
    if (sent.ok) {
      note(`→ ${label}${catchUp ? ' (вдогонку)' : ''}`);
      recordSent(state, { key, lesson, student, sent: true });
    } else if (sent.unreachable) {
      oops(`${student.name} недоступен в Telegram (${sent.error.message})`);
      recordSent(state, { key, lesson, student, sent: false });
      student.telegram = { ...student.telegram, unreachable: true };
      rosterChanged = true;
      await tellTeacher(
        telegram,
        `Не смог написать ${escapeHtml(student.name)}: похоже, бот заблокирован или чат удалён. ` +
          'Попросите ученика снова открыть ссылку-приглашение.',
      );
    } else {
      oops(`не отправилось ${student.name}: ${sent.error.message} — повторю позже`);
    }
  }

  for (const { key, start } of result.spent) {
    if (DRY) continue;
    state.sent[key] = { at: now, start, sent: false };
  }

  for (const change of result.changes) {
    const text = changeText({ roster, student: change.student, change, now });
    if (DRY) {
      note(`→ ${change.student.name}: ${change.kind === 'moved' ? 'перенос' : 'отмена'}`);
      say(`   ${text}`);
      continue;
    }
    const sent = await telegram.send(change.student.telegram.chatId, text);
    if (sent.ok) note(`→ ${change.student.name}: ${change.kind === 'moved' ? 'перенос' : 'отмена'}`);
    else oops(`не отправилось ${change.student.name}: ${sent.error.message}`);
    delete state.seen[change.lessonKey];
  }

  if (result.vanished.length) {
    const list = result.vanished
      .map((v) => `• ${logLine({ at: v.start, zone: roster.timezone, who: v.names.join(', ') })}`)
      .join('\n');
    const why =
      result.reason === 'empty'
        ? 'календарь прочитался пустым'
        : `из календаря разом пропало уроков: ${result.vanished.length}`;
    oops(`${why} — ученикам ничего не сказал`);
    say(list);
    await tellTeacher(
      telegram,
      `Похоже на сбой синхронизации: ${escapeHtml(why)}, а ученики про эти уроки уже предупреждены. ` +
        'Поэтому я <b>ничего им не написал</b>. Проверьте календарь:\n' +
        escapeHtml(list),
    );
  }

  if (!DRY) {
    saveState(settings.stateFile, state, { now });
    if (rosterChanged) saveRoster(roster);
  }
  return { roster, lessons };
}

// ------------------------------------------------------------ chat with pupils

/**
 * Незнакомый чат — это либо ученик, открывший бота без ссылки, либо вы сами.
 * Номер чата печатается потому, что узнать свой TEACHER_CHAT_ID больше неоткуда:
 * написать боту и посмотреть в лог — самый короткий путь.
 */
function noteStranger(chat) {
  note(
    `незнакомый чат ${chat.id} (${describeChat(chat)}). ` +
      `Если это вы — впишите в .env: TEACHER_CHAT_ID=${chat.id}`,
  );
}

async function handleMessage(telegram, message, lessonsRef) {
  const chat = message.chat;
  if (!chat || chat.type !== 'private') return;
  const roster = loadRoster(settings.rosterFile);
  const parsed = readCommand(message);
  const known = findByChat(roster, chat.id);

  if (settings.teacherChat && String(chat.id) === String(settings.teacherChat) && !known) {
    await telegram.send(
      chat.id,
      'Это ваш чат преподавателя — сюда я пишу о сбоях и о том, кто подключился.',
    );
    return;
  }

  if (parsed?.command === 'start') {
    const student = findByCode(roster, parsed.argument) || (parsed.argument ? null : known);
    if (!student) {
      const template = known
        ? roster.templates?.resumed || TEMPLATES.resumed
        : roster.templates?.unknown || TEMPLATES.unknown;
      await telegram.send(chat.id, render(template, { name: known?.name ?? '' }));
      if (known) {
        known.paused = false;
        saveRoster(roster);
        note(`${known.name}: напоминания снова включены`);
      } else {
        noteStranger(chat);
      }
      return;
    }
    student.telegram = {
      chatId: chat.id,
      username: chat.username || undefined,
      linkedAt: new Date().toISOString(),
    };
    student.paused = false;
    delete student.code;
    saveRoster(roster);
    note(`${student.name}: напоминания включены (${describeChat(chat)})`);
    const greeting = render(roster.templates?.linked || TEMPLATES.linked, { name: student.name });
    await telegram.send(chat.id, `${greeting}\n${describeOffsets(student.remind)} до урока.`);
    await tellTeacher(telegram, `${escapeHtml(student.name)} теперь получает напоминания.`);
    return;
  }

  if (!known) {
    noteStranger(chat);
    await telegram.send(chat.id, render(roster.templates?.unknown || TEMPLATES.unknown, {}));
    return;
  }

  if (parsed?.command === 'stop') {
    known.paused = true;
    saveRoster(roster);
    note(`${known.name}: напоминания выключены (/stop)`);
    await telegram.send(chat.id, render(roster.templates?.paused || TEMPLATES.paused, { name: known.name }));
    await tellTeacher(telegram, `${escapeHtml(known.name)}: напоминания выключены (/stop).`);
    return;
  }

  if (parsed?.command === 'next') {
    const now = Date.now();
    const mine = lessonsRef.lessons.filter(
      (lesson) => lesson.start > now && studentsFor(roster, lesson).some((s) => s.id === known.id),
    );
    const list = lessonList(mine, { zone: roster.timezone, now, limit: 5 });
    const none = render(roster.templates?.none || TEMPLATES.none, { name: known.name });
    await telegram.send(chat.id, list ? `Ближайшие занятия:\n${list}` : none);
    return;
  }

  await telegram.send(
    chat.id,
    'Я бот с напоминаниями об уроках.\n/next — ближайшие занятия\n/stop — выключить напоминания\n/start — включить обратно',
  );
}

// ------------------------------------------------------------------- commands

async function run() {
  if (settings.source.kind === 'none') throw new Error(settings.source.reason);
  const telegram = makeTelegram();
  const me = await telegram.me();
  banner(loadRoster(settings.rosterFile), me);

  const shared = { lessons: [] };
  let running = true;
  let failing = 0;
  const stop = () => {
    running = false;
    say('\nОстановлено. Напоминания больше не уходят.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const check = async () => {
    try {
      const { lessons } = await tick(telegram);
      shared.lessons = lessons;
      if (failing >= 3) await tellTeacher(telegram, 'Календарь снова читается, напоминания идут как обычно.');
      failing = 0;
    } catch (error) {
      failing += 1;
      oops(`календарь не прочитался (${failing}): ${error.message}`);
      if (process.env.REMINDERS_DEBUG) console.error(error);
      if (failing === 3) {
        await tellTeacher(
          telegram,
          `Не могу прочитать календарь уже ${failing} раза подряд:\n${escapeHtml(error.message)}`,
        );
      }
    }
  };

  note(`проверяю календарь каждые ${Math.round(settings.everySeconds / 60) || 1} мин. Ctrl+C — остановить`);
  await check();

  const calendarLoop = async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, settings.everySeconds * 1000));
      if (!running) break;
      await check();
    }
  };

  const chatLoop = async () => {
    while (running) {
      try {
        for (const update of await telegram.updates({ seconds: 25 })) {
          if (update.message) await handleMessage(telegram, update.message, shared);
        }
      } catch (error) {
        if (error.code === 409) {
          oops('бот уже запущен где-то ещё — этот экземпляр слушать чат не будет');
          return;
        }
        oops(`Telegram: ${error.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  await Promise.all([calendarLoop(), chatLoop()]);
}

/**
 * Разобрать накопившееся в чате и подтвердить обработанное.
 *
 * Нужно ровно для запуска по расписанию: там долгого опроса нет, а ученик
 * всё равно должен иметь возможность подключиться по ссылке. Каждый следующий
 * запрос подтверждает предыдущую пачку, поэтому одно и то же не разбирается
 * дважды.
 */
async function drainChat(telegram, shared, rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    let updates;
    try {
      updates = await telegram.updates({ seconds: 0 });
    } catch (error) {
      if (error.code !== 409) oops(`Telegram: ${error.message}`);
      return;
    }
    if (!updates.length) return;
    for (const update of updates) {
      if (update.message) await handleMessage(telegram, update.message, shared);
    }
  }
}

async function once() {
  const telegram = DRY ? null : makeTelegram();
  const { roster, lessons } = await tick(telegram);
  if (DRY) {
    say('\n(--dry-run: ничего не отправлено)');
    return roster;
  }
  await drainChat(telegram, { lessons });
  return roster;
}

async function link() {
  const query = words.slice(1).join(' ').trim();
  const roster = loadRoster(settings.rosterFile);
  const telegram = makeTelegram();
  const me = await telegram.me();

  let targets;
  if (query) {
    const student = findByName(roster, query);
    if (!student) throw new Error(`Не нашёл ученика «${query}» в ${settings.rosterFile}`);
    targets = [student];
  } else {
    targets = roster.students.filter((s) => !s.telegram?.chatId);
    if (!targets.length) {
      say('Все ученики уже подключены. Ссылку для кого-то конкретного:');
      say('  node reminders/bot.js link Имя');
      return;
    }
  }

  for (const student of targets) {
    if (!student.code) student.code = newCode();
    say(student.name);
    say(`  https://t.me/${me.username}?start=${student.code}`);
    if (student.telegram?.chatId) say('  (уже подключён — ссылка переподключит его)');
  }
  saveRoster(roster);
  say();
  say('Отправьте ссылку ученику. Как только он её откроет и нажмёт «Начать»,');
  say('бот запомнит чат — при запущенном `npm run reminders` это произойдёт само.');
}

async function students() {
  const roster = loadRoster(settings.rosterFile);
  banner(roster);
  for (const student of roster.students) {
    const status = student.paused
      ? 'на паузе'
      : student.telegram?.unreachable
        ? 'бот заблокирован'
        : student.telegram?.chatId
          ? 'подключён'
          : student.code
            ? `ждёт по коду ${student.code}`
            : 'не подключён';
    say(`  ${student.name.padEnd(20)} ${status.padEnd(22)} ${describeOffsets(student.remind)}`);
    if (student.match.length > 1 || student.match[0] !== student.name) {
      say(`  ${''.padEnd(20)} ищу в календаре: ${student.match.join(', ')}`);
    }
  }
}

async function next() {
  const days = Number(words[1]) || 7;
  const roster = loadRoster(settings.rosterFile);
  const state = loadState(settings.stateFile);
  const now = Date.now();
  banner(roster);

  const lessons = await upcomingLessons(settings.source, { now, days, zone: roster.timezone });
  const upcoming = lessons.filter((lesson) => lesson.start > now);
  say(`Уроки на ${days} дн. вперёд: ${upcoming.length}`);
  say();

  const seenStudents = new Set();
  for (const lesson of upcoming) {
    const mine = studentsFor(roster, lesson);
    const who = mine.length ? mine.map((s) => s.name).join(', ') : '— никто из списка';
    say(logLine({ at: lesson.start, zone: roster.timezone, who, note: `· ${lesson.summary}` }));
    for (const student of mine) {
      seenStudents.add(student.id);
      const marks = student.remind.map((minutes) => {
        const at = lesson.start - minutes * MINUTE;
        const already = state.sent[sentKey(student.id, lesson.key, minutes)];
        if (already?.sent) return `${describeOffsets([minutes])} — уже отправлено`;
        if (at < now) return `${describeOffsets([minutes])} — момент прошёл`;
        return `${describeOffsets([minutes])} — ${whenIn(at, now, roster.timezone)} в ${timeIn(at, roster.timezone)}`;
      });
      const blocked = !reachable(student)
        ? student.paused
          ? ' (на паузе)'
          : ' (не подключён — напоминание не уйдёт)'
        : '';
      say(`      ${student.name}${blocked}: ${marks.join('; ')}`);
    }
  }

  const idle = roster.students.filter((s) => !seenStudents.has(s.id));
  if (idle.length) {
    say();
    say(`Без уроков в этом окне: ${idle.map((s) => s.name).join(', ')}`);
    say('Если уроки у них есть — проверьте, как они названы в календаре, и поправьте "match".');
  }
}

async function calendars() {
  if (settings.source.kind !== 'caldav') {
    throw new Error('Список календарей доступен только для iCloud (APPLE_ID + APPLE_APP_PASSWORD).');
  }
  const found = await listCalendars(settings.source);
  say('Календари в iCloud:');
  for (const calendar of found) say(`  • ${calendar.name}`);
  say();
  say('Чтобы читать только нужные, впишите их в .env:');
  say(`  APPLE_CALENDARS=${found.map((c) => c.name).slice(0, 2).join(',')}`);
}

async function test() {
  const query = words.slice(1).join(' ').trim();
  const roster = loadRoster(settings.rosterFile);
  const student = findByName(roster, query);
  if (!student) throw new Error(`Не нашёл ученика «${query}»`);
  if (!student.telegram?.chatId) {
    throw new Error(`${student.name} ещё не подключён — сделайте: node reminders/bot.js link "${student.name}"`);
  }

  const now = Date.now();
  const lessons = await upcomingLessons(settings.source, {
    now,
    days: settings.horizonDays,
    zone: roster.timezone,
  }).catch(() => []);
  const lesson =
    lessons.find((l) => l.start > now && studentsFor(roster, l).some((s) => s.id === student.id)) ||
    { start: now + 60 * MINUTE, summary: 'Пробный урок', location: '', key: 'test', uid: 'test' };

  const text = reminderText({ roster, student, lesson, now });
  say(text);
  if (DRY) {
    say('\n(--dry-run: не отправлено)');
    return;
  }
  const telegram = makeTelegram();
  const sent = await telegram.send(student.telegram.chatId, text);
  say(sent.ok ? `\nОтправлено ${student.name}.` : `\nНе отправилось: ${sent.error.message}`);
}

function help() {
  say(
    `Напоминания об уроках — Apple Calendar → Telegram

  node reminders/bot.js                 запустить и оставить работать
  node reminders/bot.js --once          одна проверка и выход (для cron)
  node reminders/bot.js next [дней]     что и кому уйдёт в ближайшие дни
  node reminders/bot.js link [Имя]      ссылка-приглашение для ученика
  node reminders/bot.js students        кто подключён
  node reminders/bot.js calendars       какие календари видны в iCloud
  node reminders/bot.js test Имя        отправить пробное напоминание

  --dry-run   ничего не отправлять и не записывать, только показать

Настройки — в .env (см. .env.example), ученики — в reminders/students.json.`,
  );
}

// ----------------------------------------------------------------------- main

const commands = { run, link, students, next, calendars, test, help };
const name = words[0] && commands[words[0]] ? words[0] : words[0] ? null : 'run';

try {
  if (!name) {
    oops(`не знаю команду «${words[0]}»`);
    help();
    process.exit(1);
  }
  if (name === 'run' && (flags.has('--once') || DRY)) await once();
  else await commands[name]();
} catch (error) {
  oops(error.message);
  if (process.env.REMINDERS_DEBUG) console.error(error);
  process.exit(1);
}
