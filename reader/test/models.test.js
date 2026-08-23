import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A key, so the server takes the path it takes in real use. Nothing is called.
process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key';
process.env.LECTERN_MODEL = 'claude-sonnet-5';
process.env.LECTERN_LOOKUP_MODEL = 'claude-haiku-4-5';
const shelf = mkdtempSync(join(tmpdir(), 'lectern-models-'));
process.env.LECTERN_LIBRARY = shelf;

const { server } = await import('../server/server.js');
let base = '';

before(async () => {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(shelf, { recursive: true, force: true });
});

test('each part of the work is quoted at the price of the model doing it', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();

  assert.equal(state.model, 'claude-sonnet-5');
  assert.equal(state.lookupModel, 'claude-haiku-4-5');
  assert.equal(state.surveyModel, 'claude-sonnet-5', 'the survey follows the main model');

  // Sonnet 5 while its introductory rate lasts, and Haiku for the word cards.
  assert.equal(state.rates.known, true);
  assert.ok(state.rates.input <= 3, `input quoted at ${state.rates.input}`);
  assert.equal(state.lookupRates.input, 1);
  assert.equal(state.lookupRates.output, 5);

  assert.ok(
    state.lookupRates.output < state.rates.output,
    'looking a word up must not cost what translating a page costs',
  );
});
