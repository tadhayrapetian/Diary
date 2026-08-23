/**
 * Raw text in, article protocol out, streamed.
 *
 * Three things can be asked of it: set the text as an article, translate it, or
 * translate it facing the original. All three produce the same block protocol,
 * so the page that renders one renders all of them.
 *
 * A book does not fit in one response, so it is cut into pieces and run one
 * after another. Two things make the seams invisible: each piece is told what
 * came before it, and the names and terms a piece settles are handed forward to
 * the next, so a character is not called one thing in chapter two and something
 * else in chapter nine.
 */

import { TAGS } from '../public/blocks.js';

/** How much source goes into one request. Facing pages emit both, so less. */
const CHUNK_CHARS = { typeset: 24_000, translate: 30_000, bilingual: 18_000 };

/**
 * Generous, because running out mid-paragraph loses text. Russian from English
 * runs to maybe twenty thousand tokens for a thirty-thousand-character piece,
 * so this is roughly three times what the work should need.
 */
const MAX_TOKENS = 64_000;

/** Terms handed forward from piece to piece: a cast of characters, not an index. */
const GLOSSARY_LIMIT = 60;

/** The survey reads the work whole — a million characters still fits in one go. */
const SURVEY_CHARS = 2_400_000;
const SURVEY_TERMS = 220;
/** Below this there is nothing for a survey to hold together. */
const SURVEY_FLOOR = 40_000;

/** Split on paragraph boundaries, never mid-sentence. */
export function chunkText(text, limit = CHUNK_CHARS.typeset) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (let paragraph of paragraphs) {
    // A single paragraph longer than a whole chunk — a wall of text with no
    // breaks — is cut at sentence ends instead.
    while (paragraph.length > limit) {
      const window = paragraph.slice(0, limit);
      const at = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      );
      const cut = at > limit * 0.5 ? at + 1 : limit;
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(paragraph.slice(0, cut).trim());
      paragraph = paragraph.slice(cut);
    }
    if (current && current.length + paragraph.length + 2 > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim());
}

/** How many pieces a job will take, for the estimate shown before it starts. */
export function pieceCount(text, mode = 'typeset') {
  return Math.max(1, chunkText(text, CHUNK_CHARS[mode] ?? CHUNK_CHARS.typeset).length);
}

/**
 * Keeps the stream to the protocol: drops code fences and any preamble the
 * model writes before its first real block. Once a valid tag has been seen,
 * text passes straight through so the page keeps filling live.
 */
export function createProtocolFilter(onText) {
  let started = false;
  let buffer = '';

  const looksLikeTag = (line) => {
    const tag = /^([A-Z][A-Z0-9]{0,7})(\s|$)/.exec(line.trim());
    return Boolean(tag && TAGS.has(tag[1]));
  };

  return {
    push(text) {
      if (started) {
        onText(text);
        return;
      }
      buffer += text;
      for (;;) {
        // The opening tag may be recognisable before its line ends.
        if (looksLikeTag(buffer)) {
          started = true;
          onText(buffer.replace(/^\s+/, ''));
          buffer = '';
          return;
        }
        const at = buffer.indexOf('\n');
        if (at < 0) return;
        buffer = buffer.slice(at + 1);
        if (!buffer.trim()) buffer = '';
      }
    },
    end() {
      if (started && buffer) onText(buffer);
      buffer = '';
    },
  };
}

// ------------------------------------------------------------------- framing

const LANGUAGE_NAMES = {
  en: 'English', ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
  tr: 'Turkish', ar: 'Arabic', fa: 'Persian', he: 'Hebrew', hi: 'Hindi',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', vi: 'Vietnamese', id: 'Indonesian',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech',
  el: 'Greek', ro: 'Romanian', hu: 'Hungarian', hy: 'Armenian', ka: 'Georgian',
  sr: 'Serbian', bg: 'Bulgarian', kk: 'Kazakh', az: 'Azerbaijani', la: 'Latin',
};

export const nameOfLanguage = (code) =>
  LANGUAGE_NAMES[String(code || '').toLowerCase().slice(0, 2)] || code || '';

function whatIsKnown(meta, sourceLang) {
  const known = [];
  if (meta?.title) known.push(`The source gives its title as "${meta.title}".`);
  else if (meta?.name) {
    known.push(`The file is called "${meta.name}", which may or may not be its real title.`);
  }
  if (meta?.author) known.push(`It names "${meta.author}" as the author.`);
  if (sourceLang) known.push(`It is written in ${nameOfLanguage(sourceLang)}.`);
  return known;
}

function framing({
  index, total, meta, mode, sourceLang, targetLang, lastHeading, glossary, register,
}) {
  const translating = mode !== 'typeset';
  const into = nameOfLanguage(targetLang);
  const lines = [];

  if (index === 0) {
    lines.push(
      translating
        ? `Translate the following into ${into}.`
        : 'Set the following text as an article.',
    );
    lines.push(...whatIsKnown(meta, sourceLang));
    if (total > 1) {
      lines.push(
        `This is the first of ${total} pieces of one long work; more follows, ` +
          'so do not write a conclusion or sign off.',
      );
    }
    if (register) lines.push(`From your reading of the whole work: ${register}`);
    if (glossary?.length) {
      lines.push(
        'The renderings you settled on reading it through, which you must keep to: ' +
          glossary.map((term) => `${term.word} = ${term.gloss}`).join('; ') + '.',
      );
    }
  } else {
    lines.push(
      translating
        ? `Carry on translating the same work into ${into} — piece ${index + 1} of ${total}.`
        : `This continues the same document — piece ${index + 1} of ${total}.`,
    );
    lines.push(
      'The title, kicker, deck and byline are already done: do not repeat them.',
    );
    if (lastHeading) {
      lines.push(`The section running when the last piece ended was "${lastHeading}".`);
    }
    if (glossary?.length) {
      lines.push(
        'Terms already settled, which you must keep to: ' +
          glossary.map((term) => `${term.word} = ${term.gloss}`).join('; ') + '.',
      );
    }
    lines.push(
      index + 1 === total
        ? 'This is the last piece.'
        : 'More follows after this, so no conclusion.',
    );
    lines.push('The text may resume mid-sentence; join straight on to it.');
  }

  return lines.join(' ');
}

/**
 * Read the whole work once before translating any of it.
 *
 * A book is translated in pieces, and a piece can only be told what the pieces
 * before it decided. That leaves chapter one guessing at names chapter twenty
 * will settle. One cheap pass over everything first — a long read, a short
 * answer — lets every piece start with the whole cast already named.
 */
export async function surveyWork(job, deps) {
  const { client, model, surveyPrompt, signal } = deps;
  if (!surveyPrompt || !job.text?.trim()) return { glossary: [], register: '' };

  const instruction = [
    `You will be translating this into ${nameOfLanguage(job.targetLang)}.`,
    ...whatIsKnown(job.meta, job.sourceLang),
    'Read all of it and leave yourself the note.',
  ].join(' ');

  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 8000,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: surveyPrompt }],
        messages: [
          { role: 'user', content: `${instruction}\n\n---\n\n${job.text.slice(0, SURVEY_CHARS)}` },
        ],
      },
      { signal },
    );
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') return { glossary: [], register: '' };

    const text = final.content.find((block) => block.type === 'text')?.text || '';
    const glossary = [];
    const seen = new Set();
    for (const match of text.matchAll(/(?:^|\n)TERM\s+([^\n]{0,240})/g)) {
      const at = match[1].indexOf('::');
      if (at < 0) continue;
      const word = match[1].slice(0, at).trim();
      const gloss = match[1].slice(at + 2).trim();
      if (!word || !gloss || seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      glossary.push({ word, gloss });
    }
    const register = [
      /(?:^|\n)REGISTER\s+([^\n]{0,400})/.exec(text)?.[1]?.trim(),
      /(?:^|\n)ADDRESS\s+([^\n]{0,400})/.exec(text)?.[1]?.trim(),
    ]
      .filter(Boolean)
      .join(' ');
    return { glossary: glossary.slice(0, SURVEY_TERMS), register };
  } catch (error) {
    if (signal?.aborted) return { glossary: [], register: '' };
    // Worth having, not worth failing over: the pieces can still tell each
    // other what they settled as they go.
    console.error('[lectern] the survey pass failed:', error?.message || error);
    return { glossary: [], register: '' };
  }
}

// -------------------------------------------------------------- the model call

const attempts = (fast) => {
  const list = [];
  if (fast) {
    list.push({
      beta: true,
      extra: {
        speed: 'fast',
        fallbacks: 'default',
        betas: ['fast-mode-2026-02-01', 'server-side-fallback-2026-07-01'],
      },
    });
  }
  list.push({
    beta: true,
    extra: { fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] },
  });
  list.push({ beta: false, extra: {} });
  return list;
};

const wait = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/** One piece, with every way of asking tried before it is called a failure. */
async function runPiece(params, { client, fast, signal, onText }) {
  const filter = createProtocolFilter(onText);
  let delivered = false;
  let truncated = false;
  let lastError = null;

  for (const attempt of attempts(fast)) {
    if (delivered || signal?.aborted) break;
    const surface = attempt.beta ? client.beta.messages : client.messages;
    try {
      const stream = surface.stream({ ...params, ...attempt.extra }, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          delivered = true;
          filter.push(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      filter.end();

      if (final.stop_reason === 'refusal') {
        onText(
          `\nNOTE This part could not be done: ${
            final.stop_details?.explanation || 'the model declined it'
          }.\n`,
        );
      }
      if (final.stop_reason === 'max_tokens') truncated = true;
      return { ok: true, truncated };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) return { ok: false, aborted: true };
      if (delivered) return { ok: true, partial: true }; // never restart a sentence
      console.error(
        `[lectern] ${attempt.beta ? 'beta' : 'standard'} attempt failed:`,
        error?.message || error,
      );
    }
  }
  return { ok: false, error: lastError };
}

/**
 * @param {object} job   text, meta, pdf, mode, sourceLang, targetLang
 * @param {object} deps  client, model, prompt, fast, onText, onProgress, signal
 */
export async function runPipeline(job, deps) {
  const { client, model, prompt, fast, onText, signal, onProgress } = deps;
  const mode = job.mode || 'typeset';
  const chunks = job.pdf ? [''] : chunkText(job.text, CHUNK_CHARS[mode] ?? CHUNK_CHARS.typeset);
  const total = chunks.length;

  let lastHeading = '';
  const glossary = [];
  const seenTerms = new Set();
  let wroteAnything = false;
  let failures = 0;
  let register = '';

  // Long translations get read through once first, so that the first chapter
  // already knows what the last one calls everybody.
  if (mode !== 'typeset' && total > 1 && (job.text?.length || 0) > SURVEY_FLOOR) {
    onProgress?.({ piece: 0, of: total, surveying: true });
    const survey = await surveyWork(job, deps);
    if (signal?.aborted) return;
    register = survey.register;
    for (const term of survey.glossary) {
      if (seenTerms.has(term.word.toLowerCase())) continue;
      seenTerms.add(term.word.toLowerCase());
      glossary.push(term);
    }
    onProgress?.({ piece: 0, of: total, surveyed: glossary.length });
  }

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) return;
    onProgress?.({ piece: index + 1, of: total });

    const collect = (text) => {
      wroteAnything = true;
      for (const match of text.matchAll(/(?:^|\n)H2\s+([^\n]{0,120})/g)) {
        lastHeading = match[1].trim();
      }
      // Terms this piece settled travel forward to the next one.
      for (const match of text.matchAll(/(?:^|\n)TERM\s+([^\n]{0,200})/g)) {
        const at = match[1].indexOf('::');
        if (at < 0) continue;
        const word = match[1].slice(0, at).trim();
        const gloss = match[1].slice(at + 2).trim();
        if (!word || !gloss || seenTerms.has(word.toLowerCase())) continue;
        seenTerms.add(word.toLowerCase());
        glossary.push({ word, gloss });
      }
      onText(text);
    };

    const instruction = framing({
      index,
      total,
      meta: job.meta,
      mode,
      sourceLang: job.sourceLang,
      targetLang: job.targetLang,
      lastHeading,
      // The survey's terms are the anchor; hand forward the newest of the rest.
      glossary: glossary.slice(-GLOSSARY_LIMIT),
      register,
    });

    const content = job.pdf
      ? [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: job.pdf.data },
          },
          {
            type: 'text',
            text:
              `${instruction}\n\nThe document has no text layer — read the pages ` +
              'themselves and work from everything they say, in order.',
          },
        ]
      : [{ type: 'text', text: `${instruction}\n\n---\n\n${chunks[index]}` }];

    const params = {
      model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    };

    // A book is twenty of these. One bad minute on the network must not cost
    // the other nineteen, so a piece gets a second go before it is given up on.
    let result = await runPiece(params, { client, fast, signal, onText: collect });
    if (!result.ok && !result.aborted) {
      await wait(4000, signal);
      if (signal?.aborted) return;
      result = await runPiece(params, { client, fast, signal, onText: collect });
    }
    if (result.aborted) return;

    if (result.truncated) {
      onText('\nNOTE A long stretch here ran past the limit and may be cut short.\n');
    }

    if (!result.ok) {
      failures++;
      if (!wroteAnything && index === 0) throw result.error || new Error('the model did not answer');
      // Carry on: nineteen good chapters beat none.
      onText(
        `\nNOTE Piece ${index + 1} of ${total} could not be done and has been left out.\n`,
      );
      if (failures >= 3 && failures > total * 0.25) {
        onText('\nNOTE Too much of this is failing; stopping here.\n');
        return;
      }
    }
  }
}

/** The older name, kept because typesetting is still what it does by default. */
export const typesetWithModel = (job, deps) => runPipeline(job, deps);
