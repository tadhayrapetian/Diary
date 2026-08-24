// EPUB 2 и 3: zip, в котором лежит пакет, корешок из XHTML-файлов и оглавление
// в одном из двух форматов — смотря какое было десятилетие.

import { openZip } from './zip.js';
import { parseXml, find, findAll, attr, children, trimmedText } from './xml.js';
import { renderDocument } from './html.js';
import { mediaTypeFor, resolvePath, dirOf } from './paths.js';

const CONTAINER = 'META-INF/container.xml';

function packagePath(zip) {
  if (zip.has(CONTAINER)) {
    const roots = findAll(parseXml(zip.text(CONTAINER)), 'rootfile');
    const opf = roots.map((r) => attr(r, 'full-path')).find((p) => p && zip.has(p));
    if (opf) return opf;
  }
  // Бывает, что контейнер сломан. Пакет при этом всё равно внутри.
  const guess = zip.names.find((n) => n.toLowerCase().endsWith('.opf'));
  if (!guess) throw new Error('не похоже на EPUB: нет OPF-файла');
  return guess;
}

function readMetadata(pkg) {
  const md = find(pkg, 'metadata');
  const all = (name) => children(md, name).map((n) => trimmedText(n)).filter(Boolean);
  const one = (name) => all(name)[0] || '';

  const metaTags = children(md, 'meta');
  const refines = new Map();
  for (const m of metaTags) {
    const property = attr(m, 'property');
    if (property) refines.set(`${attr(m, 'refines') || ''}|${property}`, trimmedText(m));
  }
  const legacyMeta = (name) => metaTags.find((m) => (attr(m, 'name') || '').toLowerCase() === name);

  // Серия, если её вообще записали, прячется в одном из двух соглашений.
  const seriesMeta = legacyMeta('calibre:series');
  const series = seriesMeta
    ? attr(seriesMeta, 'content')
    : [...refines].find(([k]) => k.endsWith('|belongs-to-collection'))?.[1] || '';
  const indexMeta = legacyMeta('calibre:series_index');
  const seriesIndex = indexMeta ? attr(indexMeta, 'content') : refines.get('|group-position') || '';

  return {
    title: one('title'),
    authors: all('creator'),
    language: one('language'),
    publisher: one('publisher'),
    description: one('description'),
    subjects: all('subject'),
    date: one('date'),
    identifier: one('identifier'),
    series: series || '',
    seriesIndex: seriesIndex || '',
  };
}

function readManifest(pkg, baseDir) {
  const items = new Map();
  for (const item of findAll(find(pkg, 'manifest'), 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    items.set(id, {
      id,
      href,
      path: resolvePath(baseDir, href),
      mediaType: attr(item, 'media-type') || '',
      properties: (attr(item, 'properties') || '').split(/\s+/).filter(Boolean),
    });
  }
  return items;
}

function readNav(zip, navItem, baseDir) {
  // EPUB 3: nav-документ — обычный XHTML со списком.
  const doc = parseXml(zip.text(navItem.path));
  const navs = findAll(doc, 'nav');
  const toc = navs.find((n) => (attr(n, 'type') || '').includes('toc')) || navs[0];
  if (!toc) return [];
  const navDir = dirOf(navItem.path);
  const out = [];
  const walk = (list, level) => {
    for (const li of children(list, 'li')) {
      const link = find(li, 'a');
      const title = trimmedText(link || find(li, 'span'));
      const href = link ? attr(link, 'href') : '';
      if (title) out.push({ title, href: href ? resolvePath(navDir, href, true) : '', level });
      for (const sub of children(li, 'ol').concat(children(li, 'ul'))) walk(sub, level + 1);
    }
  };
  for (const list of children(toc, 'ol').concat(children(toc, 'ul'))) walk(list, 0);
  return out;
}

function readNcx(zip, ncxItem) {
  // EPUB 2: NCX — вложенные navPoint'ы.
  const doc = parseXml(zip.text(ncxItem.path));
  const ncxDir = dirOf(ncxItem.path);
  const out = [];
  const walk = (parent, level) => {
    for (const point of children(parent, 'navpoint')) {
      const title = trimmedText(find(point, 'navlabel'));
      const href = attr(find(point, 'content'), 'src') || '';
      if (title) out.push({ title, href: href ? resolvePath(ncxDir, href, true) : '', level });
      walk(point, level + 1);
    }
  };
  walk(find(doc, 'navmap') || doc, 0);
  return out;
}

function findCover(zip, pkg, manifest, spine) {
  const byProperty = [...manifest.values()].find((i) => i.properties.includes('cover-image'));
  if (byProperty) return byProperty;

  const meta = findAll(find(pkg, 'metadata'), 'meta')
    .find((m) => (attr(m, 'name') || '').toLowerCase() === 'cover');
  const referenced = meta && manifest.get(attr(meta, 'content'));
  if (referenced?.mediaType.startsWith('image/')) return referenced;

  // Иначе: первая картинка на первой странице, если это страница обложки.
  const guide = findAll(find(pkg, 'guide'), 'reference')
    .find((r) => (attr(r, 'type') || '').toLowerCase() === 'cover');
  const candidates = [];
  if (guide) candidates.push(resolvePath('', attr(guide, 'href') || '', true));
  if (spine[0]) candidates.push(spine[0].path);

  for (const path of candidates) {
    const item = [...manifest.values()].find((i) => i.path === path);
    if (!item || !zip.has(item.path)) continue;
    const html = zip.text(item.path);
    const src = /<(?:img|image)[^>]*?(?:xlink:href|href|src)\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
    if (!src) continue;
    const resolved = resolvePath(dirOf(item.path), src, true);
    const image = [...manifest.values()].find((i) => i.path === resolved);
    if (image) return image;
  }

  return [...manifest.values()].find((i) => i.mediaType.startsWith('image/') && /cover/i.test(i.path)) || null;
}

/**
 * Прочитать книгу. Тела глав собираются по требованию — открыть книгу не должно
 * стоить целой книги.
 *
 * @param {Buffer} buffer
 * @param {{ resourceBase?: string }} [options] куда указывают переписанные адреса картинок
 */
export function readEpub(buffer, options = {}) {
  const zip = openZip(buffer);
  const opfPath = packagePath(zip);
  const baseDir = dirOf(opfPath);
  const pkg = find(parseXml(zip.text(opfPath)), 'package') || parseXml(zip.text(opfPath));

  const meta = readMetadata(pkg);
  const manifest = readManifest(pkg, baseDir);

  const spineEl = find(pkg, 'spine');
  const spine = findAll(spineEl, 'itemref')
    .filter((ref) => (attr(ref, 'linear') || 'yes') !== 'no')
    .map((ref) => manifest.get(attr(ref, 'idref')))
    .filter((item) => item && zip.has(item.path));
  if (!spine.length) {
    for (const item of manifest.values()) {
      if (/xhtml|html/.test(item.mediaType) && zip.has(item.path)) spine.push(item);
    }
  }
  if (!spine.length) throw new Error('в EPUB нет ни одной главы');

  const indexByPath = new Map(spine.map((item, i) => [item.path, i]));

  let toc = [];
  try {
    const navItem = [...manifest.values()].find((i) => i.properties.includes('nav'));
    const ncxId = attr(spineEl, 'toc');
    const ncxItem = (ncxId && manifest.get(ncxId))
      || [...manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml' || i.path.toLowerCase().endsWith('.ncx'));
    if (navItem && zip.has(navItem.path)) toc = readNav(zip, navItem, baseDir);
    else if (ncxItem && zip.has(ncxItem.path)) toc = readNcx(zip, ncxItem);
  } catch {
    toc = [];
  }

  const entries = toc
    .map((e) => {
      const [path, fragment = ''] = e.href.split('#');
      const chapter = indexByPath.get(path);
      return chapter === undefined ? null : { title: e.title, chapter, fragment, level: e.level };
    })
    .filter(Boolean);

  const chapters = spine.map((item, i) => ({
    index: i,
    path: item.path,
    title: entries.find((e) => e.chapter === i && !e.fragment)?.title || '',
    bytes: zip.size(item.path),
  }));

  const cover = findCover(zip, pkg, manifest, spine);
  const base = options.resourceBase || '';

  const resolveFrom = (dir) => (href) => {
    if (!href) return null;
    if (/^(https?|mailto|tel):/i.test(href)) return { kind: 'external', url: href };
    if (/^data:/i.test(href)) return { kind: 'res', url: href };
    const [rawPath, fragment = ''] = href.split('#');
    if (!rawPath) return { kind: 'chapter', chapter: -1, fragment };
    const path = resolvePath(dir, rawPath);
    const chapter = indexByPath.get(path);
    if (chapter !== undefined) return { kind: 'chapter', chapter, fragment };
    if (zip.has(path)) return { kind: 'res', url: `${base}${encodeURI(path)}` };
    return null;
  };

  return {
    format: 'epub',
    meta,
    chapters,
    toc: entries,
    cover: cover ? { path: cover.path, mediaType: cover.mediaType || mediaTypeFor(cover.path) } : null,
    hasResource: (path) => zip.has(path),
    resource(path) {
      if (!zip.has(path)) return null;
      return { data: zip.read(path), mediaType: mediaTypeFor(path) };
    },
    chapter(index) {
      const item = spine[index];
      if (!item) return null;
      const rendered = renderDocument(zip.text(item.path), { resolve: resolveFrom(dirOf(item.path)) });
      return {
        index,
        html: rendered.html,
        text: rendered.text,
        title: chapters[index].title || rendered.title,
        headings: rendered.headings,
      };
    },
  };
}
