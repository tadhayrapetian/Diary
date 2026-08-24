// Чтение форматов. Всё, что здесь проверяется, приходит из настоящих файлов,
// собранных в helpers.js, а не из заглушек.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openZip, looksLikeZip } from '../server/zip.js';
import { parseXml, find, findAll, attr, text, decodeEntities } from '../server/xml.js';
import { renderDocument } from '../server/html.js';
import { readEpub } from '../server/epub.js';
import { readFb2 } from '../server/fb2.js';
import { readDocx } from '../server/docx.js';
import { readPdfInfo } from '../server/pdf.js';
import { readPlainText, readMarkdown } from '../server/text.js';
import { decodeText } from '../server/encoding.js';
import { detectFormat } from '../server/library.js';
import { makeZip, makeEpub, makeEpub2, makeDocx, makeFb2, makePdf, toCp1251, pixel } from './helpers.js';

test('zip: хранёные и сжатые записи читаются одинаково', () => {
  const buffer = makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'папка/файл.txt', data: 'много текста '.repeat(50) },
  ]);
  assert.ok(looksLikeZip(buffer));
  const zip = openZip(buffer);
  assert.deepEqual(zip.names, ['mimetype', 'папка/файл.txt']);
  assert.equal(zip.text('mimetype'), 'application/epub+zip');
  assert.equal(zip.read('папка/файл.txt').length, Buffer.byteLength('много текста '.repeat(50)));
});

test('zip: чужой файл — понятная ошибка, а не мусор', () => {
  assert.throws(() => openZip(Buffer.from('не архив')), /not a zip/);
});

test('xml: сущности, пространства имён и незакрытые теги', () => {
  assert.equal(decodeEntities('А&nbsp;Б &mdash; &#1071; &amp;'), 'А Б — Я &');
  const doc = parseXml('<r><a:item x:id="7">раз</a:item><item>два</r>');
  const items = findAll(doc, 'item');
  assert.equal(items.length, 2);
  assert.equal(attr(items[0], 'id'), '7');
  assert.equal(text(items[1]), 'два');
});

test('html: скрипты и стили выброшены, ссылки переписаны', () => {
  const out = renderDocument(
    `<html><head><style>p{}</style></head><body onclick="x()">
     <h2 id="t">Заголовок</h2><p class="x" style="font-size:99px">Текст <b>жирный</b></p>
     <svg><image xlink:href="pic.png"/></svg><script>alert(1)</script></body></html>`,
    { resolve: (href) => ({ kind: 'res', url: `/res/${href}` }) },
  );
  assert.ok(!/script|style|onclick|font-size/.test(out.html));
  assert.match(out.html, /<h2 id="t">Заголовок<\/h2>/);
  assert.match(out.html, /<img src="\/res\/pic.png"/);
  assert.equal(out.headings[0].title, 'Заголовок');
  assert.match(out.text, /Текст жирный/);
});

test('epub 3: метаданные, оглавление, обложка, главы', () => {
  const book = readEpub(makeEpub(), { resourceBase: '/res/' });
  assert.equal(book.meta.title, 'Тень горы');
  assert.deepEqual(book.meta.authors, ['А. Иванова']);
  assert.equal(book.meta.series, 'Хроники');
  assert.equal(book.meta.seriesIndex, '2');
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].title, 'Глава первая');
  assert.equal(book.cover.path, 'OEBPS/images/cover.png');
  assert.deepEqual(book.toc.map((e) => [e.title, e.chapter, e.fragment, e.level]), [
    ['Глава первая', 0, '', 0],
    ['Второй раздел', 0, 'part2', 1],
    ['Глава вторая', 1, '', 0],
  ]);

  const first = book.chapter(0);
  assert.ok(!first.html.includes('script'));
  assert.match(first.html, /<em>рано<\/em>/);
  assert.match(first.html, /<img src="\/res\/OEBPS\/images\/cover.png"/);
  // Ссылка на другую главу становится переходом внутри книги, а не адресом.
  assert.match(first.html, /data-chapter="1" data-fragment="note"/);
  assert.equal(book.resource('OEBPS/images/cover.png').data.length, pixel().length);
});

test('epub 2: NCX и обложка через meta', () => {
  const book = readEpub(makeEpub2());
  assert.equal(book.meta.title, 'Старое издание');
  assert.equal(book.toc[0].title, 'Шинель');
  assert.equal(book.cover.path, 'cover.png');
  assert.match(book.chapter(0).html, /В департаменте/);
});

test('fb2: разделы, стихи, сноски, картинки', () => {
  const book = readFb2(makeFb2(), { resourceBase: '/res/' });
  assert.equal(book.meta.title, 'Шинель');
  assert.deepEqual(book.meta.authors, ['Николай Гоголь']);
  assert.equal(book.meta.series, 'Петербургские повести');
  assert.deepEqual(book.chapters.map((c) => c.title), ['Шинель', 'Часть первая', 'Часть вторая', 'Примечания']);
  const chapter = book.chapter(1);
  assert.match(chapter.html, /<em>одном<\/em>/);
  assert.match(chapter.html, /class="verse">Строка первая/);
  assert.match(chapter.html, /data-note="n1"/);
  assert.match(chapter.html, /<img src="\/res\/cover.png"/);
  assert.match(book.note('n1'), /Примечание автора/);
  assert.equal(book.resource('cover.png').mediaType, 'image/png');
});

test('fb2 в windows-1251 читается как русский текст', () => {
  const book = readFb2(makeFb2({ encoding: 'windows-1251' }));
  assert.equal(book.meta.title, 'Шинель');
  assert.match(book.chapter(1).html, /В департаменте/);
});

test('docx: заголовки делят документ на главы', () => {
  const book = readDocx(makeDocx());
  assert.equal(book.meta.title, 'Отчёт');
  assert.deepEqual(book.meta.authors, ['Т. Айрапетян']);
  assert.deepEqual(book.chapters.map((c) => c.title), ['Первый раздел', 'Второй раздел']);
  const first = book.chapter(0).html;
  assert.match(first, /<strong>жирным<\/strong>/);
  assert.match(first, /<ul><li>пункт списка<\/li><li>второй пункт<\/li><\/ul>/);
  assert.match(first, /<table><tr><td>ячейка<\/td><\/tr><\/table>/);
});

test('pdf: название и число страниц', () => {
  const info = readPdfInfo(makePdf({ title: 'Годовой отчёт', pages: 42 }));
  assert.equal(info.title, 'Годовой отчёт');
  assert.equal(info.pages, 42);
  assert.equal(info.encrypted, false);
});

test('txt: кодировка, деление на главы, стихи против прозы', () => {
  const source = [
    'ТИХИЙ ДОН', '', 'Глава 1', '',
    'Мелеховский двор — на самом краю хутора, и',
    'ворота его смотрят на север, к Дону.', '',
    'Мороз и солнце; день чудесный!', 'Ещё ты дремлешь, друг прелестный —', 'Пора, красавица, проснись:', '',
    'Глава 2', '', 'Второй кусок текста.', '',
    'Глава 3', '', 'Третий кусок текста.',
  ].join('\n');

  const book = readPlainText(toCp1251(source));
  assert.equal(book.title, 'ТИХИЙ ДОН');
  assert.deepEqual(book.chapters.map((c) => c.title), ['Глава 1', 'Глава 2', 'Глава 3']);
  const first = book.chapters[0].html;
  // Перенесённая по строкам проза склеивается в абзац…
  assert.match(first, /<p>Мелеховский двор — на самом краю хутора, и ворота его смотрят на север, к Дону.<\/p>/);
  // …а стихи сохраняют разбивку.
  assert.match(first, /verse-block">Мороз и солнце; день чудесный!<br>/);
});

test('кодировки: utf-8, windows-1251 и объявленная в файле', () => {
  const line = 'Ещё чуть-чуть, и всё получится.';
  assert.equal(decodeText(Buffer.from(line, 'utf8')), line);
  assert.equal(decodeText(toCp1251(line)), line);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line, 'utf8')])), line);
});

test('markdown: заголовки делят на главы, разметка становится тегами', () => {
  const book = readMarkdown(Buffer.from([
    '# Первая', '', 'Текст с **жирным** и *курсивом*.', '', '- раз', '- два', '',
    '# Вторая', '', '> цитата', '', '```', 'code()', '```',
  ].join('\n'), 'utf8'));
  assert.equal(book.title, 'Первая');
  assert.deepEqual(book.chapters.map((c) => c.title), ['Первая', 'Вторая']);
  assert.match(book.chapters[0].html, /<strong>жирным<\/strong>/);
  assert.match(book.chapters[0].html, /<ul><li>раз<\/li>/);
  assert.match(book.chapters[1].html, /<blockquote><p>цитата<\/p><\/blockquote>/);
  assert.match(book.chapters[1].html, /<pre><code>code\(\)<\/code><\/pre>/);
});

test('формат определяется по содержимому, а не по расширению', () => {
  assert.equal(detectFormat(makeEpub(), 'книга.bin'), 'epub');
  assert.equal(detectFormat(makeDocx(), 'документ.bin'), 'docx');
  assert.equal(detectFormat(makeFb2(), 'книга'), 'fb2');
  assert.equal(detectFormat(makePdf(), 'что-то'), 'pdf');
  assert.equal(detectFormat(Buffer.from('# Заметка'), 'заметка.md'), 'md');
  assert.equal(detectFormat(Buffer.from('<html><body>x'), 'стр.html'), 'html');
  assert.equal(detectFormat(Buffer.from('просто текст'), 'файл.txt'), 'txt');
});
