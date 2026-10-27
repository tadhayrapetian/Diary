import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

import { loadEnv, root } from './env.js';
import { DemoStore } from './demo.js';
import { ImapStore } from './imap.js';
import { Assistant } from './ai.js';
import { parseRecipients, textToHtml, htmlToText } from './util.js';
import { accountFromEnv, yes } from './config.js';

loadEnv();

const PORT = Number(process.env.PORT || 4280);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = join(root, 'public');
const BODY_LIMIT = 40 * 1024 * 1024;

// ---------------------------------------------------------------- account

const account = accountFromEnv();
const store = account ? new ImapStore(account) : new DemoStore();
if (store.kind === 'imap') store.watch();

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const assistant = HAS_KEY && !yes(process.env.AETHER_NO_AI) ? new Assistant({ model: process.env.AETHER_MODEL || 'claude-opus-5-5' }) : null;

// ---------------------------------------------------------------- live updates

const listeners = new Set();
store.on('new', (payload) => {
  for (const res of listeners) send(res, 'new', payload);
});
setInterval(() => {
  for (const res of listeners) res.write(': ping\n\n');
}, 25_000).unref();

// ---------------------------------------------------------------- http plumbing

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

// The page itself. Mail bodies render in sandboxed srcdoc frames that inherit this
// policy and add a stricter one of their own (see public/reader.js).
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = normalize(join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC + sep)) return res.writeHead(403).end('Forbidden');

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return res.writeHead(404).end('Not found');
  }
  if (stat.isDirectory()) return res.writeHead(404).end('Not found');

  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': APP_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
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
        reject(Object.assign(new Error('Письмо слишком большое (лимит 40 МБ)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('malformed json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data ?? {});
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }).end(body);
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

/**
 * This server holds the keys to a mailbox, so it only talks to pages it served.
 * The Host check defeats DNS rebinding; the custom header on writes forces a CORS
 * preflight that is never granted, so another site cannot make it send mail.
 */
function trusted(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const allowed = new Set(['localhost', '127.0.0.1', '::1', ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);
  if (!allowed.has(host)) return false;
  if (req.method !== 'GET' && req.headers['x-aether'] !== '1') return false;
  return true;
}

// ---------------------------------------------------------------- routes

const ids = (body) => (Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []);

function safeName(name) {
  return String(name || 'file').replace(/[\r\n"\\]/g, '_');
}

function attachmentsFrom(list) {
  return (Array.isArray(list) ? list : []).map((a) => ({
    filename: safeName(a.filename),
    contentType: String(a.contentType || 'application/octet-stream'),
    content: Buffer.from(String(a.data || ''), 'base64'),
  }));
}

const routes = {
  'GET /api/state': async () => ({
    mode: store.kind,
    account: await store.info(),
    ai: Boolean(assistant),
  }),

  'GET /api/folders': () => store.folders(),

  'GET /api/messages': (_req, url) =>
    store.list({
      folder: url.searchParams.get('folder') || 'inbox',
      q: (url.searchParams.get('q') || '').trim().slice(0, 200),
      filter: url.searchParams.get('filter') || 'all',
      offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
      limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50)),
    }),

  'GET /api/message': (_req, url) => store.get(url.searchParams.get('folder'), url.searchParams.get('id')),

  'GET /api/thread': (_req, url) => store.thread(url.searchParams.get('folder'), url.searchParams.get('id')),

  'POST /api/flags': async (req) => {
    const body = await readBody(req);
    await store.flags(String(body.folder), ids(body), { add: body.add || [], remove: body.remove || [] });
    return { ok: true };
  },

  'POST /api/move': async (req) => {
    const body = await readBody(req);
    await store.move(String(body.folder), ids(body), String(body.to));
    return { ok: true };
  },

  'POST /api/destroy': async (req) => {
    const body = await readBody(req);
    await store.destroy(String(body.folder), ids(body));
    return { ok: true };
  },

  'POST /api/send': async (req) => {
    const body = await readBody(req);
    const to = parseRecipients(body.to);
    if (!to.length) throw Object.assign(new Error('Добавьте хотя бы одного получателя'), { status: 400 });
    const html = String(body.html || '') || textToHtml(String(body.text || ''));
    const result = await store.send({
      to,
      cc: parseRecipients(body.cc),
      bcc: parseRecipients(body.bcc),
      subject: String(body.subject || '').slice(0, 998),
      html,
      text: htmlToText(html),
      inReplyTo: body.inReplyTo || null,
      references: Array.isArray(body.references) ? body.references.map(String) : [],
      replyTo: body.replyTo && typeof body.replyTo === 'object' ? { folder: String(body.replyTo.folder), id: String(body.replyTo.id) } : null,
      attachments: attachmentsFrom(body.attachments),
    });
    return { ok: true, ...result };
  },
};

async function attachment(req, res, url) {
  const file = await store.attachment(url.searchParams.get('folder'), url.searchParams.get('id'), url.searchParams.get('index'));
  const type = String(file.contentType || 'application/octet-stream').toLowerCase();
  const viewable = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$|^application\/pdf$/.test(type);
  const inline = viewable && url.searchParams.get('download') !== '1';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': file.content.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    // Whatever arrives by mail runs in an opaque origin, never as this app. (Chrome's PDF
    // viewer refuses to open inside a sandbox, and runs no page script of its own anyway.)
    'Content-Security-Policy': type === 'application/pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(file.content);
}

async function events(req, res) {
  openStream(res);
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
}

async function ai(req, res) {
  if (!assistant) return json(res, 501, { error: 'ИИ выключен: добавьте ANTHROPIC_API_KEY в .env' });
  const body = await readBody(req);
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let thread = [];
  if (body.folder && body.id) {
    thread = await store.thread(String(body.folder), String(body.id)).catch(() => []);
  }
  openStream(res);
  try {
    const { refused } = await assistant.run(
      {
        action: String(body.action),
        instruction: String(body.instruction || ''),
        thread,
        draft: String(body.draft || ''),
        subject: String(body.subject || ''),
      },
      (text) => send(res, 'text', { text }),
      controller.signal,
    );
    if (refused) send(res, 'error', { error: 'Ассистент не стал с этим помогать.' });
    send(res, 'done', {});
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[mail] assistant:', error?.message || error);
      send(res, 'error', { error: 'Ассистент сейчас недоступен. Попробуйте ещё раз.' });
    }
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    return res.writeHead(405).end('Method not allowed');
  }
  if (!trusted(req)) return json(res, 403, { error: 'forbidden' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/events') return await events(req, res);
    if (req.method === 'GET' && url.pathname === '/api/attachment') return await attachment(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/ai') return await ai(req, res);

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return json(res, 404, { error: 'not found' });
    json(res, 200, await route(req, url));
  } catch (error) {
    const status = error.status || (error.authenticationFailed ? 401 : 500);
    if (status >= 500) console.error('[mail]', req.method, url.pathname, error);
    if (!res.headersSent) {
      json(res, status, {
        error: error.authenticationFailed ? 'Почтовый сервер не принял логин или пароль' : error.message || 'Что-то пошло не так',
      });
    } else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('\n  ✦ Aether — почта открыта.\n');
  console.log(`  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  if (store.kind === 'demo') {
    console.log('  Демо-режим: письма ненастоящие. Добавьте ящик в .env, чтобы подключить свою почту.');
  } else {
    console.log(`  Ящик: ${account.from.address} (${account.imap.host})`);
  }
  console.log(assistant ? '  Ассистент Claude включён.\n' : '  Ассистент выключен — нужен ANTHROPIC_API_KEY.\n');
});

