/* Отпечаток — getting it out.
 *
 * Four ways out, all from the same rendered sheet: the printer, a PDF, images,
 * and single cards for a print service. Sheets are rasterised one at a time and
 * released, because a dozen A4 pages at 300 dpi held at once is a gigabyte.
 */
(function (PP) {
  'use strict';

  var MAX_SIDE = 16000; // the widest canvas a browser will reliably give you

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(
          function (blob) {
            blob ? resolve(blob) : reject(new Error('пустой холст'));
          },
          type,
          quality,
        );
      } else {
        var url = canvas.toDataURL(type, quality);
        resolve(dataUrlToBlob(url));
      }
    });
  }

  function dataUrlToBlob(url) {
    var parts = url.split(',');
    var mime = /:(.*?);/.exec(parts[0])[1];
    var binary = atob(parts[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function blobBytes(blob) {
    return blob.arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  /* Chromium quietly throws away a `download` name that is not ASCII — extension
   * and all, leaving a file called "download" with nothing to open it with. So
   * Russian names are transliterated rather than lost. */
  var TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };

  function safeName(name) {
    var out = '';
    var lower = String(name || '');
    for (var i = 0; i < lower.length; i++) {
      var char = lower[i];
      var key = char.toLowerCase();
      if (TRANSLIT[key] != null) {
        var piece = TRANSLIT[key];
        out += char === key ? piece : piece.charAt(0).toUpperCase() + piece.slice(1);
      } else if (/[A-Za-z0-9._-]/.test(char)) {
        out += char;
      } else if (/\s/.test(char)) {
        out += '-';
      }
    }
    out = out.replace(/-+/g, '-').replace(/^[-.]+/, '');
    return out || 'otpechatok';
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = safeName(filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /** Resolution that will not blow the canvas limit for this paper. */
  function safeScale(dpi, paper) {
    var scale = dpi / PP.units.MM_PER_INCH;
    var widest = Math.max(paper.w, paper.h) * scale;
    if (widest > MAX_SIDE) {
      return { scale: MAX_SIDE / Math.max(paper.w, paper.h), reduced: true };
    }
    return { scale: scale, reduced: false };
  }

  function sheetName(doc, index, ext) {
    var base = (doc.title || 'печать').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'печать';
    return base + '-' + String(index + 1).padStart(2, '0') + '.' + ext;
  }

  /**
   * Render sheets one by one, handing each to `onSheet` and letting the browser
   * breathe in between so the progress bar actually moves.
   */
  function eachSheet(doc, onSheet, onProgress, options) {
    var opts = options || {};
    var plan = PP.layout.build(doc, { respectSafe: false });
    if (!plan.pages.length) return Promise.reject(new Error('нечего печатать'));

    var fit = safeScale(opts.dpi || doc.output.dpi || 300, plan.paper);
    var index = 0;

    function step() {
      if (index >= plan.pages.length) {
        return Promise.resolve({ plan: plan, reduced: fit.reduced, scale: fit.scale });
      }
      var canvas = PP.sheet.sheetCanvas(plan.pages[index], plan, doc, fit.scale, {
        print: true,
        pageNumber: index + 1,
        pageCount: plan.pages.length,
        transparent: opts.transparent,
      });
      return Promise.resolve(onSheet(canvas, index, plan))
        .then(function () {
          index++;
          if (onProgress) onProgress(index, plan.pages.length);
          return new Promise(function (resolve) {
            setTimeout(resolve, 0);
          });
        })
        .then(step);
    }

    return step();
  }

  /* -------------------------------------------------------------------- PDF */

  function toPdf(doc, onProgress) {
    var pages = [];
    return eachSheet(
      doc,
      function (canvas, index, plan) {
        return canvasToBlob(canvas, 'image/jpeg', doc.output.quality || 0.92)
          .then(blobBytes)
          .then(function (bytes) {
            pages.push({
              wMm: plan.paper.w,
              hMm: plan.paper.h,
              jpeg: bytes,
              pxW: canvas.width,
              pxH: canvas.height,
            });
          });
      },
      onProgress,
    ).then(function (result) {
      var blob = PP.pdf.build(pages, { title: doc.title });
      download(blob, (doc.title || 'печать').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf');
      return { pages: pages.length, reduced: result.reduced };
    });
  }

  /* ----------------------------------------------------------------- images */

  function toImages(doc, onProgress) {
    var type = doc.output.format === 'png' ? 'image/png' : 'image/jpeg';
    var ext = type === 'image/png' ? 'png' : 'jpg';
    var count = 0;
    return eachSheet(
      doc,
      function (canvas, index) {
        return canvasToBlob(canvas, type, doc.output.quality).then(function (blob) {
          download(blob, sheetName(doc, index, ext));
          count++;
        });
      },
      onProgress,
    ).then(function (result) {
      return { pages: count, reduced: result.reduced };
    });
  }

  /**
   * Every card as its own file at its own size — what a print service asks for
   * when it does the cutting itself.
   */
  function toCards(doc, onProgress) {
    var type = doc.output.format === 'png' ? 'image/png' : 'image/jpeg';
    var ext = type === 'image/png' ? 'png' : 'jpg';
    var dpi = doc.output.dpi || 300;
    var items = doc.items.slice();
    if (!items.length) return Promise.reject(new Error('нет кадров'));

    var index = 0;
    function step() {
      if (index >= items.length) return Promise.resolve({ pages: index });
      var item = items[index];
      var photo = PP.store.photo(item.photoId);
      var card = PP.formats.cardSize(item);
      var fit = safeScale(dpi, card);
      var canvas = PP.render.cardCanvas(item, photo, fit.scale, {
        print: true,
        output: doc.output,
        noCache: true,
      });
      var name =
        (photo ? photo.name.replace(/\.[^.]+$/, '') : 'кадр') +
        '-' +
        PP.units.round(card.w, 0) +
        'x' +
        PP.units.round(card.h, 0) +
        'мм.' +
        ext;
      return canvasToBlob(canvas, type, doc.output.quality)
        .then(function (blob) {
          download(blob, name);
          index++;
          if (onProgress) onProgress(index, items.length);
          return new Promise(function (resolve) {
            setTimeout(resolve, 120); // browsers throttle a burst of downloads
          });
        })
        .then(step);
    }
    return step();
  }

  /* ------------------------------------------------------------------ print */

  /**
   * Hand the sheets to the printer.
   *
   * The page box is set to the paper's real size with no margin, and each sheet
   * is one image filling it exactly — so as long as the print dialog is left at
   * 100% (not "fit to page"), a 10 × 15 comes out 10 × 15.
   */
  function toPrinter(doc, onProgress) {
    var area = document.getElementById('print-area');
    var styleTag = document.getElementById('print-page-style');
    if (!area || !styleTag) return Promise.reject(new Error('нет области печати'));
    area.innerHTML = '';

    var images = [];
    return eachSheet(
      doc,
      function (canvas, index, plan) {
        return canvasToBlob(canvas, 'image/jpeg', Math.max(0.9, doc.output.quality || 0.92)).then(
          function (blob) {
            var url = URL.createObjectURL(blob);
            var sheetEl = document.createElement('div');
            sheetEl.className = 'print-sheet';
            sheetEl.style.width = plan.paper.w + 'mm';
            sheetEl.style.height = plan.paper.h + 'mm';
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Лист ' + (index + 1);
            sheetEl.appendChild(img);
            area.appendChild(sheetEl);
            images.push({ url: url, el: img });
          },
        );
      },
      onProgress,
    ).then(function (result) {
      styleTag.textContent =
        '@page { size: ' +
        PP.units.round(result.plan.paper.w, 2) +
        'mm ' +
        PP.units.round(result.plan.paper.h, 2) +
        'mm; margin: 0; }';

      return Promise.all(
        images.map(function (entry) {
          return entry.el.complete
            ? Promise.resolve()
            : new Promise(function (resolve) {
                entry.el.onload = resolve;
                entry.el.onerror = resolve;
              });
        }),
      ).then(function () {
        document.body.classList.add('printing');
        return new Promise(function (resolve) {
          var cleanup = function () {
            document.body.classList.remove('printing');
            window.removeEventListener('afterprint', cleanup);
            setTimeout(function () {
              images.forEach(function (entry) {
                URL.revokeObjectURL(entry.url);
              });
              area.innerHTML = '';
            }, 1500);
            resolve({ pages: images.length, reduced: result.reduced });
          };
          window.addEventListener('afterprint', cleanup);
          // Some browsers never fire afterprint; do not leave the app broken.
          setTimeout(function () {
            if (document.body.classList.contains('printing')) cleanup();
          }, 90000);
          setTimeout(function () {
            window.print();
          }, 60);
        });
      });
    });
  }

  /* ---------------------------------------------------------------- project */

  var PROJECT_MAX = 3000; // longest side kept in a saved project

  function saveProject(doc, withPhotos) {
    var payload = {
      app: 'otpechatok',
      version: 1,
      savedAt: new Date().toISOString(),
      doc: PP.store.clone(doc),
      assets: {},
    };

    if (!withPhotos) {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      download(blob, (doc.title || 'проект') + '.otpechatok.json');
      return Promise.resolve({ photos: 0 });
    }

    var photos = doc.photos.slice();
    var index = 0;
    function step() {
      if (index >= photos.length) {
        var out = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        download(out, (doc.title || 'проект') + '.otpechatok.json');
        return Promise.resolve({ photos: photos.length });
      }
      var photo = photos[index];
      var source = PP.imaging.full(photo.id);
      if (source) {
        var canvas = PP.imaging.scaleCanvas(source, PROJECT_MAX);
        payload.assets[photo.id] = canvas.toDataURL('image/jpeg', 0.9);
      }
      index++;
      return new Promise(function (resolve) {
        setTimeout(resolve, 0);
      }).then(step);
    }
    return step();
  }

  function loadProject(file) {
    return file.text().then(function (text) {
      var payload = JSON.parse(text);
      if (!payload || payload.app !== 'otpechatok') {
        throw new Error('это не проект Отпечатка');
      }
      var assets = payload.assets || {};
      var ids = Object.keys(assets);
      var index = 0;

      function step() {
        if (index >= ids.length) return Promise.resolve(payload.doc);
        var id = ids[index];
        return new Promise(function (resolve) {
          var img = new Image();
          img.onload = function () {
            PP.imaging.adopt(id, img);
            resolve();
          };
          img.onerror = resolve;
          img.src = assets[id];
        }).then(function () {
          index++;
          return step();
        });
      }
      return step();
    });
  }

  PP.exporter = {
    toPdf: toPdf,
    toImages: toImages,
    toCards: toCards,
    toPrinter: toPrinter,
    saveProject: saveProject,
    loadProject: loadProject,
    download: download,
    safeName: safeName,
    canvasToBlob: canvasToBlob,
    eachSheet: eachSheet,
    safeScale: safeScale,
  };
})((window.PP = window.PP || {}));
