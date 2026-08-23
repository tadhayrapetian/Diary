import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkText,
  createProtocolFilter,
  typesetWithModel,
  pieceCount,
  nameOfLanguage,
} from '../server/typeset.js';
import { typesetLocally } from '../server/local.js';
import { lookUp, languageName } from '../server/lexicon.js';

// ------------------------------------------------------------------ chunking

test('splits long text at paragraph boundaries', () => {
  const text = ['a'.repeat(90), 'b'.repeat(90), 'c'.repeat(90)].join('\n\n');
  const chunks = chunkText(text, 200);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.equal(chunks.join('\n\n'), text, 'nothing is lost in the cutting');
});

test('cuts a single runaway paragraph at a sentence end', () => {
  const sentence = 'This is a sentence of a fairly ordinary length. ';
  const chunks = chunkText(sentence.repeat(20), 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) {
    assert.match(chunk, /\.$/, 'each piece ends on a full stop');
  }
});

test('short text stays in one piece', () => {
  assert.deepEqual(chunkText('Just a line.'), ['Just a line.']);
  assert.deepEqual(chunkText('   '), []);
});

// ------------------------------------------------------------ protocol filter

test('drops a preamble and code fences before the first real block', () => {
  let out = '';
  const filter = createProtocolFilter((text) => (out += text));
  filter.push('Here is the article you asked for:\n```\n');
  filter.push('TITLE The Led');
  filter.push('ger\nP Body.\n');
  filter.end();
  assert.equal(out, 'TITLE The Ledger\nP Body.\n');
});

test('recognises the opening tag even when it is split across chunks', () => {
  let out = '';
  const filter = createProtocolFilter((text) => (out += text));
  filter.push('TIT');
  filter.push('LE Straight in\n');
  filter.end();
  assert.equal(out, 'TITLE Straight in\n');
});

test('passes everything through once it has started', () => {
  let out = '';
  const filter = createProtocolFilter((text) => (out += text));
  filter.push('P One.\n');
  filter.push('Not a tag but mid-article, so it stays.\n');
  filter.end();
  assert.match(out, /Not a tag but mid-article/);
});

// -------------------------------------------------------------- the model path

/** Stands in for the SDK: each script entry is one call's worth of deltas. */
function stubClient(scripts) {
  const calls = [];
  const stream = (params) => {
    const index = calls.length;
    calls.push(params);
    const script = scripts[index] ?? { chunks: [] };
    if (script.throws) throw script.throws;
    return {
      async *[Symbol.asyncIterator]() {
        for (const text of script.chunks) {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
        }
      },
      finalMessage: async () => ({
        stop_reason: script.stop || 'end_turn',
        stop_details: script.details || null,
        content: [{ type: 'text', text: (script.chunks || []).join('') }],
      }),
    };
  };
  return {
    calls,
    beta: { messages: { stream } },
    messages: { stream },
  };
}

const deps = (client, extra = {}) => ({
  client,
  model: 'test-model',
  prompt: 'system prompt',
  fast: false,
  onText: extra.onText,
  onProgress: extra.onProgress,
  signal: extra.signal,
  surveyPrompt: extra.surveyPrompt,
});

test('streams a single piece straight through', async () => {
  const client = stubClient([{ chunks: ['TITLE A\n', 'P Body.\n'] }]);
  let out = '';
  await typesetWithModel({ text: 'source', meta: {} }, deps(client, { onText: (t) => (out += t) }));
  assert.equal(out, 'TITLE A\nP Body.\n');
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].messages[0].content[0].text, /Set the following text as an article/);
});

test('tells each later piece what came before it', async () => {
  const long = ['x'.repeat(20_000), 'y'.repeat(20_000)].join('\n\n');
  const client = stubClient([
    { chunks: ['TITLE A\nH2 The first turn\nP One.\n'] },
    { chunks: ['P Two.\n'] },
  ]);
  const progress = [];
  await typesetWithModel(
    { text: long, meta: { title: 'From the file' } },
    deps(client, { onText: () => {}, onProgress: (p) => progress.push(p) }),
  );

  assert.equal(client.calls.length, 2);
  assert.deepEqual(progress, [{ piece: 1, of: 2 }, { piece: 2, of: 2 }]);

  const first = client.calls[0].messages[0].content[0].text;
  assert.match(first, /title as "From the file"/);
  assert.match(first, /first of 2 pieces/);

  const second = client.calls[1].messages[0].content[0].text;
  assert.match(second, /piece 2 of 2/);
  assert.match(second, /do not repeat them/);
  assert.match(second, /"The first turn"/, 'the open section is carried across');
  assert.match(second, /last piece/);
});

test('a filename is offered to the typesetter as a maybe, not as a title', async () => {
  const client = stubClient([{ chunks: ['TITLE A\n'] }]);
  await typesetWithModel(
    { text: 'source', meta: { name: 'scan-final-3' } },
    deps(client, { onText: () => {} }),
  );
  const framing = client.calls[0].messages[0].content[0].text;
  assert.match(framing, /called "scan-final-3", which may or may not be its real title/);
});

test('a scan is sent as a document instead of as text', async () => {
  const client = stubClient([{ chunks: ['TITLE Scanned\n'] }]);
  await typesetWithModel(
    { text: '', meta: {}, pdf: { data: 'YmFzZTY0' } },
    deps(client, { onText: () => {} }),
  );
  const content = client.calls[0].messages[0].content;
  assert.equal(content[0].type, 'document');
  assert.equal(content[0].source.media_type, 'application/pdf');
  assert.match(content[1].text, /no text layer/);
});

test('falls back to the plain endpoint when the beta one will not have it', async () => {
  const client = stubClient([
    { throws: new Error('beta not enabled') },
    { chunks: ['TITLE Recovered\n'] },
  ]);
  let out = '';
  await typesetWithModel({ text: 'source', meta: {} }, deps(client, { onText: (t) => (out += t) }));
  assert.equal(out, 'TITLE Recovered\n');
  assert.equal(client.calls.length, 2);
});

test('a refusal is reported in the article rather than swallowed', async () => {
  const client = stubClient([
    {
      chunks: ['TITLE Partial\n'],
      stop: 'refusal',
      details: { explanation: 'it declined' },
    },
  ]);
  let out = '';
  await typesetWithModel({ text: 'source', meta: {} }, deps(client, { onText: (t) => (out += t) }));
  assert.match(out, /NOTE .*it declined/);
});

test('a piece is given a second round before it is given up on', async () => {
  const client = stubClient([
    { throws: new Error('flaky') },
    { throws: new Error('flaky') },
    { throws: new Error('flaky') },
    { chunks: ['TITLE Recovered on the second round\n'] },
  ]);
  let out = '';
  await typesetWithModel({ text: 'source', meta: {} }, deps(client, { onText: (t) => (out += t) }));
  assert.match(out, /Recovered on the second round/);
});

test('a failure with nothing written yet is thrown, not hidden', async () => {
  const down = { throws: new Error('down') };
  const client = stubClient(Array.from({ length: 8 }, () => down));
  await assert.rejects(
    () => typesetWithModel({ text: 'source', meta: {} }, deps(client, { onText: () => {} })),
    /down/,
  );
});

test('a book carries on past a piece that will not come', async () => {
  const long = ['x'.repeat(20_000), 'y'.repeat(20_000), 'z'.repeat(20_000)].join('\n\n');
  const down = { throws: new Error('down') };
  const client = stubClient([
    { chunks: ['TITLE A\nP One.\n'] },
    down, down, down, down, down, down, // the second piece, both rounds
    { chunks: ['P Three.\n'] },
  ]);
  let out = '';
  await typesetWithModel({ text: long, meta: {} }, deps(client, { onText: (t) => (out += t) }));
  assert.match(out, /TITLE A/);
  assert.match(out, /NOTE Piece 2 of 3 could not be done/);
  assert.match(out, /P Three\./, 'the piece after the failure is still done');
});

// ------------------------------------------------------------------ translating

test('a translation is asked for in the target language, and told the source', async () => {
  const client = stubClient([{ chunks: ['TITLE Ледяной дом\n'] }]);
  await typesetWithModel(
    {
      text: 'source',
      meta: { title: 'The House of Ice' },
      mode: 'translate',
      sourceLang: 'en',
      targetLang: 'ru',
    },
    deps(client, { onText: () => {} }),
  );
  const framing = client.calls[0].messages[0].content[0].text;
  assert.match(framing, /Translate the following into Russian/);
  assert.match(framing, /written in English/);
  assert.match(framing, /title as "The House of Ice"/);
});

test('terms settled in one piece are handed to the next', async () => {
  const long = ['x'.repeat(28_000), 'y'.repeat(28_000)].join('\n\n');
  const client = stubClient([
    { chunks: ['P Одна.\nTERM Ravenwood :: Рейвенвуд\nTERM the Warden :: Смотритель\n'] },
    { chunks: ['P Две.\n'] },
  ]);
  await typesetWithModel(
    { text: long, mode: 'translate', sourceLang: 'en', targetLang: 'ru', meta: {} },
    deps(client, { onText: () => {} }),
  );
  const second = client.calls[1].messages[0].content[0].text;
  assert.match(second, /Terms already settled/);
  assert.match(second, /Ravenwood = Рейвенвуд/);
  assert.match(second, /the Warden = Смотритель/);
  assert.match(second, /resume mid-sentence/);
});

test('the whole work is read once before any of it is translated', async () => {
  const long = ['x'.repeat(28_000), 'y'.repeat(28_000)].join('\n\n');
  const client = stubClient([
    // The survey: one read of everything, a short note back.
    {
      chunks: [
        'INTO Russian\n',
        'REGISTER A wry first-person memoir, spoken rather than written.\n',
        'ADDRESS The narrator is familiar with his brother and formal with everyone else.\n',
        'TERM Ravenwood :: Рейвенвуд\nTERM the Warden :: Смотритель\n',
      ],
    },
    { chunks: ['TITLE Рейвенвуд\nP Одна.\n'] },
    { chunks: ['P Две.\n'] },
  ]);

  const progress = [];
  await typesetWithModel(
    { text: long, mode: 'translate', sourceLang: 'en', targetLang: 'ru', meta: {} },
    deps(client, {
      onText: () => {},
      onProgress: (p) => progress.push(p),
      surveyPrompt: 'survey prompt',
    }),
  );

  assert.equal(client.calls.length, 3, 'one survey, then the two pieces');
  assert.match(client.calls[0].messages[0].content, /translating this into Russian/);

  // The first piece already knows the names the last piece will use.
  const first = client.calls[1].messages[0].content[0].text;
  assert.match(first, /Ravenwood = Рейвенвуд/);
  assert.match(first, /the Warden = Смотритель/);
  assert.match(first, /wry first-person memoir/);
  assert.match(first, /familiar with his brother/);

  assert.deepEqual(progress[0], { piece: 0, of: 2, surveying: true });
});

test('a failed survey is a shrug, not a stopped book', async () => {
  const long = ['x'.repeat(28_000), 'y'.repeat(28_000)].join('\n\n');
  const client = stubClient([
    { throws: new Error('survey down') },
    { chunks: ['TITLE Всё равно\n'] },
    { chunks: ['P Две.\n'] },
  ]);
  let out = '';
  await typesetWithModel(
    { text: long, mode: 'translate', sourceLang: 'en', targetLang: 'ru', meta: {} },
    deps(client, { onText: (t) => (out += t), surveyPrompt: 'survey prompt' }),
  );
  assert.match(out, /TITLE Всё равно/);
  assert.match(out, /P Две\./);
});

test('short pieces and plain typesetting are not surveyed', async () => {
  const client = stubClient([{ chunks: ['TITLE Short\n'] }]);
  await typesetWithModel(
    { text: 'A short text.', mode: 'translate', sourceLang: 'en', targetLang: 'ru', meta: {} },
    deps(client, { onText: () => {}, surveyPrompt: 'survey prompt' }),
  );
  assert.equal(client.calls.length, 1, 'nothing to hold together, so no survey');
});

test('facing pages are cut smaller, since both languages come back', () => {
  const text = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} `.repeat(60)).join('\n\n');
  assert.ok(
    pieceCount(text, 'bilingual') > pieceCount(text, 'translate'),
    'more pieces when each one has to carry the original too',
  );
  assert.ok(pieceCount(text, 'translate') >= 1);
});

test('a truncated piece says so rather than pretending to be whole', async () => {
  const client = stubClient([{ chunks: ['P Something long\n'], stop: 'max_tokens' }]);
  let out = '';
  await typesetWithModel({ text: 'source', meta: {} }, deps(client, { onText: (t) => (out += t) }));
  assert.match(out, /NOTE A long stretch here ran past the limit/);
});

// ---------------------------------------------------------- the local fallback

test('the local typesetter reads the shape of plain text', () => {
  const lines = typesetLocally(
    [
      'THE LEDGER OF SMALL HOURS',
      'It was a bright cold day.',
      'A SECOND MOVEMENT',
      '- first item',
      '1. numbered item',
      '> A quotation.',
      '# A marked heading',
      '---',
      'Closing paragraph.',
    ].join('\n\n'),
    { author: 'A. Scrivener' },
  );

  assert.equal(lines[0], 'TITLE The Ledger of Small Hours');
  assert.equal(lines[1], 'BYLINE A. Scrivener');
  assert.ok(lines.includes('H2 A second movement'), 'a shouting heading is calmed');
  assert.ok(lines.includes('LI first item'));
  assert.ok(lines.includes('NLI numbered item'));
  assert.ok(lines.includes('QUOTE A quotation.'));
  assert.ok(lines.includes('H2 A marked heading'));
  assert.ok(lines.includes('HR'));
  assert.ok(lines.at(-1).startsWith('P Closing'));
});

test('the local typesetter sets straight quotes properly', () => {
  const lines = typesetLocally('Title Here\n\nHe said "no" -- it was the narrator\'s idea...');
  const body = lines.find((line) => line.startsWith('P '));
  assert.equal(body, 'P He said “no” — it was the narrator’s idea…');
});

test('the local typesetter never returns nothing', () => {
  assert.deepEqual(typesetLocally(''), ['P (nothing to read)']);
});

// -------------------------------------------------------------------- lexicon

test('names the languages it is given, and passes the rest through', () => {
  assert.equal(languageName('ru'), 'Russian');
  assert.equal(languageName('RU'), 'Russian');
  assert.equal(languageName('xx'), 'xx');
});

test('a word is looked up once and then remembered', async () => {
  const card = {
    word: 'ledger', lemma: 'ledger', ipa: '/ˈledʒə/', pos: 'noun',
    translation: 'бухгалтерская книга', meaning: 'an account book',
    note: '', example: '', forms: '', etymology: '', unknown: false, senses: [],
  };
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls++;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(card) }] };
      },
    },
  };
  const query = { word: 'ledger', sentence: 'He kept a ledger.', targetLang: 'ru' };
  const first = await lookUp(query, { client, model: 'm', prompt: 'p' });
  assert.equal(first.translation, 'бухгалтерская книга');
  assert.equal(first.ipa, 'ˈledʒə', 'the slashes are stripped for the page to add back');

  const second = await lookUp(query, { client, model: 'm', prompt: 'p' });
  assert.equal(second.cached, true);
  assert.equal(calls, 1, 'the second tap costs nothing');
});

test('a lookup that comes back unreadable says so', async () => {
  const client = {
    messages: {
      create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }),
    },
  };
  await assert.rejects(
    () => lookUp({ word: 'zzzz-unique', targetLang: 'ru' }, { client, model: 'm', prompt: 'p' }),
    /could not read/,
  );
});
