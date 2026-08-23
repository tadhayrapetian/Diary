import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLine,
  createBlockStream,
  renderInline,
  tokenizeWords,
  blockToHtml,
  readingMinutes,
} from '../public/blocks.js';

test('parses each kind of block', () => {
  assert.deepEqual(parseLine('TITLE The Ledger'), { type: 'title', text: 'The Ledger' });
  assert.deepEqual(parseLine('HR'), { type: 'hr' });
  assert.deepEqual(parseLine('QUOTE Be happy. :: Camus'), {
    type: 'quote',
    text: 'Be happy.',
    attribution: 'Camus',
  });
  assert.deepEqual(parseLine('QUOTE No attribution here'), {
    type: 'quote',
    text: 'No attribution here',
    attribution: '',
  });
  assert.deepEqual(parseLine('TERM sublime :: of the highest order'), {
    type: 'term',
    word: 'sublime',
    gloss: 'of the highest order',
  });
});

test('treats an unknown tag as prose rather than losing it', () => {
  assert.deepEqual(parseLine('WIDGET nonsense'), { type: 'p', text: 'WIDGET nonsense' });
  assert.deepEqual(parseLine('Here is the article:'), {
    type: 'p',
    text: 'Here is the article:',
  });
  assert.equal(parseLine('   '), null);
});

test('a quote with :: in its text keeps the last one as the attribution', () => {
  assert.deepEqual(parseLine('QUOTE a :: b :: Camus'), {
    type: 'quote',
    text: 'a :: b',
    attribution: 'Camus',
  });
});

test('streams partial lines, then closes them', () => {
  const seen = [];
  const stream = createBlockStream((block, index, done) =>
    seen.push([index, done, block.type, block.text]),
  );
  stream.push('TITLE The Led');
  stream.push('ger\nP It was a bri');
  stream.push('ght day.\n');
  stream.end();

  assert.deepEqual(seen, [
    [0, false, 'title', 'The Led'],
    [0, true, 'title', 'The Ledger'],
    [1, false, 'p', 'It was a bri'],
    [1, true, 'p', 'It was a bright day.'],
  ]);
});

test('holds back a bare run of capitals that may still become a tag', () => {
  const seen = [];
  const stream = createBlockStream((block) => seen.push(block.type));
  stream.push('QUO');
  assert.deepEqual(seen, [], 'nothing rendered while the tag is ambiguous');
  stream.push('TE Be happy.');
  assert.deepEqual(seen, ['quote']);
});

test('closes an unterminated final block at the end of the stream', () => {
  const seen = [];
  const stream = createBlockStream((block, index, done) => seen.push([block.text, done]));
  stream.push('P A sentence that stops mid');
  stream.end();
  assert.equal(seen.at(-1)[1], true);
  assert.equal(seen.at(-1)[0], 'A sentence that stops mid');
});

test('every word becomes its own element', () => {
  const html = tokenizeWords("don't well-known café.");
  assert.equal(html, "<w->don't</w-> <w->well-known</w-> <w->café</w->.");
});

test('escapes markup that arrives in the text', () => {
  const html = tokenizeWords('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;'));
});

test('emphasis wraps the words rather than breaking them', () => {
  assert.equal(
    renderInline('a **bold** word'),
    '<w->a</w-> <strong><w->bold</w-></strong> <w->word</w->',
  );
  assert.equal(
    renderInline('an _italic_ word'),
    '<w->an</w-> <em><w->italic</w-></em> <w->word</w->',
  );
  assert.ok(
    !renderInline('snake_case_name stays').includes('<em>'),
    'underscores inside a word are not emphasis',
  );
  assert.ok(
    !renderInline('a * lone asterisk').includes('<strong>'),
    'a stray asterisk is not emphasis',
  );
});

test('renders the blocks it is given', () => {
  assert.match(blockToHtml({ type: 'title', text: 'Hi' }), /^<h1 class="a-title">/);
  assert.match(blockToHtml({ type: 'p', text: 'Hi' }, { lead: true }), /a-p a-lead/);
  assert.match(
    blockToHtml({ type: 'h2', text: 'Hi' }, { id: 's4' }),
    /<h2 class="a-h2" id="s4">/,
  );
  assert.match(
    blockToHtml({ type: 'quote', text: 'Hi', attribution: 'Camus' }),
    /<cite><w->Camus<\/w-><\/cite>/,
  );
  assert.equal(blockToHtml({ type: 'term', word: 'a', gloss: 'b' }), '');
});

test('reading time never rounds down to nothing', () => {
  assert.equal(readingMinutes(3), 1);
  assert.equal(readingMinutes(2200), 10);
});
