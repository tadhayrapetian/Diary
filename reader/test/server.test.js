import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No key in the test environment, so the server runs its local path — which is
// exactly the path worth pinning down, since it must work with nothing set up.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const shelf = mkdtempSync(join(tmpdir(), 'lectern-test-'));
process.env.LECTERN_LIBRARY = shelf;

const { server } = await import('../server/server.js');

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let base = '';

const json = async (path, options) => (await fetch(base + path, options)).json();
const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Read a job's stream to the end and return the events it sent. */
async function watch(id) {
  const response = await fetch(`${base}/api/job/${id}`);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const name = /event: (\w+)/.exec(frame)?.[1];
      const data = /data: (.*)/.exec(frame)?.[1];
      if (!name) continue;
      events.push({ name, data: JSON.parse(data) });
      if (name === 'done' || name === 'failed') {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}

const articleOf = (events) =>
  events.filter((e) => e.name === 'text').map((e) => e.data.text).join('');

before(async () => {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(shelf, { recursive: true, force: true });
});

test('serves the page', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Lectern<\/title>/);
});

test('refuses to serve outside its own directory', async () => {
  const response = await fetch(`${base}/../../package.json`, { redirect: 'manual' });
  assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
});

test('says how it is configured', async () => {
  const state = await json('/api/state');
  assert.equal(state.local, true);
  assert.equal(state.targetLangName, 'Russian');
});

test('extracts a pdf, and says what it would cost to work on', async () => {
  const result = await (
    await fetch(`${base}/api/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'typeset.pdf' },
      body: readFileSync(join(fixtures, 'typeset.pdf')),
    })
  ).json();

  assert.equal(result.kind, 'pdf');
  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.ok(result.words > 100, `only ${result.words} words`);
  assert.equal(result.lang, 'en', 'the language is guessed for the direction');
  assert.match(result.preview, /The Ledger of Small Hours/);
  assert.ok(result.pieces.translate >= 1);
  assert.ok(result.sourceToken, 'the text stays here rather than making a round trip');
});

test('runs a job, streams it, and puts it on the shelf', async () => {
  const started = await json(
    '/api/run',
    post({
      text: 'The Ledger\n\nIt was a bright cold day.\n\n- one item',
      meta: { author: 'A. Scrivener' },
    }),
  );
  assert.ok(started.id);

  const events = await watch(started.id);
  assert.equal(events[0].name, 'start');
  assert.equal(events.at(-1).name, 'done');

  const article = articleOf(events);
  assert.match(article, /^TITLE The Ledger$/m);
  assert.match(article, /^BYLINE A\. Scrivener$/m);
  assert.match(article, /^LI one item$/m);

  const { pieces } = await json('/api/library');
  const shelved = pieces.find((piece) => piece.id === started.id);
  assert.equal(shelved.status, 'done');
  assert.equal(shelved.title, 'The Ledger', 'the shelf takes the title from the article');

  const back = await json(`/api/library/${started.id}`);
  assert.equal(back.protocol, article, 'what was streamed is what was kept');
});

test('a page that arrives late is caught up in full', async () => {
  const started = await json('/api/run', post({ text: 'A Title\n\nA paragraph of text.' }));
  await watch(started.id);

  // Attaching after the fact replays everything, then reports it finished.
  const events = await watch(started.id);
  assert.equal(events[0].name, 'start');
  assert.equal(events[0].data.resumed, true);
  assert.match(articleOf(events), /^TITLE A Title$/m);
  assert.equal(events.at(-1).name, 'done');
});

test('a piece can be taken off the shelf', async () => {
  const started = await json('/api/run', post({ text: 'Gone Soon\n\nBody.' }));
  await watch(started.id);
  assert.deepEqual(await json(`/api/library/${started.id}`, { method: 'DELETE' }), {
    removed: true,
  });
  const { pieces } = await json('/api/library');
  assert.ok(!pieces.some((piece) => piece.id === started.id));
});

test('refuses an empty run', async () => {
  const response = await fetch(`${base}/api/run`, post({ text: '   ' }));
  assert.equal(response.status, 400);
});

test('will not pretend to translate without a key', async () => {
  const response = await fetch(
    `${base}/api/run`,
    post({ text: 'Some English text here.', mode: 'translate', targetLang: 'ru' }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /needs an API key/);
});

test('answers a word lookup even with nothing configured', async () => {
  const card = await json(
    '/api/word',
    post({ word: 'ledger', sentence: 'He kept a ledger.', targetLang: 'ru' }),
  );
  assert.equal(card.word, 'ledger');
  assert.ok('source' in card || 'translation' in card);
});

test('will not fetch an address on your own network', async () => {
  const result = await json('/api/fetch', post({ url: 'http://192.168.0.1/secrets' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /your own network/);
});

test('will not fetch a non-http scheme', async () => {
  const result = await json('/api/fetch', post({ url: 'file:///etc/passwd' }));
  assert.equal(result.ok, false);
});

test('an unknown job is a 404, not a hang', async () => {
  const response = await fetch(`${base}/api/job/deadbeefdead`);
  assert.equal(response.status, 404);
});
