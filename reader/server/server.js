/**
 * Lectern — paste anything, read it properly.
 *
 * Two endpoints do the work: one turns a file into text, one sets that text as
 * an article and streams it to the page. A third answers questions about single
 * words while you read.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

import { loadEnv } from '../../server/env.js';
import { extract } from './extract.js';
import { typesetWithModel } from './typeset.js';
import { lookUp, languageName } from './lexicon.js';
import { typesetLocally, lookUpLocally } from './local.js';

loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PUBLIC = join(root, 'public');

const PORT = Number(process.env.LECTERN_PORT || 4244);
const HOST = process.env.LECTERN_HOST || '0.0.0.0';
const MODEL = process.env.LECTERN_MODEL || 'claude-opus-5';
const FAST = /^(1|true|yes)$/i.test(process.env.LECTERN_FAST || '');
const TARGET_LANG = (process.env.LECTERN_LANG || 'ru').toLowerCase();
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const LOCAL = /^(1|true|yes)$/i.test(process.env.LECTERN_LOCAL || '') || !HAS_KEY;

const TYPESET_PROMPT = readFileSync(join(root, 'prompts', 'typeset.md'), 'utf8');
const LEXICON_PROMPT = readFileSync(join(root, 'prompts', 'lexicon.md'), 'utf8');

const client = LOCAL ? null : new Anthropic();

const UPLOAD_LIMIT = 48 * 1024 * 1024;
const JSON_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 600_000;

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

// --------------------------------------------------------------- http plumbing

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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

  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': /\.(woff2|png|svg)$/i.test(target) ? 'public, max-age=604800' : 'no-cache',
  });
  createReadStream(target).pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('that file is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sendJson = (res, status, body) =>
  res.writeHead(status, { 'Content-Type': MIME['.json'] }).end(JSON.stringify(body));

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
}

function send(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

// ------------------------------------------------------- pdfs awaiting vision

/**
 * A scan has no text to send, so the bytes wait here for the typeset request
 * that follows. Short-lived and capped — this is a reading app, not a store.
 */
const pending = new Map();
const PENDING_TTL = 10 * 60 * 1000;

function holdPdf(buffer) {
  const token = crypto.randomBytes(12).toString('hex');
  pending.set(token, { buffer, expires: Date.now() + PENDING_TTL });
  for (const [key, value] of pending) {
    if (value.expires < Date.now()) pending.delete(key);
  }
  while (pending.size > 8) pending.delete(pending.keys().next().value);
  return token;
}

function takePdf(token) {
  const entry = pending.get(String(token || ''));
  if (!entry || entry.expires < Date.now()) return null;
  return entry.buffer;
}

// ------------------------------------------------------------------- handlers

const countWords = (text) => (text.match(/[\p{L}\p{N}]+/gu) || []).length;

async function handleExtract(req, res) {
  let buffer;
  try {
    buffer = await readBody(req, UPLOAD_LIMIT);
  } catch (error) {
    sendJson(res, 413, { ok: false, reason: error.message });
    return;
  }

  const filename = String(req.headers['x-filename'] || '').slice(0, 300);
  const result = extract(buffer, decodeURIComponent(filename));

  // A PDF with no text layer is a scan. Keep the bytes: the model can look.
  if (!result.ok && result.kind === 'pdf' && !LOCAL) {
    return sendJson(res, 200, {
      ...result,
      words: 0,
      pdfToken: holdPdf(buffer),
      canRead: true,
    });
  }

  sendJson(res, 200, {
    kind: result.kind,
    ok: result.ok,
    reason: result.reason,
    meta: result.meta,
    pages: result.pages ?? 0,
    words: countWords(result.text),
    text: result.text.slice(0, TEXT_LIMIT),
    truncated: result.text.length > TEXT_LIMIT,
  });
}

async function handleTypeset(req, res) {
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => controller.abort());

  let body;
  try {
    body = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'malformed request' });
    return;
  }

  const text = String(body.text || '').slice(0, TEXT_LIMIT);
  const meta = {
    title: String(body.meta?.title || '').slice(0, 200),
    name: String(body.meta?.name || '').slice(0, 200),
    author: String(body.meta?.author || '').slice(0, 200),
  };
  const pdfBuffer = body.pdfToken ? takePdf(body.pdfToken) : null;

  if (!text.trim() && !pdfBuffer) {
    sendJson(res, 400, { error: 'there is nothing here to set' });
    return;
  }

  openStream(res);
  send(res, 'start', { local: LOCAL, model: LOCAL ? null : MODEL });

  try {
    if (LOCAL || (!pdfBuffer && !client)) {
      for (const line of typesetLocally(text, meta)) {
        if (controller.signal.aborted) return;
        send(res, 'text', { text: `${line}\n` });
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
    } else {
      await typesetWithModel(
        {
          text,
          meta,
          pdf: pdfBuffer ? { data: pdfBuffer.toString('base64') } : null,
        },
        {
          client,
          model: MODEL,
          prompt: TYPESET_PROMPT,
          fast: FAST,
          signal: controller.signal,
          onText: (chunk) => send(res, 'text', { text: chunk }),
          onProgress: (progress) => send(res, 'progress', progress),
        },
      );
    }
    send(res, 'done', {});
  } catch (error) {
    console.error('[lectern] typeset failed:', error?.message || error);
    if (!controller.signal.aborted) {
      send(res, 'failed', {
        message:
          'The typesetter could not finish. Your text is safe — try again, or read it as it came.',
      });
    }
  } finally {
    res.end();
  }
}

async function handleWord(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'malformed request' });
    return;
  }

  const query = {
    word: String(body.word || '').slice(0, 200),
    sentence: String(body.sentence || '').slice(0, 600),
    sourceLang: String(body.sourceLang || 'en').slice(0, 8),
    targetLang: String(body.targetLang || TARGET_LANG).slice(0, 8),
    title: String(body.title || '').slice(0, 160),
  };
  if (!query.word.trim()) {
    sendJson(res, 400, { error: 'no word given' });
    return;
  }

  try {
    if (LOCAL) {
      const card = await lookUpLocally(query);
      if (!card) {
        sendJson(res, 200, {
          word: query.word,
          unknown: true,
          meaning: '',
          translation: '',
          source: 'none',
          hint: 'Add an ANTHROPIC_API_KEY to .env for real definitions.',
        });
        return;
      }
      sendJson(res, 200, card);
      return;
    }
    const card = await lookUp(query, {
      client,
      model: MODEL,
      prompt: LEXICON_PROMPT,
    });
    sendJson(res, 200, card);
  } catch (error) {
    console.error('[lectern] lookup failed:', error?.message || error);
    sendJson(res, 502, { error: 'could not look that up just now' });
  }
}

/** Fetching a URL the reader pasted. Local addresses are refused. */
async function handleFetch(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8'));
  } catch {
    sendJson(res, 400, { ok: false, reason: 'malformed request' });
    return;
  }

  let url;
  try {
    url = new URL(String(body.url || ''));
  } catch {
    sendJson(res, 400, { ok: false, reason: 'that is not a web address' });
    return;
  }
  if (!/^https?:$/.test(url.protocol)) {
    sendJson(res, 400, { ok: false, reason: 'only http and https addresses' });
    return;
  }
  if (
    /^(localhost|\[?::1\]?|0\.0\.0\.0)$/i.test(url.hostname) ||
    /^(10|127)\./.test(url.hostname) ||
    /^192\.168\./.test(url.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) ||
    /\.local$/i.test(url.hostname)
  ) {
    sendJson(res, 400, { ok: false, reason: 'that address is on your own network' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Lectern/1.0 (reading app)' },
    });
    if (!response.ok) {
      sendJson(res, 200, { ok: false, reason: `the page answered ${response.status}` });
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > UPLOAD_LIMIT) {
      sendJson(res, 200, { ok: false, reason: 'that page is too large' });
      return;
    }
    const name = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    const result = extract(bytes, name);
    if (!result.ok && result.kind === 'pdf' && !LOCAL) {
      sendJson(res, 200, { ...result, words: 0, pdfToken: holdPdf(bytes), canRead: true });
      return;
    }
    sendJson(res, 200, {
      kind: result.kind,
      ok: result.ok,
      reason: result.reason,
      meta: {
        title: result.meta.title || '',
        name: result.meta.name || url.hostname,
        author: result.meta.author || '',
      },
      pages: result.pages ?? 0,
      words: countWords(result.text),
      text: result.text.slice(0, TEXT_LIMIT),
      truncated: result.text.length > TEXT_LIMIT,
      url: url.href,
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      reason: error.name === 'AbortError' ? 'that page took too long' : 'could not reach that page',
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------- server

const ROUTES = {
  'POST /api/extract': handleExtract,
  'POST /api/typeset': handleTypeset,
  'POST /api/word': handleWord,
  'POST /api/fetch': handleFetch,
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && path === '/api/state') {
    sendJson(res, 200, {
      local: LOCAL,
      hasKey: HAS_KEY,
      model: LOCAL ? null : MODEL,
      fast: FAST,
      targetLang: TARGET_LANG,
      targetLangName: languageName(TARGET_LANG),
    });
    return;
  }

  const route = ROUTES[`${req.method} ${path}`];
  if (route) {
    try {
      await route(req, res);
    } catch (error) {
      console.error('[lectern] unexpected:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'something went wrong' });
      else res.end();
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405).end('Method not allowed');
});

function lanAddresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

function announce() {
  console.log('\n  Lectern — paste anything, read it properly.\n');
  console.log(`  On this machine:  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const address of lanAddresses()) {
      console.log(`  On your network:  http://${address}:${PORT}`);
    }
  }
  console.log('');
  if (LOCAL) {
    console.log(
      HAS_KEY
        ? '  Running local (LECTERN_LOCAL=1): plain typesetting, borrowed dictionaries.'
        : '  No ANTHROPIC_API_KEY found — running on plain typesetting and\n  borrowed dictionaries. Put a key in .env for the real thing.',
    );
  } else {
    console.log(
      `  Setting type with ${MODEL}${FAST ? ' in fast mode' : ''}; ` +
        `translating into ${languageName(TARGET_LANG)}.`,
    );
  }
  console.log('');
}

export { server };

// Started for real only when run as a program; the tests import it and listen
// on a port of their own choosing.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  server.listen(PORT, HOST, announce);
}
