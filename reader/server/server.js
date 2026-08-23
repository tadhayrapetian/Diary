/**
 * Lectern — paste anything, read it properly, or read it in your own language.
 *
 * Work is done as jobs. A book takes twenty minutes and real money, so a run
 * does not belong to a browser tab: it is started, it finishes on its own, it
 * is written to disk as it goes, and any page can attach to it and catch up.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

import { loadEnv } from '../../server/env.js';
import { extract } from './extract.js';
import { runPipeline, pieceCount, nameOfLanguage } from './typeset.js';
import { lookUp, languageName } from './lexicon.js';
import { typesetLocally, lookUpLocally } from './local.js';
import { Library } from './jobs.js';

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
const LIBRARY_DIR =
  process.env.LECTERN_LIBRARY || join(root, '..', '.lectern', 'library');

const PROMPTS = {
  typeset: readFileSync(join(root, 'prompts', 'typeset.md'), 'utf8'),
  translate: readFileSync(join(root, 'prompts', 'translate.md'), 'utf8'),
  bilingual:
    readFileSync(join(root, 'prompts', 'translate.md'), 'utf8') +
    readFileSync(join(root, 'prompts', 'bilingual.md'), 'utf8'),
};
const LEXICON_PROMPT = readFileSync(join(root, 'prompts', 'lexicon.md'), 'utf8');
const SURVEY_PROMPT = readFileSync(join(root, 'prompts', 'survey.md'), 'utf8');

const client = LOCAL ? null : new Anthropic();
const library = new Library(LIBRARY_DIR);

const UPLOAD_LIMIT = 64 * 1024 * 1024;
const JSON_LIMIT = 12 * 1024 * 1024;
/** A long novel is about a million characters; this leaves room for a long one. */
const TEXT_LIMIT = 3_000_000;
const MODES = new Set(['typeset', 'translate', 'bilingual']);

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
  return new Promise((resolve_, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('that is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve_(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sendJson = (res, status, body) =>
  res.writeHead(status, { 'Content-Type': MIME['.json'] }).end(JSON.stringify(body));

async function readJson(req) {
  return JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8'));
}

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

// -------------------------------------------------------- material set aside

/**
 * What `/api/extract` read, waiting for the run that will use it. A book is
 * megabytes; there is no reason to send it to the browser and back again.
 */
const held = new Map();
const HELD_TTL = 30 * 60 * 1000;

function hold(value) {
  const token = crypto.randomBytes(12).toString('hex');
  held.set(token, { ...value, expires: Date.now() + HELD_TTL });
  for (const [key, entry] of held) if (entry.expires < Date.now()) held.delete(key);
  while (held.size > 12) held.delete(held.keys().next().value);
  return token;
}

const take = (token) => {
  const entry = held.get(String(token || ''));
  return entry && entry.expires >= Date.now() ? entry : null;
};

// ------------------------------------------------------------------- handlers

const countWords = (text) => (text.match(/[\p{L}\p{N}]+/gu) || []).length;

/** A rough guess at the language, enough to offer the right direction. */
function guessLanguage(text) {
  const sample = text.slice(0, 4000);
  const scripts = [
    [/[Ѐ-ӿ]/g, 'ru'], [/[Ͱ-Ͽ]/g, 'el'],
    [/[֐-׿]/g, 'he'], [/[؀-ۿ]/g, 'ar'],
    [/[԰-֏]/g, 'hy'], [/[Ⴀ-ჿ]/g, 'ka'],
    [/[ऀ-ॿ]/g, 'hi'], [/[぀-ヿ]/g, 'ja'],
    [/[가-힯]/g, 'ko'], [/[一-鿿]/g, 'zh'],
  ];
  for (const [pattern, code] of scripts) {
    if ((sample.match(pattern) || []).length > sample.length * 0.08) return code;
  }
  const markers = {
    en: ['the', 'and', 'of', 'that', 'with', 'was'],
    es: ['que', 'los', 'las', 'por', 'una', 'del'],
    fr: ['les', 'des', 'est', 'une', 'dans', 'pour'],
    de: ['und', 'der', 'die', 'das', 'nicht', 'mit'],
    it: ['che', 'gli', 'per', 'con', 'una', 'del'],
    pt: ['que', 'uma', 'com', 'dos', 'para', 'mais'],
  };
  const counts = {};
  for (const word of sample.toLowerCase().match(/[a-zà-ÿ]+/g) || []) {
    for (const [code, list] of Object.entries(markers)) {
      if (list.includes(word)) counts[code] = (counts[code] || 0) + 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 3 ? best[0] : 'en';
}

function described(result, extra = {}) {
  const text = result.text.slice(0, TEXT_LIMIT);
  const words = countWords(text);
  return {
    kind: result.kind,
    ok: result.ok,
    reason: result.reason,
    meta: result.meta,
    pages: result.pages ?? 0,
    words,
    lang: text ? guessLanguage(text) : '',
    preview: text.slice(0, 1200),
    truncated: result.text.length > TEXT_LIMIT,
    pieces: {
      typeset: pieceCount(text, 'typeset'),
      translate: pieceCount(text, 'translate'),
      bilingual: pieceCount(text, 'bilingual'),
    },
    sourceToken: text.trim() ? hold({ kind: 'text', text, meta: result.meta }) : '',
    ...extra,
  };
}

async function handleExtract(req, res) {
  let buffer;
  try {
    buffer = await readBody(req, UPLOAD_LIMIT);
  } catch (error) {
    sendJson(res, 413, { ok: false, reason: error.message });
    return;
  }

  const filename = decodeURIComponent(String(req.headers['x-filename'] || '')).slice(0, 300);
  const result = extract(buffer, filename);

  // A PDF with no text layer is a scan. Keep the bytes: the model can look.
  if (!result.ok && result.kind === 'pdf' && !LOCAL) {
    sendJson(res, 200, {
      ...result,
      words: 0,
      pieces: { typeset: 1, translate: 1, bilingual: 1 },
      sourceToken: hold({ kind: 'pdf', buffer, meta: result.meta }),
      canRead: true,
    });
    return;
  }
  sendJson(res, 200, described(result));
}

/** Start a run. Returns at once; the work carries on without the caller. */
async function handleRun(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'malformed request' });
    return;
  }

  const mode = MODES.has(body.mode) ? body.mode : 'typeset';
  const source = body.sourceToken ? take(body.sourceToken) : null;
  const text = source?.kind === 'text' ? source.text : String(body.text || '').slice(0, TEXT_LIMIT);
  const pdf = source?.kind === 'pdf' ? source.buffer : null;
  const meta = {
    title: String(body.meta?.title ?? source?.meta?.title ?? '').slice(0, 200),
    name: String(body.meta?.name ?? source?.meta?.name ?? '').slice(0, 200),
    author: String(body.meta?.author ?? source?.meta?.author ?? '').slice(0, 200),
  };

  if (!text.trim() && !pdf) {
    sendJson(res, 400, { error: 'there is nothing here to work on' });
    return;
  }
  if (mode !== 'typeset' && LOCAL) {
    sendJson(res, 400, {
      error: 'Translating needs an API key — put one in .env and start it again.',
    });
    return;
  }

  const sourceLang = String(body.sourceLang || (text ? guessLanguage(text) : 'en')).slice(0, 8);
  const targetLang = String(body.targetLang || TARGET_LANG).slice(0, 8);
  if (mode !== 'typeset' && sourceLang.slice(0, 2) === targetLang.slice(0, 2)) {
    sendJson(res, 400, {
      error: `That is already in ${nameOfLanguage(targetLang)}. Pick another language to put it into.`,
    });
    return;
  }

  const controller = new AbortController();
  const job = library.create({
    mode,
    controller,
    title: meta.title || meta.name || '',
    sourceLang,
    targetLang,
    words: countWords(text),
    pieces: pdf ? 1 : pieceCount(text, mode),
  });

  sendJson(res, 200, { id: job.id, pieces: job.pieces, mode, sourceLang, targetLang });

  // Deliberately not awaited: the caller is already gone.
  runJob(job, { text, meta, pdf, mode, sourceLang, targetLang, controller });
}

async function runJob(job, spec) {
  try {
    if (LOCAL) {
      for (const line of typesetLocally(spec.text, spec.meta)) {
        if (spec.controller.signal.aborted) return;
        library.append(job, `${line}\n`);
        await new Promise((done) => setTimeout(done, 3));
      }
    } else {
      await runPipeline(
        {
          text: spec.text,
          meta: spec.meta,
          mode: spec.mode,
          sourceLang: spec.sourceLang,
          targetLang: spec.targetLang,
          pdf: spec.pdf ? { data: spec.pdf.toString('base64') } : null,
        },
        {
          client,
          model: MODEL,
          prompt: PROMPTS[spec.mode] || PROMPTS.typeset,
          surveyPrompt: SURVEY_PROMPT,
          fast: FAST,
          signal: spec.controller.signal,
          onText: (chunk) => library.append(job, chunk),
          onProgress: (progress) => library.progress(job, progress),
        },
      );
    }
    if (spec.controller.signal.aborted) return;

    // Take the title from the article itself, which is usually better than the
    // file's name and is what the shelf should show.
    const opening = library.protocol(job.id)?.slice(0, 4000) || '';
    const title = /(?:^|\n)TITLE\s+([^\n]{1,200})/.exec(opening)?.[1]?.trim();
    if (title) job.title = title;
    library.finish(job, 'done');
  } catch (error) {
    console.error('[lectern] run failed:', error?.message || error);
    library.finish(
      job,
      'failed',
      'This could not be finished. What was done is still here.',
    );
  }
}

/** Attach to a job: everything so far, then the rest as it comes. */
function handleJobStream(req, res, id) {
  if (!library.get(id)) {
    sendJson(res, 404, { error: 'no such job' });
    return;
  }
  openStream(res);

  const detach = library.attach(id, (event, data) => send(res, event, data));
  // Long jobs need something on the wire or the connection is reaped.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': still here\n\n');
  }, 15_000);

  const close = () => {
    clearInterval(keepalive);
    detach?.();
  };
  req.on('aborted', close);
  res.on('close', close);
}

async function handleWord(req, res) {
  let body;
  try {
    body = await readJson(req);
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
      sendJson(
        res,
        200,
        card || {
          word: query.word,
          unknown: true,
          meaning: '',
          translation: '',
          source: 'none',
          hint: 'Add an ANTHROPIC_API_KEY to .env for real definitions.',
        },
      );
      return;
    }
    sendJson(res, 200, await lookUp(query, { client, model: MODEL, prompt: LEXICON_PROMPT }));
  } catch (error) {
    console.error('[lectern] lookup failed:', error?.message || error);
    sendJson(res, 502, { error: 'could not look that up just now' });
  }
}

/** Fetching a URL the reader pasted. Local addresses are refused. */
async function handleFetch(req, res) {
  let body;
  try {
    body = await readJson(req);
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
  const timer = setTimeout(() => controller.abort(), 25_000);
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
      sendJson(res, 200, {
        ...result,
        words: 0,
        pieces: { typeset: 1, translate: 1, bilingual: 1 },
        sourceToken: hold({ kind: 'pdf', buffer: bytes, meta: result.meta }),
        canRead: true,
      });
      return;
    }
    result.meta = { ...result.meta, name: result.meta.name || url.hostname };
    sendJson(res, 200, described(result, { url: url.href }));
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

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = `${req.method} ${path}`;

  try {
    if (route === 'GET /api/state') {
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
    if (route === 'GET /api/library') {
      sendJson(res, 200, { pieces: library.list() });
      return;
    }
    if (route === 'POST /api/extract') return await handleExtract(req, res);
    if (route === 'POST /api/run') return await handleRun(req, res);
    if (route === 'POST /api/word') return await handleWord(req, res);
    if (route === 'POST /api/fetch') return await handleFetch(req, res);

    const job = /^\/api\/job\/([a-f0-9]{6,40})(\/cancel)?$/.exec(path);
    if (job) {
      if (req.method === 'GET' && !job[2]) return handleJobStream(req, res, job[1]);
      if (req.method === 'POST' && job[2]) {
        sendJson(res, 200, { stopped: library.cancel(job[1]) });
        return;
      }
    }

    const piece = /^\/api\/library\/([a-f0-9]{6,40})$/.exec(path);
    if (piece) {
      if (req.method === 'GET') {
        const record = library.list().find((item) => item.id === piece[1]);
        if (!record) {
          sendJson(res, 404, { error: 'not on the shelf' });
          return;
        }
        sendJson(res, 200, { ...record, protocol: library.protocol(piece[1]) || '' });
        return;
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { removed: library.remove(piece[1]) });
        return;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405).end('Method not allowed');
  } catch (error) {
    console.error('[lectern] unexpected:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'something went wrong' });
    else res.end();
  }
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
        ? '  Running local (LECTERN_LOCAL=1): plain typesetting, no translation.'
        : '  No ANTHROPIC_API_KEY found — plain typesetting and borrowed\n  dictionaries only, and translation is off. Put a key in .env.',
    );
  } else {
    console.log(
      `  Setting type and translating with ${MODEL}${FAST ? ' in fast mode' : ''}; ` +
        `words are put into ${languageName(TARGET_LANG)} by default.`,
    );
  }
  const shelved = library.list().length;
  if (shelved) console.log(`  ${shelved} on the shelf.`);
  console.log('');
}

export { server, library };

// Started for real only when run as a program; the tests import it and listen
// on a port of their own choosing.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  server.listen(PORT, HOST, announce);
}
