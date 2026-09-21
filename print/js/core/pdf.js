/* Отпечаток — a PDF, written by hand.
 *
 * A print shop wants a file whose pages are the exact size of the paper, with
 * the image placed on it at a known resolution. That is a small enough thing to
 * write out directly: catalogue, page tree, one JPEG XObject per page, an xref
 * table. No library, nothing fetched from the internet, and the file works
 * offline forever.
 */
(function (PP) {
  'use strict';

  var PT_PER_MM = 72 / 25.4;

  function latin1(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  /** PDF text strings hold Cyrillic only as UTF-16BE with a byte-order mark. */
  function utf16String(text) {
    var bytes = [0xfe, 0xff];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      bytes.push((code >> 8) & 0xff, code & 0xff);
    }
    var escaped = '';
    for (var j = 0; j < bytes.length; j++) {
      var b = bytes[j];
      if (b === 0x28 || b === 0x29 || b === 0x5c) escaped += '\\';
      escaped += String.fromCharCode(b);
    }
    return '(' + escaped + ')';
  }

  function pdfDate(date) {
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return (
      'D:' +
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    );
  }

  /**
   * pages: [{ wMm, hMm, jpeg: Uint8Array, pxW, pxH }]
   * Each page carries one image covering the whole sheet — which is how the
   * sheets are rendered anyway, and what keeps colour and placement identical
   * between the PDF, the exported image and the printer.
   */
  function build(pages, meta) {
    var info = meta || {};
    var chunks = [];
    var length = 0;
    var offsets = [0]; // object 0 is the free head

    function push(bytes) {
      chunks.push(bytes);
      length += bytes.length;
    }

    function pushText(text) {
      push(latin1(text));
    }

    function beginObject(number) {
      offsets[number] = length;
      pushText(number + ' 0 obj\n');
    }

    function endObject() {
      pushText('endobj\n');
    }

    var objectCount = 3 + pages.length * 3; // catalogue, pages, info + 3 per page
    var pageIds = [];
    for (var i = 0; i < pages.length; i++) pageIds.push(4 + i * 3);

    pushText('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

    // 1: catalogue
    beginObject(1);
    pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
    endObject();

    // 2: page tree
    beginObject(2);
    pushText(
      '<< /Type /Pages /Count ' +
        pages.length +
        ' /Kids [' +
        pageIds
          .map(function (id) {
            return id + ' 0 R';
          })
          .join(' ') +
        '] >>\n',
    );
    endObject();

    // 3: document information
    beginObject(3);
    pushText(
      '<< /Producer (Otpechatok) /Creator ' +
        utf16String(info.creator || 'Отпечаток') +
        ' /Title ' +
        utf16String(info.title || 'Фотопечать') +
        ' /CreationDate (' +
        pdfDate(new Date()) +
        ') >>\n',
    );
    endObject();

    pages.forEach(function (page, index) {
      var pageId = 4 + index * 3;
      var contentId = pageId + 1;
      var imageId = pageId + 2;
      var wPt = PP.units.round(page.wMm * PT_PER_MM, 3);
      var hPt = PP.units.round(page.hMm * PT_PER_MM, 3);

      beginObject(pageId);
      pushText(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
          wPt +
          ' ' +
          hPt +
          '] /Resources << /XObject << /Im0 ' +
          imageId +
          ' 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ' +
          contentId +
          ' 0 R >>\n',
      );
      endObject();

      var content = 'q\n' + wPt + ' 0 0 ' + hPt + ' 0 0 cm\n/Im0 Do\nQ\n';
      beginObject(contentId);
      pushText('<< /Length ' + content.length + ' >>\nstream\n');
      pushText(content);
      pushText('endstream\n');
      endObject();

      beginObject(imageId);
      pushText(
        '<< /Type /XObject /Subtype /Image /Width ' +
          page.pxW +
          ' /Height ' +
          page.pxH +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
          page.jpeg.length +
          ' >>\nstream\n',
      );
      push(page.jpeg);
      pushText('\nendstream\n');
      endObject();
    });

    var xrefAt = length;
    pushText('xref\n0 ' + (objectCount + 1) + '\n');
    pushText('0000000000 65535 f \n');
    for (var n = 1; n <= objectCount; n++) {
      var at = offsets[n] || 0;
      pushText(('0000000000' + at).slice(-10) + ' 00000 n \n');
    }
    pushText(
      'trailer\n<< /Size ' +
        (objectCount + 1) +
        ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' +
        xrefAt +
        '\n%%EOF\n',
    );

    var blob = new Blob(chunks, { type: 'application/pdf' });
    return blob;
  }

  PP.pdf = { build: build, PT_PER_MM: PT_PER_MM };
})((window.PP = window.PP || {}));
