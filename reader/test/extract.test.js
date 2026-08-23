import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract, htmlToText, decodeEntities, repairProse } from '../server/extract.js';
import { extractPdf } from '../server/pdf.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(fixtures, name));

test('reads a real pdf back into paragraphs', () => {
  const result = extractPdf(read('typeset.pdf'));
  assert.ok(result.ok, result.reason);
  assert.equal(result.pageCount, 2);

  // Justified lines rejoin into flowing prose, not one line per line of type.
  assert.match(
    result.text,
    /It was a bright cold day in April, and the clocks were striking thirteen\./,
  );
  assert.match(result.text, /never quite recovered from the burden of being quoted at parties\./);

  // Accents and real quotation marks survive the font's encoding.
  assert.match(result.text, /naïve café owner in Señor Márquez’s story/);
  assert.match(result.text, /“One must imagine Sisyphus happy,”/);

  // Paragraph breaks are found, and the title is kept.
  assert.ok(result.text.startsWith('# The Ledger of Small Hours'));
  assert.ok(result.text.split('\n\n').length >= 5, 'several paragraphs');
});

test('keeps the headings the page set in larger type', () => {
  const { text } = extractPdf(read('typeset.pdf'));
  // The one structural fact a layout really does carry is type size.
  assert.match(text, /^# The Ledger of Small Hours$/m, 'the title is the largest');
  assert.match(text, /^## A second movement$/m, 'the section heading is next');
  assert.equal(
    (text.match(/^#{1,2} /gm) || []).length,
    2,
    'body paragraphs are not mistaken for headings',
  );
});

test('drops running heads and page numbers, but not the title they echo', () => {
  const { text } = extractPdf(read('typeset.pdf'));
  assert.ok(!/^\d+$/m.test(text), 'no bare page numbers survive');
  assert.equal(
    (text.match(/LEDGER OF SMALL HOURS/g) || []).length,
    0,
    'the running head is gone',
  );
  assert.ok(text.includes('The Ledger of Small Hours'), 'the title is not');
});

test('rejects things that are not pdfs', () => {
  const result = extractPdf(Buffer.from('this is just some text'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not a pdf');
});

test('reads a docx, with its styles as structure', () => {
  const result = extract(read('sample.docx'), 'sample.docx');
  assert.equal(result.kind, 'docx');
  assert.ok(result.ok);
  assert.equal(result.meta.title, 'On the Keeping of Ledgers');
  assert.equal(result.meta.author, 'A. Scrivener');
  assert.match(result.text, /^# On the Keeping of Ledgers/);
  assert.match(result.text, /^# The second movement$/m);
  assert.match(result.text, /^> One must imagine Sisyphus happy\.$/m);
  assert.match(result.text, /^- First item & a note$/m);
  assert.match(result.text, /A café in Señor Márquez’s story\./);
  // Runs inside one paragraph rejoin without losing the spaces between them.
  assert.match(result.text, /the clocks were striking thirteen\./);
});

test('reads an epub in spine order, not file order', () => {
  const result = extract(read('sample.epub'), 'sample.epub');
  assert.equal(result.kind, 'epub');
  assert.equal(result.meta.title, 'A Short Book');
  assert.ok(
    result.text.indexOf('Chapter One') < result.text.indexOf('Chapter Two'),
    'the spine decides the order',
  );
});

test('reads html down to its readable part', () => {
  const result = extract(read('page.html'), 'page.html');
  assert.equal(result.kind, 'html');
  assert.equal(result.meta.title, 'A Web Page');
  assert.ok(!result.text.includes('skip me'), 'navigation is dropped');
  assert.ok(!result.text.includes('var a=1'), 'scripts are dropped');
  assert.match(result.text, /^# The Ledger$/m);
  assert.match(result.text, /^> Quoted wisdom\.$/m);
  assert.match(result.text, /an & and a — dash/);
});

test('sniffs the format from the bytes when the name lies', () => {
  assert.equal(extract(read('typeset.pdf'), 'mystery.bin').kind, 'pdf');
  assert.equal(extract(read('sample.docx'), 'mystery.bin').kind, 'docx');
  assert.equal(extract(Buffer.from('<html><body><p>hi</p></body></html>'), 'x').kind, 'html');
});

test('decodes entities, including the numeric ones', () => {
  assert.equal(decodeEntities('a &amp; b &mdash; c &#233; &#x2014; &nosuchthing;'),
    'a & b — c é — &nosuchthing;');
});

test('repairs prose broken by a page layout', () => {
  assert.equal(repairProse('care-\nfully done'), 'carefully done');
  assert.equal(repairProse('Anglo-\nSaxon'), 'Anglo-\nSaxon', 'a real hyphen is kept');
  assert.equal(repairProse('one line\nnext line'), 'one line next line');
  assert.equal(
    repairProse('one paragraph\n\nanother paragraph'),
    'one paragraph\n\nanother paragraph',
    'blank lines are paragraph breaks and stay',
  );
  assert.equal(repairProse('the oﬃce aﬀair'), 'the office affair');
});

test('an unreadable file says so rather than pretending', () => {
  const result = extract(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), 'weird.zip');
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsupported/);
});

test('html without an article element still yields its body', () => {
  const { text } = htmlToText('<html><body><p>One.</p><p>Two.</p></body></html>');
  assert.equal(text, 'One.\n\nTwo.');
});
