/* Отпечаток — getting photographs in.
 *
 * Nothing here ever leaves the machine. Files are decoded in the page, kept in
 * memory, and drawn straight onto the sheet; there is no upload, no server call
 * and no account. That is not a feature list, it is the reason a program like
 * this can be trusted with somebody's photographs.
 *
 * Decoding goes through createImageBitmap(blob) on purpose: bitmaps made from a
 * Blob are always origin-clean, so the canvas can still be read back even when
 * the page was opened by double-clicking the file.
 */
(function (PP) {
  'use strict';

  var assets = Object.create(null);
  var PREVIEW_MAX = 1500; // enough for any on-screen card, cheap to redraw
  var THUMB_MAX = 200;

  function supportsBitmap() {
    return typeof createImageBitmap === 'function';
  }

  function decode(file) {
    if (supportsBitmap()) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () {
          return createImageBitmap(file);
        })
        .catch(function () {
          return decodeViaImg(file);
        });
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          resolve(img);
        };
        img.onerror = function () {
          reject(new Error('не удалось открыть ' + file.name));
        };
        img.src = reader.result;
      };
      reader.onerror = function () {
        reject(new Error('не удалось прочитать ' + file.name));
      };
      reader.readAsDataURL(file);
    });
  }

  function sourceSize(source) {
    return {
      w: source.width || source.naturalWidth || 0,
      h: source.height || source.naturalHeight || 0,
    };
  }

  function scaleCanvas(source, maxSide) {
    var size = sourceSize(source);
    var scale = Math.min(1, maxSide / Math.max(size.w, size.h));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.w * scale));
    canvas.height = Math.max(1, Math.round(size.h * scale));
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Halving repeatedly keeps the downscale clean; one big drawImage aliases.
    ctx.drawImage(stepDown(source, canvas.width, canvas.height), 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function stepDown(source, targetW, targetH) {
    var size = sourceSize(source);
    var current = source;
    var w = size.w;
    var h = size.h;
    while (w / 2 > targetW && h / 2 > targetH) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      var step = document.createElement('canvas');
      step.width = w;
      step.height = h;
      var ctx = step.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(current, 0, 0, w, h);
      current = step;
    }
    return current;
  }

  // ------------------------------------------------------------------ EXIF

  /**
   * A very small EXIF reader: orientation and the moment the shutter opened.
   * Anything it does not understand it simply declines to guess at.
   */
  function readExif(file) {
    return file
      .slice(0, 256 * 1024)
      .arrayBuffer()
      .then(function (buffer) {
        try {
          return parseExif(new DataView(buffer));
        } catch (error) {
          return {};
        }
      })
      .catch(function () {
        return {};
      });
  }

  function parseExif(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {}; // not a JPEG
    var offset = 2;
    while (offset + 4 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      var marker = view.getUint8(offset + 1);
      var length = view.getUint16(offset + 2);
      if (marker === 0xe1) {
        // APP1 — "Exif\0\0" then a TIFF header
        if (view.getUint32(offset + 4) === 0x45786966) {
          return parseTiff(view, offset + 10);
        }
      }
      if (marker === 0xda) break; // start of scan; no metadata past here
      offset += 2 + length;
    }
    return {};
  }

  function parseTiff(view, start) {
    var little = view.getUint16(start) === 0x4949;
    if (view.getUint16(start + 2, little) !== 0x002a) return {};
    var ifd0 = start + view.getUint32(start + 4, little);
    var result = {};
    var exifOffset = 0;

    walkIfd(view, ifd0, start, little, function (tag, value) {
      if (tag === 0x0112) result.orientation = value;
      if (tag === 0x8769) exifOffset = value;
      if (tag === 0x010f) result.make = value;
      if (tag === 0x0110) result.model = value;
    });

    if (exifOffset) {
      walkIfd(view, start + exifOffset, start, little, function (tag, value) {
        if (tag === 0x9003 || (tag === 0x9004 && !result.date)) result.date = value;
        if (tag === 0x829a) result.exposure = value;
        if (tag === 0x8827) result.iso = value;
      });
    }
    return result;
  }

  function walkIfd(view, ifd, tiffStart, little, onTag) {
    if (ifd + 2 > view.byteLength) return;
    var count = view.getUint16(ifd, little);
    for (var i = 0; i < count; i++) {
      var entry = ifd + 2 + i * 12;
      if (entry + 12 > view.byteLength) return;
      var tag = view.getUint16(entry, little);
      var type = view.getUint16(entry + 2, little);
      var num = view.getUint32(entry + 4, little);
      var value = null;

      if (type === 3 && num === 1) {
        value = view.getUint16(entry + 8, little);
      } else if (type === 4 && num === 1) {
        value = view.getUint32(entry + 8, little);
      } else if (type === 2) {
        var at = num > 4 ? tiffStart + view.getUint32(entry + 8, little) : entry + 8;
        value = readAscii(view, at, num);
      } else if (type === 5 && num === 1) {
        var rat = tiffStart + view.getUint32(entry + 8, little);
        if (rat + 8 <= view.byteLength) {
          var den = view.getUint32(rat + 4, little);
          value = den ? view.getUint32(rat, little) / den : null;
        }
      }
      if (value !== null) onTag(tag, value);
    }
  }

  function readAscii(view, at, length) {
    var out = '';
    for (var i = 0; i < length - 1; i++) {
      if (at + i >= view.byteLength) break;
      var code = view.getUint8(at + i);
      if (!code) break;
      out += String.fromCharCode(code);
    }
    return out.trim();
  }

  /** EXIF writes dates as "2024:06:11 18:03:22". */
  function exifDate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  // ------------------------------------------------------------------ import

  function isImage(file) {
    if (file.type && /^image\//.test(file.type)) {
      return !/heic|heif/i.test(file.type);
    }
    return /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || '');
  }

  /**
   * Bring files in. Resolves with the records to put in the document; anything
   * that could not be read comes back in `failed` rather than stopping the rest.
   */
  function importFiles(files, onProgress) {
    var list = Array.prototype.slice.call(files).filter(isImage);
    var records = [];
    var failed = [];
    var done = 0;

    function step(index) {
      if (index >= list.length) return Promise.resolve({ photos: records, failed: failed });
      var file = list[index];
      return Promise.all([decode(file), readExif(file)])
        .then(function (pair) {
          var source = pair[0];
          var exif = pair[1] || {};
          var size = sourceSize(source);
          var id = PP.store.uid('ph');
          var preview = scaleCanvas(source, PREVIEW_MAX);
          var thumb = scaleCanvas(preview, THUMB_MAX);

          assets[id] = {
            full: source,
            preview: preview,
            thumbUrl: thumb.toDataURL('image/jpeg', 0.82),
            file: file,
          };

          var taken = exifDate(exif.date);
          records.push({
            id: id,
            name: file.name || 'без имени',
            w: size.w,
            h: size.h,
            bytes: file.size || 0,
            type: file.type || '',
            date: taken ? taken.toISOString() : '',
            camera: [exif.make, exif.model]
              .filter(Boolean)
              .join(' ')
              .replace(/(\w+)\s+\1/i, '$1'),
            iso: exif.iso || 0,
          });
        })
        .catch(function (error) {
          failed.push({ name: file.name, reason: error.message || String(error) });
        })
        .then(function () {
          done++;
          if (onProgress) onProgress(done, list.length);
          return step(index + 1);
        });
    }

    var skipped = Array.prototype.slice.call(files).length - list.length;
    return step(0).then(function (result) {
      result.skipped = skipped;
      return result;
    });
  }

  /** The bitmap to draw from: the small copy on screen, the real one for print. */
  function source(photoId, neededPx) {
    var asset = assets[photoId];
    if (!asset) return null;
    if (!neededPx) return asset.preview;
    var previewMax = Math.max(asset.preview.width, asset.preview.height);
    return neededPx > previewMax ? asset.full : asset.preview;
  }

  function full(photoId) {
    var asset = assets[photoId];
    return asset ? asset.full : null;
  }

  function thumb(photoId) {
    var asset = assets[photoId];
    return asset ? asset.thumbUrl : '';
  }

  function has(photoId) {
    return Boolean(assets[photoId]);
  }

  function file(photoId) {
    var asset = assets[photoId];
    return asset ? asset.file : null;
  }

  /** Re-register an asset restored from a saved project. */
  function adopt(photoId, source_, thumbUrl) {
    assets[photoId] = {
      full: source_,
      preview: scaleCanvas(source_, PREVIEW_MAX),
      thumbUrl: thumbUrl || scaleCanvas(source_, THUMB_MAX).toDataURL('image/jpeg', 0.82),
      file: null,
    };
  }

  PP.imaging = {
    importFiles: importFiles,
    decode: decode,
    source: source,
    full: full,
    thumb: thumb,
    has: has,
    file: file,
    adopt: adopt,
    scaleCanvas: scaleCanvas,
    readExif: readExif,
    exifDate: exifDate,
    isImage: isImage,
  };
})((window.PP = window.PP || {}));
