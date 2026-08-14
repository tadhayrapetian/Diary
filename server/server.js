import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import { loadEnv, root } from './env.js';
import { ReplySplitter } from './ink.js';
import { hollowReply } from './hollow.js';

loadEnv();

const PORT = Number(process.env.PORT || 4243);
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = process.env.DIARY_MODEL || 'claude-opus-5';
const MAX_TOKENS = Number(process.env.DIARY_MAX_TOKENS || 400);
const FAST = /^(1|true|yes)$/i.test(process.env.DIARY_FAST || '');
const HAS_KEY = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
);
const HOLLOW = /^(1|true|yes)$/i.test(process.env.DIARY_HOLLOW || '') || !HAS_KEY;

const PERSONA = readFileSync(join(root, 'prompts', 'riddle.md'), 'utf8');
const PUBLIC = join(root, 'public');

const client = HOLLOW ? null : new Anthropic();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const BODY_LIMIT = 16 * 1024 * 1024;

// ---------------------------------------------------------------- http plumbing

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = normalize(join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC + sep) && target !== PUBLIC) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }

  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  const cache = /\.(woff2|png|svg)$/i.test(target)
    ? 'public, max-age=604800'
    : 'no-cache';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache,
  });
  createReadStream(target).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the client's reader is live before the model is.
  res.write(': open\n\n');
}

function send(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

// ---------------------------------------------------------------- request shape

function parsePage(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('malformed request');
  }

  const image = typeof body.image === 'string' ? body.image : '';
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(
    image,
  );
  if (!match) throw new Error('the page carried no legible ink');

  const history = Array.isArray(body.history) ? body.history : [];
  const trimmed = history
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim(),
    )
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  return {
    mediaType: `image/${match[1]}`,
    data: match[2].replace(/\s+/g, ''),
    history: trimmed,
    turn: Number.isFinite(body.turn) ? Math.max(1, Math.floor(body.turn)) : 1,
  };
}

function buildMessages(page) {
  const frame =
    page.turn === 1
      ? 'A hand writes on your first page. Read what is there and answer it.'
      : `A hand writes on the page again. This is the ${ordinal(
          page.turn,
        )} thing written to you in this sitting. Read it and answer.`;

  return [
    ...page.history,
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: page.mediaType, data: page.data },
        },
        { type: 'text', text: frame },
      ],
    },
  ];
}

function ordinal(n) {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// ---------------------------------------------------------------- the model call

const BASE_PARAMS = {
  model: MODEL,
  max_tokens: MAX_TOKENS,
  // The page must never look like it is thinking, so the reply starts the moment
  // the first token lands. Disabled thinking with low effort is the shortest path
  // to a first token; `disabled` is accepted on Opus 5 at effort `high` or below.
  thinking: { type: 'disabled' },
  output_config: { effort: 'low' },
  system: [
    { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
  ],
};

/** Ordered list of ways to ask, most desirable first. */
function attempts() {
  const list = [];
  if (FAST) {
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
}

async function converse(page, res, signal) {
  const messages = buildMessages(page);
  let wrote = false;

  const splitter = new ReplySplitter({
    onTranscript: (text) => send(res, 'read', { text }),
    onInk: (text) => {
      wrote = true;
      send(res, 'ink', { text });
    },
  });

  let lastError = null;

  for (const attempt of attempts()) {
    if (wrote || signal.aborted) break;
    const surface = attempt.beta ? client.beta.messages : client.messages;
    const params = { ...BASE_PARAMS, ...attempt.extra, messages };

    try {
      const stream = surface.stream(params, { signal });
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          splitter.push(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      splitter.end();

      if (final.stop_reason === 'refusal') {
        send(res, 'ink', {
          text: wrote
            ? ' … no. Let us speak of something else.'
            : 'I would rather not put that in ink. Ask me something else and I shall answer gladly.',
        });
      }
      send(res, 'done', {});
      return;
    } catch (error) {
      lastError = error;
      if (signal.aborted) return;
      if (wrote) break; // mid-reply failure — do not restart the sentence
      console.error(
        `[diary] ${attempt.beta ? 'beta' : 'standard'} attempt failed:`,
        error?.message || error,
      );
    }
  }

  if (!wrote) {
    console.error('[diary] no reply surfaced:', lastError?.message || lastError);
    send(res, 'ink', {
      text: 'The ink runs thin just now. Write to me again in a moment.',
    });
  }
  send(res, 'done', {});
}

async function hollow(page, res, signal) {
  const reply = hollowReply(page.turn);
  send(res, 'read', { text: null });
  // Deal it out in pieces so the page behaves exactly as it does with a model
  // behind it — same code path on the client, same feel.
  for (const piece of reply.match(/.{1,14}(\s|$)|.{1,14}/g) || []) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 55));
    send(res, 'ink', { text: piece });
  }
  send(res, 'done', {});
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(
      JSON.stringify({ hollow: HOLLOW, model: HOLLOW ? null : MODEL, fast: FAST }),
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reply') {
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => controller.abort());

    let page;
    try {
      page = parsePage(await readBody(req));
    } catch (error) {
      openStream(res);
      send(res, 'ink', {
        text: 'Something has smudged. Write it out for me once more.',
      });
      send(res, 'done', {});
      res.end();
      console.error('[diary] bad page:', error.message);
      return;
    }

    openStream(res);
    try {
      if (HOLLOW) await hollow(page, res, controller.signal);
      else await converse(page, res, controller.signal);
    } catch (error) {
      console.error('[diary] unexpected:', error);
      send(res, 'done', {});
    } finally {
      res.end();
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  const where = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  T. M. Riddle — the diary is open.`);
  console.log(`  http://${where}:${PORT}\n`);
  if (HOLLOW) {
    console.log(
      HAS_KEY
        ? '  Running hollow (DIARY_HOLLOW=1): canned replies, no model.'
        : '  No ANTHROPIC_API_KEY found — running hollow, with canned replies.\n  Put a key in .env to wake it properly.',
    );
  } else {
    console.log(`  Answering with ${MODEL}${FAST ? ' in fast mode' : ''}.`);
  }
  console.log(
    '\n  On an iPad: open the address above over your LAN, then Share → Add to Home Screen.\n',
  );
});
