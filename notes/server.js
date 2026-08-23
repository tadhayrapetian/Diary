import http from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, root } from '../server/env.js';
import { toMarkdown } from './export.js';
import { NoteStore, TEXT_LIMIT } from './store.js';

loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');

const PORT = Number(process.env.NOTES_PORT || 4244);
const HOST = process.env.NOTES_HOST || '0.0.0.0';
const FILE = settle(process.env.NOTES_FILE || join(here, 'data', 'notes.json'));

/**
 * `~/notes.json` and `./notes/data/notes.json` both mean what they look like:
 * home, and the repository — not whichever folder the terminal happened to be
 * standing in.
 */
function settle(target) {
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return join(homedir(), target.slice(2));
  return isAbsolute(target) ? target : join(root, target);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** One note may be long; a request body may not be a denial of service. */
const BODY_LIMIT = 2 * TEXT_LIMIT;

const store = new NoteStore(FILE);

// ---------------------------------------------------------------- http plumbing

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('malformed json');
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname;
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
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------- export

function download(res, filename, type, body) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------- routes

/**
 * Every mutation answers only after the file on disk has caught up. It costs a
 * millisecond or two and it means the tick the client shows is the truth.
 */
async function handleApi(req, res, url) {
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/notes') {
    json(res, 200, { notes: store.list() });
    return true;
  }

  if (req.method === 'POST' && path === '/api/notes') {
    const body = await readJson(req);
    const note = store.create(body);
    if (!note) {
      json(res, 400, { error: 'пустая заметка' });
      return true;
    }
    await store.save();
    json(res, 201, { note });
    return true;
  }

  const single = /^\/api\/notes\/([^/]+)$/.exec(path);
  if (single) {
    const id = decodeURIComponent(single[1]);

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readJson(req);
      if (!store.get(id)) {
        json(res, 404, { error: 'заметка не найдена' });
        return true;
      }
      const note = store.update(id, body);
      if (!note) {
        json(res, 400, { error: 'пустая заметка' });
        return true;
      }
      await store.save();
      json(res, 200, { note });
      return true;
    }

    if (req.method === 'DELETE') {
      const note = store.remove(id);
      if (!note) {
        json(res, 404, { error: 'заметка не найдена' });
        return true;
      }
      await store.save();
      json(res, 200, { note });
      return true;
    }

    json(res, 405, { error: 'метод не поддерживается' });
    return true;
  }

  if (req.method === 'GET' && path === '/api/export.md') {
    download(res, 'notes.md', 'text/markdown; charset=utf-8', toMarkdown(store.list()));
    return true;
  }

  if (req.method === 'GET' && path === '/api/export.json') {
    download(
      res,
      'notes.json',
      MIME['.json'],
      JSON.stringify({ exported: Date.now(), notes: store.list() }, null, 2),
    );
    return true;
  }

  json(res, 404, { error: 'нет такого адреса' });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const bad = /malformed json|too large/.test(error.message);
      if (!bad) console.error('[notes]', error);
      json(res, bad ? 400 : 500, { error: bad ? 'плохой запрос' : 'внутренняя ошибка' });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, decodeURIComponent(url.pathname));
    return;
  }

  res.writeHead(405).end('Method not allowed');
});

/** Addresses another device on the same network can actually reach. */
function lanAddresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

const { count, quarantined } = await store.load();
if (quarantined) {
  console.error(`\n  Файл заметок не читается. Он сохранён как:\n      ${quarantined}\n  Начинаем с чистого листа.`);
}

server.listen(PORT, HOST, () => {
  console.log('\n  Быстрые заметки\n');
  console.log(`  Здесь:     http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const address of lanAddresses()) console.log(`  В сети:    http://${address}:${PORT}`);
  }
  console.log(`  Файл:      ${FILE}`);
  console.log(`  Заметок:   ${count}\n`);
});
