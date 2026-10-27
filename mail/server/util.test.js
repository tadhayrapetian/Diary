import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSubject, htmlToText, snippetFrom, decodePart, findTextPart, hasAttachments, parseRecipients, textToHtml,
} from './util.js';
import { accountFromEnv } from './config.js';
import { DemoStore } from './demo.js';

test('subjects collapse to one conversation key', () => {
  assert.equal(normalizeSubject('Re: Fwd: RE: Hello  world'), 'hello world');
  assert.equal(normalizeSubject('Ответ: Отв: Привет'), 'привет');
  assert.equal(normalizeSubject('AW: [EXT] Release'), 'release');
  assert.equal(normalizeSubject('[aether/core] PR #1'), '[aether/core] pr #1');
});

test('html becomes readable text', () => {
  const text = htmlToText('<style>p{}</style><p>Hi&nbsp;there</p><p>Line&#33;<br>Two &amp; three</p>');
  assert.equal(text, 'Hi there\nLine!\nTwo & three');
});

test('snippets drop quoted history and signatures', () => {
  assert.equal(snippetFrom('Thanks!\n\nOn Tue, Bob wrote:\n> old stuff'), 'Thanks!');
  assert.equal(snippetFrom('Hello\n-- \nSig'), 'Hello');
  assert.equal(snippetFrom('a'.repeat(300)).length, 180);
});

test('raw IMAP parts decode through transfer encoding and charset', () => {
  assert.equal(decodePart(Buffer.from('0J/RgNC40LLQtdGC'), { encoding: 'base64' }), 'Привет');
  // a partial fetch that stops mid-quantum still decodes what it has
  assert.equal(decodePart(Buffer.from('0J/RgNC40LLQtdGC0'), { encoding: 'base64' }), 'Привет');
  assert.equal(decodePart(Buffer.from('caf=C3=A9 =\r\nok'), { encoding: 'quoted-printable' }), 'café ok');
  assert.equal(decodePart(Buffer.from([0xcf, 0xf0, 0xe8]), { charset: 'windows-1251' }), 'При');
  assert.equal(decodePart(Buffer.from('already'), { encoding: 'base64', binary: true }), 'already');
});

test('the preview part is found inside nested multiparts', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      { type: 'multipart/alternative', part: '1', childNodes: [{ type: 'text/plain', part: '1.1' }, { type: 'text/html', part: '1.2' }] },
      { type: 'application/pdf', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } },
    ],
  };
  assert.equal(findTextPart(structure).part, '1.1');
  assert.equal(findTextPart({ type: 'text/html' }).part, '1');
  assert.equal(hasAttachments(structure), true);
  assert.equal(hasAttachments(structure.childNodes[0]), false);
});

test('typed recipients parse and invalid ones are dropped', () => {
  assert.deepEqual(parseRecipients('Anna <anna@x.ru>, bob@y.com; nope'), [
    { name: 'Anna', address: 'anna@x.ru' },
    { name: '', address: 'bob@y.com' },
  ]);
  assert.deepEqual(parseRecipients([{ name: 'C', address: 'c@z.io' }]), [{ name: 'C', address: 'c@z.io' }]);
});

test('plain text becomes safe html', () => {
  assert.equal(textToHtml('<b>hi</b>\nhttps://a.b/c.'), '&lt;b&gt;hi&lt;/b&gt;<br><a href="https://a.b/c">https://a.b/c</a>.');
});

test('accounts come from env, with provider presets', () => {
  assert.equal(accountFromEnv({}), null);
  assert.equal(accountFromEnv({ MAIL_PROVIDER: 'gmail', MAIL_USER: 'a@gmail.com', MAIL_PASS: 'x', MAIL_DEMO: '1' }), null);
  const gmail = accountFromEnv({ MAIL_PROVIDER: 'gmail', MAIL_USER: 'a@gmail.com', MAIL_PASS: 'x' });
  assert.equal(gmail.imap.host, 'imap.gmail.com');
  assert.equal(gmail.imap.secure, true);
  assert.equal(gmail.smtp.host, 'smtp.gmail.com');
  assert.equal(gmail.smtp.port, 465);
  assert.equal(gmail.smtp.secure, true);
  assert.equal(gmail.from.address, 'a@gmail.com');
  const icloud = accountFromEnv({ MAIL_PROVIDER: 'icloud', MAIL_USER: 'a@icloud.com', MAIL_PASS: 'x' });
  assert.equal(icloud.smtp.port, 587);
  assert.equal(icloud.smtp.secure, false);
  const custom = accountFromEnv({ IMAP_HOST: 'imap.example.org', IMAP_USER: 'u', IMAP_PASS: 'p', MAIL_FROM: 'me@example.org' });
  assert.equal(custom.smtp.host, 'smtp.example.org');
  assert.equal(custom.from.address, 'me@example.org');
});

test('the demo mailbox behaves like a mailbox', async () => {
  const store = new DemoStore();
  const inbox = await store.list({ folder: 'inbox' });
  assert.ok(inbox.items.length > 5);
  const first = inbox.items[0];
  assert.ok(inbox.items.every((m, i, a) => i === 0 || a[i - 1].date >= m.date), 'newest first');

  await store.flags('inbox', [first.id], { add: ['seen'] });
  assert.equal((await store.get('inbox', first.id)).seen, true);

  await store.move('inbox', [first.id], 'archive');
  assert.ok(!(await store.list({ folder: 'inbox' })).items.some((m) => m.id === first.id));
  assert.ok((await store.list({ folder: 'archive' })).items.some((m) => m.id === first.id));

  const thread = await store.thread('inbox', inbox.items.find((m) => /Релиз/.test(m.subject)).id);
  assert.equal(thread.length, 2);

  const found = await store.list({ folder: 'inbox', q: 'калининград' });
  assert.equal(found.items.length, 1);

  const pdf = await store.attachment('inbox', '1', 1);
  assert.match(pdf.content.toString('latin1'), /^%PDF/);
});
