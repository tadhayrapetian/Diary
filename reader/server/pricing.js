/**
 * What the work costs, so the button can say so before it is pressed.
 *
 * These are Anthropic's published first-party rates in dollars per million
 * tokens, as of August 2026. They are here rather than in the browser because
 * the server is what knows which model is actually doing the work — and they
 * are in one table rather than scattered about because prices change and this
 * should be a one-line edit when they do.
 *
 * A model that is not in the table costs an unknown amount, and says so, rather
 * than guessing at a number someone might budget against.
 */

const RATES = {
  'claude-fable-5': { input: 10, output: 50, speed: 55 },
  'claude-mythos-5': { input: 10, output: 50, speed: 55 },
  'claude-opus-5': { input: 5, output: 25, speed: 70 },
  'claude-opus-4-8': { input: 5, output: 25, speed: 70 },
  'claude-opus-4-7': { input: 5, output: 25, speed: 70 },
  'claude-opus-4-6': { input: 5, output: 25, speed: 70 },
  'claude-sonnet-5': {
    input: 3,
    output: 15,
    speed: 90,
    // An introductory rate, which stops of its own accord.
    intro: { input: 2, output: 10, until: '2026-08-31T23:59:59Z' },
  },
  'claude-sonnet-4-6': { input: 3, output: 15, speed: 90 },
  'claude-haiku-4-5': { input: 1, output: 5, speed: 140 },
};

/** Fast mode is the same model at premium pricing, on the Opus tier only. */
const FAST_RATES = { input: 10, output: 50, speed: 175 };
const FAST_MODELS = new Set(['claude-opus-5', 'claude-opus-4-8']);

/**
 * @param {string} model
 * @param {{fast?: boolean, at?: Date}} options
 * @returns {{input: number, output: number, speed: number, known: boolean}}
 *   `known: false` means the price is a guess and should not be shown as one.
 */
export function ratesFor(model, { fast = false, at = new Date() } = {}) {
  const base = RATES[model];
  if (!base) return { input: 0, output: 0, speed: 70, known: false };
  if (fast && FAST_MODELS.has(model)) return { ...FAST_RATES, known: true };
  if (base.intro && at < new Date(base.intro.until)) {
    return { ...base.intro, speed: base.speed, known: true };
  }
  const { intro, ...rest } = base;
  return { ...rest, known: true };
}

export const priced = (model) => Boolean(RATES[model]);
