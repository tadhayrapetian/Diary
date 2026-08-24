// Пути внутри контейнера относительные, процентно-закодированные и иногда
// написанные руками. Всё, что должно это пережить, живёт здесь.

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  xml: 'application/xml', json: 'application/json', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', pdf: 'application/pdf', epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webmanifest: 'application/manifest+json',
};

export const extensionOf = (path) => (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase();

export const mediaTypeFor = (path) => TYPES[extensionOf(path)] || 'application/octet-stream';

export const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/**
 * Разрешить относительную ссылку относительно папки внутри контейнера.
 * @param {string} baseDir
 * @param {string} href
 * @param {boolean} [keepFragment] оставить `#якорь` в результате
 */
export function resolvePath(baseDir, href, keepFragment = false) {
  const hash = href.indexOf('#');
  const fragment = hash === -1 ? '' : href.slice(hash + 1);
  let path = hash === -1 ? href : href.slice(0, hash);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Одинокий % не из escape-последовательности. Берём ссылку как написана.
  }
  const parts = path.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  const joined = parts.join('/');
  return keepFragment && fragment ? `${joined}#${fragment}` : joined;
}
