/**
 * node --test server/ink.test.js
 *
 * The splitter sits between a model's token stream and a quill that cannot
 * un-write a mistake, so it is worth being sure about. Every case here is
 * something a real stream has a plausible chance of doing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplySplitter, InkSanitizer } from './ink.js';

function run(chunks) {
  const out = { transcript: undefined, ink: '' };
  const splitter = new ReplySplitter({
    onTranscript: (t) => {
      out.transcript = t;
    },
    onInk: (t) => {
      out.ink += t;
    },
  });
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return out;
}

test('splits a well-formed reply', () => {
  const r = run(['⟦Hello there⟧\n', 'How do you do. ', 'I am Tom Riddle.']);
  assert.equal(r.transcript, 'Hello there');
  assert.equal(r.ink, 'How do you do. I am Tom Riddle.');
});

test('survives the delimiters landing on chunk boundaries', () => {
  const whole = '⟦What is your name?⟧\nTom Riddle. And yours?';
  for (let cut = 1; cut < whole.length; cut += 1) {
    const r = run([whole.slice(0, cut), whole.slice(cut)]);
    assert.equal(r.transcript, 'What is your name?', `cut at ${cut}`);
    assert.equal(r.ink, 'Tom Riddle. And yours?', `cut at ${cut}`);
  }
});

test('survives one character at a time', () => {
  const whole = '⟦hi⟧\nGood evening.';
  const r = run([...whole]);
  assert.equal(r.transcript, 'hi');
  assert.equal(r.ink, 'Good evening.');
});

test('falls back to all-ink when the protocol is ignored', () => {
  const r = run(['How do you do. ', 'I am Tom Riddle.']);
  assert.equal(r.transcript, undefined);
  assert.equal(r.ink, 'How do you do. I am Tom Riddle.');
});

test('salvages an unclosed transcript bracket', () => {
  const r = run(['⟦the writer asked about the chamber']);
  assert.equal(r.transcript, undefined);
  assert.match(r.ink, /the writer asked about the chamber/);
});

test('strips leaked thinking tags without eating the reply', () => {
  const r = run([
    '⟦hello⟧\n',
    '<thinking>The writer greets me.</thinking>',
    'How do you do.',
  ]);
  assert.equal(r.ink, 'How do you do.');
});

test('strips a tag split across chunks', () => {
  const r = run(['⟦x⟧\n', 'Good ', '<em', 'phasis>', 'evening.']);
  assert.equal(r.ink, 'Good evening.');
});

test('strips markdown punctuation the page cannot render', () => {
  const r = run(['⟦x⟧\n', '**Curious.** I have _read_ `worse` than that. ## no']);
  assert.equal(r.ink, 'Curious. I have read worse than that. no');
});

test('keeps a lone less-than that is not a tag', () => {
  const r = run(['⟦x⟧\n', 'It is 3 < 5, plainly, and no more than that.']);
  assert.match(r.ink, /3 < 5/);
});

test('trims leading whitespace but preserves internal breaks', () => {
  const r = run(['⟦x⟧', '\n\n  ', 'First line.\nSecond line.']);
  assert.equal(r.ink, 'First line.\nSecond line.');
});

test('collapses runaway blank lines', () => {
  const r = run(['⟦x⟧\n', 'One.\n\n\n\n\nTwo.']);
  assert.equal(r.ink, 'One.\n\nTwo.');
});

test('handles a transcript arriving in many pieces', () => {
  const r = run(['⟦', 'Dear ', 'diary, ', 'I am ', 'lost', '⟧', '\nThen be found.']);
  assert.equal(r.transcript, 'Dear diary, I am lost');
  assert.equal(r.ink, 'Then be found.');
});

test('an illegible page still yields a reply', () => {
  const r = run(['⟦illegible⟧\n', 'Your hand runs away from you. Write it again.']);
  assert.equal(r.transcript, 'illegible');
  assert.equal(r.ink, 'Your hand runs away from you. Write it again.');
});

test('suppresses a thinking block split across many chunks', () => {
  const r = run([
    '⟦x⟧\n',
    'Before. <think',
    'ing>secret ',
    'reasoning here</th',
    'inking> After.',
  ]);
  assert.equal(r.ink, 'Before. After.');
});

test('suppresses a namespaced thinking block', () => {
  const r = run(['⟦x⟧\n', 'A<thinking>hidden</thinking>B']);
  assert.equal(r.ink, 'AB');
});

test('recovers if a suppressed block is never closed', () => {
  const r = run(['⟦x⟧\n', 'Start. <scratchpad>', 'y'.repeat(5000), 'visible tail']);
  assert.match(r.ink, /^Start\. /);
  assert.match(r.ink, /visible tail$/);
  assert.ok(!r.ink.includes('yyyy'), 'the suppressed run should be dropped');
});

test('a stream ending mid-suppression writes nothing extra', () => {
  const r = run(['⟦x⟧\n', 'Kept. <thinking>never closed']);
  assert.equal(r.ink, 'Kept. ');
});

test('sanitizer flushes a held tail that never became a tag', () => {
  const s = new InkSanitizer();
  const first = s.push('done <');
  assert.equal(first, 'done ');
  assert.equal(s.flush(), '<');
});

test('empty stream produces nothing rather than throwing', () => {
  const r = run([]);
  assert.equal(r.ink, '');
  assert.equal(r.transcript, undefined);
});

test('whitespace-only stream produces nothing', () => {
  const r = run(['   ', '\n\n']);
  assert.equal(r.ink, '');
});
