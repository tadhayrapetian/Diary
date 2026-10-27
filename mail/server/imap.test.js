// The IMAP/SMTP store against real protocol servers running in-process:
// hoodiecrow for IMAP (with IDLE and SPECIAL-USE) and smtp-server for SMTP.
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { ImapFlow } from 'imapflow';
import { ImapStore } from './imap.js';

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');
const { SMTPServer } = require('smtp-server');

const msg = (from, subject, body, extra = '') =>
  `From: ${from}\r\nTo: me@test.local\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@t>\r\nDate: ${new Date().toUTCString()}\r\n${extra}MIME-Version: 1.0\r\n` + body;

const plain = (t) => `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(t).toString('base64')}\r\n`;
const mixed =
  'Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: multipart/alternative; boundary="b2"\r\n\r\n' +
  '--b2\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nПривет! =D0=92=D0=BE =D0=B2=D0=BB=D0=BE=D0=B6=D0=B5=D0=BD=D0=B8=D0=B8 =D1=84=D0=B0=D0=B9=D0=BB.\r\n' +
  '--b2\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Привет! Во вложении файл.</p>\r\n--b2--\r\n' +
  '--b1\r\nContent-Type: application/pdf; name="doc.pdf"\r\nContent-Disposition: attachment; filename="doc.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b1--\r\n';

const imap = hoodiecrow({
  plugins: ['ID', 'IDLE', 'ENABLE', 'UNSELECT', 'SPECIAL-USE', 'LITERALPLUS', 'MOVE', 'UIDPLUS'],
  storage: {
    INBOX: {
      messages: [
        { raw: msg('Anna <anna@x.ru>', 'Проект', plain('Как дела с проектом?')), flags: [] },
        { raw: msg('Bob <bob@y.com>', 'Re: Проект', plain('Всё идёт по плану.\n\nOn Mon, Anna wrote:\n> Как дела?')), flags: ['\\Seen'] },
        { raw: msg('Docs <docs@z.io>', 'Документы', mixed), flags: [] },
      ],
    },
    '': {
      separator: '/',
      folders: {
        Sent: { 'special-use': '\\Sent', messages: [] },
        Trash: { 'special-use': '\\Trash', messages: [] },
        Junk: { 'special-use': '\\Junk', messages: [] },
        Work: { messages: [] },
      },
    },
  },
});
await new Promise((r) => imap.listen(11430, r));

const delivered = [];
const smtp = new SMTPServer({
  authOptional: true, secure: false, disabledCommands: ['STARTTLS'],
  onAuth: (auth, s, cb) => cb(null, { user: auth.username }),
  onData: (stream, session, cb) => {
    let raw = '';
    stream.on('data', (c) => (raw += c));
    stream.on('end', () => { delivered.push({ to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); });
  },
});
await new Promise((r) => smtp.listen(25250, r));

const store = new ImapStore({
  imap: { host: '127.0.0.1', port: 11430, secure: false, auth: { user: 'testuser', pass: 'testpass' } },
  smtp: { host: '127.0.0.1', port: 25250, secure: false, ignoreTLS: true, auth: { user: 'testuser', pass: 'x' } },
  from: { name: 'Me', address: 'me@test.local' },
});


after(() => {
  imap.close?.();
  smtp.close();
  store.client?.close();
});

test('a real account: list, read, search, thread, flag, move, send, live delivery', { timeout: 30_000 }, async () => {
  const folders = await store.folders();
  assert.deepEqual(folders.map((f) => f.role), ['inbox', 'sent', 'junk', 'trash', null]);
  assert.equal(folders[0].unread, 2);

  const page = await store.list({ folder: 'INBOX' });
  assert.equal(page.items.length, 3);
  const docs = page.items.find((m) => m.subject === 'Документы');
  assert.equal(docs.snippet, 'Привет! Во вложении файл.');
  assert.equal(docs.hasAttachments, true);
  assert.equal(page.items.find((m) => m.subject === 'Проект').snippet, 'Как дела с проектом?');
  assert.equal(page.items.find((m) => m.subject === 'Re: Проект').snippet, 'Всё идёт по плану.');

  const small = await store.list({ folder: 'INBOX', limit: 2 });
  assert.equal(small.items.length, 2);
  assert.equal(small.next, 2);
  const rest = await store.list({ folder: 'INBOX', limit: 2, offset: 2 });
  assert.equal(rest.items.length, 1);
  assert.equal(rest.next, null);

  const full = await store.get('INBOX', docs.id);
  assert.match(full.html, /Во вложении/);
  assert.equal(full.attachments[0].filename, 'doc.pdf');
  const file = await store.attachment('INBOX', docs.id, 0);
  assert.match(file.content.toString(), /^%PDF/);

  const unread = await store.list({ folder: 'INBOX', filter: 'unread' });
  assert.equal(unread.items.length, 2);
  const search = await store.list({ folder: 'INBOX', q: 'Документы' });
  assert.equal(search.items.length, 1);

  const projectId = page.items.find((m) => m.subject === 'Re: Проект').id;
  const thread = await store.thread('INBOX', projectId);
  assert.deepEqual(thread.map((m) => m.subject), ['Проект', 'Re: Проект']);

  await store.flags('INBOX', [docs.id], { add: ['seen', 'flagged'] });
  const after = (await store.list({ folder: 'INBOX' })).items.find((m) => m.id === docs.id);
  assert.equal(after.seen, true);
  assert.equal(after.flagged, true);
  await store.flags('INBOX', [docs.id], { remove: ['flagged'] });

  await store.move('INBOX', [docs.id], 'trash');
  assert.equal((await store.list({ folder: 'Trash' })).items.length, 1);
  assert.equal((await store.list({ folder: 'INBOX' })).items.length, 2);
  await store.move('INBOX', [projectId], 'archive'); // no \Archive: one is made
  assert.equal((await store.list({ folder: 'Archive' })).items.length, 1);

  const trashId = (await store.list({ folder: 'Trash' })).items[0].id;
  await store.destroy('Trash', [trashId]);
  assert.equal((await store.list({ folder: 'Trash' })).items.length, 0);

  const firstId = (await store.list({ folder: 'INBOX' })).items[0].id;
  await store.send({
    to: [{ name: 'Anna', address: 'anna@x.ru' }], cc: [], bcc: [{ name: '', address: 'secret@x.ru' }],
    subject: 'Re: Проект', html: '<p>Отлично!</p>', text: 'Отлично!', inReplyTo: '<a@t>', references: ['<a@t>'],
    replyTo: { folder: 'INBOX', id: firstId },
    attachments: [{ filename: 'note.txt', contentType: 'text/plain', content: Buffer.from('hi') }],
  });
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].to.sort(), ['anna@x.ru', 'secret@x.ru']);
  assert.doesNotMatch(delivered[0].raw, /secret@x\.ru/, 'Bcc must not appear in headers');
  assert.match(delivered[0].raw, /In-Reply-To: <a@t>/);
  const sent = await store.list({ folder: 'Sent' });
  assert.equal(sent.items.length, 1);
  assert.equal(sent.items[0].seen, true);
  assert.equal((await store.list({ folder: 'INBOX' })).items.find((m) => m.id === firstId).answered, true);

  // live delivery: another client appends to INBOX while the store watches
  const got = new Promise((resolve) => store.once('new', resolve));
  await store.watch();
  await new Promise((r) => setTimeout(r, 600));
  const other = new ImapFlow({ host: '127.0.0.1', port: 11430, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });
  await other.connect();
  await other.append('INBOX', msg('Live <live@x.ru>', 'Прямо сейчас', plain('Свежее письмо')));
  await other.logout();
  const event = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no live event')), 8000))]);
  assert.equal(event.message.subject, 'Прямо сейчас');
  assert.equal(event.message.snippet, 'Свежее письмо');
});
