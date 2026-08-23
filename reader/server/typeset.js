/**
 * Raw text in, article protocol out, streamed.
 *
 * Long documents are cut into pieces and set one after another, because the
 * model has to reproduce the whole text rather than summarise it, and a book
 * does not fit in one response. Each piece is told what came before it so the
 * headings and the voice carry across the seam.
 */

import { TAGS } from '../public/blocks.js';

/** Roughly six thousand tokens of source per request. */
const CHUNK_CHARS = 24_000;
const MAX_TOKENS = 32_000;

/** Split on paragraph boundaries, never mid-sentence. */
export function chunkText(text, limit = CHUNK_CHARS) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (let paragraph of paragraphs) {
    // A single paragraph longer than a whole chunk (a wall of text with no
    // breaks) is cut at sentence ends instead.
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

function framing({ index, total, meta, lastHeading }) {
  if (index === 0) {
    const known = [];
    if (meta?.title) known.push(`The source gives its title as "${meta.title}".`);
    else if (meta?.name) {
      known.push(
        `The file is called "${meta.name}", which may or may not be its real title.`,
      );
    }
    if (meta?.author) known.push(`It names "${meta.author}" as the author.`);
    if (total > 1) {
      known.push(
        `This is the first of ${total} pieces of one long document; more follows, so do not write a conclusion or sign off.`,
      );
    }
    return `Set the following text as an article.${known.length ? ' ' + known.join(' ') : ''}`;
  }
  return [
    `This continues the same document — piece ${index + 1} of ${total}.`,
    'The title, kicker, deck, byline and summary are already written: do not repeat them.',
    lastHeading ? `The section running when the last piece ended was "${lastHeading}".` : '',
    index + 1 === total
      ? 'This is the last piece, so the TERM lines go at the end of it.'
      : 'More follows after this, so no TERM lines yet and no conclusion.',
    'Carry straight on from where the text resumes.',
  ]
    .filter(Boolean)
    .join(' ');
}

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

/**
 * @param {object} job
 * @param {string} job.text          the source, already extracted and repaired
 * @param {object} job.meta          title and author, where the file knew them
 * @param {{data: string}} [job.pdf] base64 pdf, for a scan with no text layer
 * @param {object} deps              client, model, prompt, fast, onText, signal
 */
export async function typesetWithModel(job, deps) {
  const { client, model, prompt, fast, onText, signal, onProgress } = deps;
  const chunks = job.pdf ? [''] : chunkText(job.text);
  const total = chunks.length;
  let lastHeading = '';
  let wroteAnything = false;

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) return;
    onProgress?.({ piece: index + 1, of: total });

    const filter = createProtocolFilter((text) => {
      wroteAnything = true;
      // Remember the current section so the next piece can be told about it.
      for (const match of text.matchAll(/(?:^|\n)H2\s+([^\n]{0,120})/g)) {
        lastHeading = match[1].trim();
      }
      onText(text);
    });

    const instruction = framing({ index, total, meta: job.meta, lastHeading });
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
              'themselves and set out everything they say, in order.',
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

    let delivered = false;
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
            `\nNOTE This part of the document could not be set out: ${
              final.stop_details?.explanation || 'the model declined it'
            }.\n`,
          );
        }
        delivered = true;
        break;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) return;
        if (delivered) break; // mid-piece failure: do not start it over
        console.error(
          `[lectern] typeset ${attempt.beta ? 'beta' : 'standard'} attempt failed:`,
          error?.message || error,
        );
      }
    }

    if (!delivered) {
      if (!wroteAnything) throw lastError || new Error('the typesetter did not answer');
      onText('\nNOTE The rest of this document could not be set out just now.\n');
      return;
    }
  }
}
