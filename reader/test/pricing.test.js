import test from 'node:test';
import assert from 'node:assert/strict';

import { ratesFor, priced } from '../server/pricing.js';

test('quotes the published rate for a model it knows', () => {
  assert.deepEqual(ratesFor('claude-opus-5'), {
    input: 5,
    output: 25,
    speed: 70,
    known: true,
  });
  assert.equal(ratesFor('claude-haiku-4-5').output, 5);
});

test('an introductory rate applies while it lasts, and then stops', () => {
  const during = ratesFor('claude-sonnet-5', { at: new Date('2026-08-23') });
  assert.equal(during.input, 2);
  assert.equal(during.output, 10);

  const after = ratesFor('claude-sonnet-5', { at: new Date('2026-09-15') });
  assert.equal(after.input, 3);
  assert.equal(after.output, 15);
  assert.ok(!('intro' in after), 'the offer does not leak into the quote');
});

test('fast mode is the same model at premium prices', () => {
  const fast = ratesFor('claude-opus-5', { fast: true });
  assert.equal(fast.input, 10);
  assert.equal(fast.output, 50);
  assert.ok(fast.speed > ratesFor('claude-opus-5').speed, 'and it is faster');
});

test('fast mode is not offered on models that do not have it', () => {
  assert.deepEqual(
    ratesFor('claude-haiku-4-5', { fast: true }),
    ratesFor('claude-haiku-4-5'),
  );
});

test('a model it does not know says so rather than inventing a price', () => {
  const unknown = ratesFor('some-model-from-next-year');
  assert.equal(unknown.known, false);
  assert.equal(unknown.input, 0);
  assert.equal(priced('some-model-from-next-year'), false);
  assert.equal(priced('claude-opus-5'), true);
});
