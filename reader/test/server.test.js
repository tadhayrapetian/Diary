import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No key in the test environment, so the server runs its local path — which is
// exactly the path worth pinning down, since it must work with nothing set up.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { server } = await import('../server/server.js');

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let base = '';

before(async () => {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('serves the page', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /<title>Lectern<\/title>/);
});

test('refuses to serve outside its own directory', async () => {
  const response = await fetch(`${base}/../../package.json`, { redirect: 'manual' });
  assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
});

test('says how it is configured', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.local, true);
  assert.equal(state.targetLangName, 'Russian');
});

test('extracts a pdf that is posted to it', async () => {
  const response = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': 'typeset.pdf' },
    body: readFileSync(join(fixtures, 'typeset.pdf')),
  });
  const result = await response.json();
  assert.equal(result.kind, 'pdf');
  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.ok(result.words > 100, `only ${result.words} words`);
  assert.match(result.text, /The Ledger of Small Hours/);
});

test('sets text as an article, streamed', async () => {
  const response = await fetch(`${base}/api/typeset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'The Ledger\n\nIt was a bright cold day.\n\n- one item',
      meta: { author: 'A. Scrivener' },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const events = (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => ({
      name: /event: (\w+)/.exec(frame)?.[1],
      data: /data: (.*)/.exec(frame)?.[1],
    }))
    .filter((event) => event.name) // the first frame is a comment, to flush headers
    .map((event) => ({ name: event.name, data: JSON.parse(event.data) }));

  assert.equal(events[0].name, 'start');
  assert.equal(events.at(-1).name, 'done');
  const article = events
    .filter((event) => event.name === 'text')
    .map((event) => event.data.text)
    .join('');
  assert.match(article, /^TITLE The Ledger$/m);
  assert.match(article, /^BYLINE A\. Scrivener$/m);
  assert.match(article, /^LI one item$/m);
});

test('refuses an empty typeset request', async () => {
  const response = await fetch(`${base}/api/typeset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(response.status, 400);
});

test('answers a word lookup even with nothing configured', async () => {
  const response = await fetch(`${base}/api/word`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word: 'ledger', sentence: 'He kept a ledger.', targetLang: 'ru' }),
  });
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.word, 'ledger');
  // Offline, the free dictionaries are unreachable and it says so plainly
  // rather than inventing a definition.
  assert.ok('source' in card || 'translation' in card);
});

test('will not fetch an address on your own network', async () => {
  const response = await fetch(`${base}/api/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://192.168.0.1/secrets' }),
  });
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.match(result.reason, /your own network/);
});

test('will not fetch a non-http scheme', async () => {
  const result = await (
    await fetch(`${base}/api/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    })
  ).json();
  assert.equal(result.ok, false);
});
