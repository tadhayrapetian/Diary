// Вся серверная часть: статика, API полки и байты самих книг. Ни фреймворка,
// ни базы данных, один процесс.

import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadEnv, root } from './env.js';
import { Library, SUPPORTED } from './library.js';
import { mediaTypeFor } from './paths.js';
import { lookup, lookupAvailable } from './lookup.js';

loadEnv();

const PORT = Number(process.env.PORT || 4244);
const HOST = process.env.HOST || '0.0.0.0';
const LIBRARY_DIR = process.env.LIBRARY_DIR
  ? path.resolve(process.env.LIBRARY_DIR)
  : path.join(root, 'library');
const PUBLIC = path.join(root, 'public');
const PDFJS = path.join(root, 'node_modules', 'pdfjs-dist');
const UPLOAD_LIMIT = Number(process.env.UPLOAD_LIMIT_MB || 512) * 1024 * 1024;

const library = await new Library(LIBRARY_DIR).init();

// ------------------------------------------------------------------ responses

const json = (res, data, status = 200) => {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const fail = (res, status, message) => json(res, { error: message }, status);

function sendBuffer(res, buffer, type, { cache = 'no-store', filename = '' } = {}) {
  const headers = {
    'Content-Type': type,
    'Content-Length': buffer.length,
    'Cache-Control': cache,
  };
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
  res.writeHead(200, headers);
  res.end(buffer);
}

// Диапазоны байт здесь важны: pdf.js сначала просит хвост файла, а сканированная
// книга бывает в несколько сотен мегабайт.
function sendFile(req, res, file, { type, cache = 'public, max-age=3600', filename = '' } = {}) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return fail(res, 404, 'файл не найден');
  }
  const contentType = type || mediaTypeFor(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');

  if (range && stat.size) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : stat.size - 1;
    if (!range[1]) start = Math.max(0, stat.size - Number(range[2] || 0));
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }

  const headers = {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  };
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function readBody(req, limit = UPLOAD_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('файл слишком большой'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req) => {
  const body = await readBody(req, 4 * 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('некорректный JSON'), { status: 400 });
  }
};

const cleanProgress = (raw = {}) => ({
  chapter: Math.max(0, Number(raw.chapter) || 0),
  offset: Number(raw.offset) || 0,
  percent: Math.min(100, Math.max(0, Number(raw.percent) || 0)),
  label: String(raw.label || '').slice(0, 120),
  updatedAt: new Date().toISOString(),
});

// Путь, вылезающий из своей папки, — это не опечатка, а попытка.
function safeJoin(base, relative) {
  const target = path.normalize(path.join(base, relative));
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

// -------------------------------------------------------------------- the API

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // без 'api'
  const [section, id, action, ...rest] = parts;

  if (section === 'library' && req.method === 'GET') {
    return json(res, {
      books: library.index,
      formats: SUPPORTED,
      lookup: lookupAvailable(),
    });
  }

  if (section === 'books' && !id && req.method === 'POST') {
    const filename = decodeURIComponent(req.headers['x-filename'] || 'документ');
    const body = await readBody(req);
    if (!body.length) return fail(res, 400, 'пустой файл');
    try {
      const { book, duplicate } = await library.add(body, filename);
      return json(res, { book, duplicate }, duplicate ? 200 : 201);
    } catch (error) {
      return fail(res, 415, error.message || 'не удалось прочитать файл');
    }
  }

  if (section === 'books' && id) {
    const record = library.get(id);
    if (!record) return fail(res, 404, 'книга не найдена');

    if (!action && req.method === 'GET') {
      const structure = await library.structure(id);
      return json(res, {
        book: record,
        toc: structure?.toc || [],
        chapters: structure?.chapters || [],
      });
    }

    if (!action && req.method === 'PATCH') {
      const patch = await readJson(req);
      const allowed = {};
      if (patch.progress && typeof patch.progress === 'object') {
        allowed.progress = cleanProgress(patch.progress);
        allowed.openedAt = new Date().toISOString();
      }
      if (Array.isArray(patch.bookmarks)) allowed.bookmarks = patch.bookmarks.slice(0, 500);
      if (typeof patch.title === 'string' && patch.title.trim()) allowed.title = patch.title.trim().slice(0, 300);
      if (Array.isArray(patch.authors)) allowed.authors = patch.authors.map((a) => String(a).slice(0, 120)).slice(0, 8);
      if (Number.isFinite(patch.pages) && patch.pages > 0) allowed.pages = Math.floor(patch.pages);
      return json(res, { book: await library.update(id, allowed) });
    }

    if (!action && req.method === 'DELETE') {
      await library.remove(id);
      return json(res, { removed: true });
    }

    // Отдельный вход для sendBeacon: браузер при закрытии вкладки умеет только
    // POST и не даёт дождаться ответа — но место в книге доезжает.
    if (action === 'progress' && req.method === 'POST') {
      const body = await readJson(req);
      await library.update(id, { progress: cleanProgress(body), openedAt: new Date().toISOString() });
      res.writeHead(204).end();
      return;
    }

    if (action === 'chapter' && req.method === 'GET') {
      const document = await library.document(id);
      if (!document) return fail(res, 404, 'файл книги потерян');
      const chapter = document.chapter(Number(rest[0]) || 0);
      if (!chapter) return fail(res, 404, 'нет такой главы');
      return json(res, chapter);
    }

    if (action === 'res') {
      const document = await library.document(id);
      const resource = document?.resource(rest.join('/'));
      if (!resource) return fail(res, 404, 'ресурс не найден');
      return sendBuffer(res, resource.data, resource.mediaType, { cache: 'public, max-age=86400' });
    }

    if (action === 'note' && req.method === 'GET') {
      const document = await library.document(id);
      const html = document?.note?.(rest.join('/'));
      return html ? json(res, { html }) : fail(res, 404, 'примечание не найдено');
    }

    if (action === 'cover' && req.method === 'GET') {
      if (!record.cover) return fail(res, 404, 'обложки нет');
      const file = safeJoin(library.covers, record.cover);
      if (!file || !existsSync(file)) return fail(res, 404, 'обложки нет');
      return sendFile(req, res, file, { cache: 'public, max-age=86400' });
    }

    // У PDF нечего вынимать на сервере: читалка рисует первую страницу в
    // браузере и присылает картинку обратно.
    if (action === 'cover' && req.method === 'PUT') {
      const body = await readBody(req, 8 * 1024 * 1024);
      if (!body.length || body.subarray(1, 4).toString('latin1') !== 'PNG') return fail(res, 400, 'ожидается PNG');
      const name = `${id}.png`;
      await writeFile(path.join(library.covers, name), body);
      await library.update(id, { cover: name });
      return json(res, { cover: name });
    }

    if (action === 'file' && req.method === 'GET') {
      return sendFile(req, res, library.filePath(record), {
        type: mediaTypeFor(record.filename || record.extension),
        cache: 'private, max-age=600',
        filename: record.filename,
      });
    }

    if (action === 'search' && req.method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length < 2) return json(res, { results: [] });
      const document = await library.document(id);
      if (!document) return fail(res, 404, 'файл книги потерян');
      const needle = query.toLowerCase();
      const results = [];
      for (let i = 0; i < document.chapters.length && results.length < 80; i++) {
        const chapter = document.chapter(i);
        if (!chapter) continue;
        const haystack = chapter.text.toLowerCase();
        let at = haystack.indexOf(needle);
        while (at !== -1 && results.length < 80) {
          results.push({
            chapter: i,
            chapterTitle: chapter.title,
            offset: at,
            snippet: chapter.text.slice(Math.max(0, at - 60), at + needle.length + 90).trim(),
          });
          at = haystack.indexOf(needle, at + needle.length);
        }
      }
      return json(res, { results });
    }
  }

  if (section === 'lookup' && req.method === 'POST') {
    return json(res, await lookup(await readJson(req)));
  }

  return fail(res, 404, 'нет такого метода');
}

// ------------------------------------------------------------ static handling

function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';

  // pdf.js раздаётся прямо из node_modules, поэтому его нет в репозитории; а
  // если его вообще не поставили — читалка скажет об этом, а не сломается.
  if (relative.startsWith('/vendor/pdfjs/')) {
    const file = safeJoin(PDFJS, relative.slice('/vendor/pdfjs/'.length));
    if (!file || !existsSync(file)) return fail(res, 404, 'pdf.js не установлен: npm install');
    return sendFile(req, res, file, { type: file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : undefined, cache: 'public, max-age=604800' });
  }

  const file = safeJoin(PUBLIC, relative);
  if (!file || !existsSync(file) || statSync(file).isDirectory()) return fail(res, 404, 'не найдено');
  return sendFile(req, res, file, {
    type: mediaTypeFor(file),
    cache: /\.(png|svg|woff2?|jpg)$/i.test(file) ? 'public, max-age=604800' : 'no-cache',
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) return res.end();
    return fail(res, error.status || 500, error.message || 'что-то сломалось');
  }
});

server.listen(PORT, HOST, () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log(`\n  Полка — ваша библиотека\n`);
  console.log(`  здесь:      http://localhost:${PORT}`);
  for (const address of addresses) console.log(`  с планшета: http://${address}:${PORT}`);
  console.log(`\n  книги лежат в ${LIBRARY_DIR} (${library.index.length} шт.)`);
  if (!existsSync(path.join(PDFJS, 'legacy', 'build', 'pdf.min.mjs'))) {
    console.log('  PDF: запустите npm install, иначе PDF откроются во встроенном просмотрщике');
  }
  console.log('');
});
