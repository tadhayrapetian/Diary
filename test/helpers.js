// Сборка настоящих файлов для тестов: zip-писалка (в приложении есть только
// читалка) и минимальные EPUB, FB2, DOCX, которые не отличить от привезённых
// из жизни — тем и полезны.

import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * Собрать zip из записей `{ name, data, store }`.
 * @param {{name: string, data: string|Buffer, store?: boolean}[]} entries
 */
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = entry.store ? data : deflateRawSync(data);
    const method = entry.store ? 0 : 8;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // имена в utf-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(0x02014b50, 0);
    entryHeader.writeUInt16LE(20, 4);
    entryHeader.writeUInt16LE(20, 6);
    entryHeader.writeUInt16LE(0x0800, 8);
    entryHeader.writeUInt16LE(method, 10);
    entryHeader.writeUInt32LE(sum, 16);
    entryHeader.writeUInt32LE(compressed.length, 20);
    entryHeader.writeUInt32LE(data.length, 24);
    entryHeader.writeUInt16LE(name.length, 28);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, name);

    offset += 30 + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export const pixel = () => Buffer.from(PNG);

/** EPUB 3 с навигацией, обложкой и перекрёстной ссылкой между главами. */
export function makeEpub({ title = 'Тень горы', author = 'А. Иванова' } = {}) {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:1234</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>ru</dc:language>
    <dc:publisher>Издательство</dc:publisher>
    <dc:description>Аннотация &amp; прочее</dc:description>
    <meta name="calibre:series" content="Хроники"/>
    <meta name="calibre:series_index" content="2"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="text/one.xhtml">Глава первая</a>
    <ol><li><a href="text/one.xhtml#part2">Второй раздел</a></li></ol>
  </li>
  <li><a href="text/two.xhtml">Глава вторая</a></li>
</ol></nav></body></html>`;

  const one = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава первая</title>
<link rel="stylesheet" href="../style.css"/><style>p { color: red }</style></head>
<body onload="hack()">
<h1 id="top">Глава первая</h1>
<p class="first">Мы вышли <em>рано</em>, ещё до света.</p>
<p id="part2">Дальше был <a href="two.xhtml#note">переход</a> и <img src="../images/cover.png" alt="гора"/>.</p>
<script>alert(1)</script>
</body></html>`;

  const two = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава вторая</title></head>
<body><h1>Глава вторая</h1><p id="note">Короткое примечание.</p>
<p>Текст с неразрывным&#160;пробелом и &laquo;кавычками&raquo;.</p></body></html>`;

  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/text/one.xhtml', data: one },
    { name: 'OEBPS/text/two.xhtml', data: two },
    { name: 'OEBPS/style.css', data: 'p { font-family: Comic Sans }' },
    { name: 'OEBPS/images/cover.png', data: pixel() },
  ]);
}

/** EPUB 2: NCX вместо nav, обложка через <meta name="cover">. */
export function makeEpub2() {
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="i">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Старое издание</dc:title><dc:creator opf:role="aut">Н. Гоголь</dc:creator>
    <dc:language>ru</dc:language><dc:identifier id="i">isbn:1</dc:identifier>
    <meta name="cover" content="coverimg"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="coverimg" href="cover.png" media-type="image/png"/>
    <item id="ch1" href="ch1.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`;
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
<navMap><navPoint id="n1" playOrder="1"><navLabel><text>Шинель</text></navLabel><content src="ch1.html"/></navPoint></navMap></ncx>`;
  return makeZip([
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>` },
    { name: 'content.opf', data: opf },
    { name: 'toc.ncx', data: ncx },
    { name: 'cover.png', data: pixel() },
    { name: 'ch1.html', data: '<html><body><h2>Шинель</h2><p>В департаменте...</p></body></html>' },
  ]);
}

export function makeDocx() {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Первый раздел</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">Обычный текст со </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>жирным</w:t></w:r><w:r><w:t> концом.</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>пункт списка</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>второй пункт</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>ячейка</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Второй раздел</w:t></w:r></w:p>
  <w:p><w:r><w:t>Хвост.</w:t></w:r></w:p>
</w:body></w:document>`;
  const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const core = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Отчёт</dc:title><dc:creator>Т. Айрапетян</dc:creator></cp:coreProperties>`;
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/numbering.xml', data: numbering },
    { name: 'docProps/core.xml', data: core },
  ]);
}

export function makeFb2({ encoding = 'utf-8' } = {}) {
  const xml = `<?xml version="1.0" encoding="${encoding}"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info>
  <genre>prose</genre>
  <author><first-name>Николай</first-name><last-name>Гоголь</last-name></author>
  <book-title>Шинель</book-title>
  <annotation><p>Повесть о шинели.</p></annotation>
  <lang>ru</lang>
  <coverpage><image l:href="#cover.png"/></coverpage>
  <sequence name="Петербургские повести" number="3"/>
</title-info></description>
<body><title><p>Шинель</p></title>
<section><title><p>Часть первая</p></title>
  <p>В департаменте <emphasis>одном</emphasis> служил чиновник<a l:href="#n1" type="note">[1]</a>.</p>
  <empty-line/>
  <poem><stanza><v>Строка первая</v><v>Строка вторая</v></stanza></poem>
  <image l:href="#cover.png"/>
</section>
<section><title><p>Часть вторая</p></title><p>Продолжение.</p></section>
</body>
<body name="notes"><section id="n1"><title><p>1</p></title><p>Примечание автора.</p></section></body>
<binary id="cover.png" content-type="image/png">${PNG.toString('base64')}</binary>
</FictionBook>`;
  if (encoding === 'utf-8') return Buffer.from(xml, 'utf8');
  return toCp1251(xml);
}

/** Перекодировать в windows-1251 без сторонних библиотек. */
export function toCp1251(text) {
  const table = new Map();
  const bytes = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const chars = new TextDecoder('windows-1251').decode(bytes);
  for (let i = 0; i < 256; i++) table.set(chars[i], i);
  return Buffer.from([...text].map((char) => table.get(char) ?? 0x3f));
}

export function makePdf({ title = 'Годовой отчёт', pages = 3 } = {}) {
  // Кириллица в PDF пишется как UTF-16BE в шестнадцатеричной строке — так её
  // и кладёт Word, и так её надо уметь читать.
  const hex = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(title, 'utf16le').swap16()]).toString('hex');
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count ${pages}>>endobj`,
    '3 0 obj<</Type/Page/Parent 2 0 R>>endobj',
    `4 0 obj<</Title <${hex}>/Author(Ivanov)>>endobj`,
    'trailer<</Root 1 0 R/Info 4 0 R>>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(body, 'latin1');
}
