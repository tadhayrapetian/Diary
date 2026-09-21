/* Отпечаток — a static server, and nothing else.
 *
 * The studio is plain files: it opens just as well by double-clicking
 * print/index.html. This exists for the cases where that is inconvenient —
 * printing from a phone or a tablet on the same Wi-Fi, mostly. It serves the
 * repository root so the studio can borrow the diary's handwriting font, and it
 * has no dependencies, no API, and nothing to configure.
 */
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PORT = Number(process.env.PRINT_PORT || process.env.PORT || 4244);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);

  if (rel === '/' || rel === '/print' || rel === '/print/') rel = '/print/index.html';

  const target = normalize(join(root, rel));
  if (!target.startsWith(root + sep) && target !== root) {
    res.writeHead(403).end('Нельзя');
    return;
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    res.writeHead(404).end('Нет такого файла');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404).end('Нет такого файла');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': /\.(woff2|svg|png)$/i.test(target) ? 'public, max-age=604800' : 'no-cache',
  });
  createReadStream(target).pipe(res);
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

server.listen(PORT, HOST, () => {
  console.log('\n  Отпечаток — студия открыта.\n');
  console.log(`  Здесь:        http://localhost:${PORT}/print/`);
  if (HOST === '0.0.0.0') {
    for (const address of lanAddresses()) {
      console.log(`  По сети:      http://${address}:${PORT}/print/`);
    }
  }
  console.log('\n  Фотографии никуда не уходят — всё считается прямо в браузере.\n');
});
