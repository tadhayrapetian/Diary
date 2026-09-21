/* Отпечаток — putting it all together.
 *
 * Nothing in this file knows how to draw a photograph or arrange a sheet; it
 * only wires the buttons to the parts that do, and keeps the interface honest
 * about what is happening.
 */
(function (PP) {
  'use strict';

  var el = PP.ui.el;
  var $ = PP.ui.$;
  var busy = false;

  /* -------------------------------------------------------------- bringing in */

  function addFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return Promise.resolve();

    PP.ui.overlay.show('Открываю фотографии…', '');
    return PP.imaging
      .importFiles(list, function (done, total) {
        PP.ui.overlay.progress(done, total);
        PP.ui.overlay.note('Фото ' + done + ' из ' + total);
      })
      .then(function (result) {
        PP.ui.overlay.hide();
        if (!result.photos.length) {
          PP.ui.toast(
            result.skipped
              ? 'Это не те файлы — нужны JPEG, PNG, WebP. HEIC браузер не открывает.'
              : 'Ни одну фотографию открыть не вышло',
            'bad',
          );
          return;
        }

        PP.store.update(function (doc, ui) {
          var made = [];
          result.photos.forEach(function (photo) {
            doc.photos.push(photo);
            var item = PP.store.makeItem(photo.id);
            // A landscape photograph gets a landscape card, unless the format
            // only comes one way round.
            item.orient = photo.w > photo.h ? 'landscape' : 'portrait';
            doc.items.push(item);
            made.push(item.id);
          });
          ui.selected = made;
          if (!doc.title || doc.title === 'Без названия') {
            var first = result.photos[0].name.replace(/\.[^.]+$/, '');
            doc.title = first.length > 24 ? first.slice(0, 24) : first;
          }
        });

        if (PP.store.state.ui.fitZoom) PP.ui.stage.fitToWindow();

        var added = result.photos.length;
        var message =
          'Добавлено ' + added + ' ' + PP.units.plural(added, 'фото', 'фото', 'фото');
        if (result.failed.length) message += ' · не открылось: ' + result.failed.length;
        if (result.skipped) message += ' · пропущено не-картинок: ' + result.skipped;
        PP.ui.toast(message);
      })
      .catch(function (error) {
        PP.ui.overlay.hide();
        PP.ui.toast('Не получилось: ' + error.message, 'bad');
      });
  }

  /* ------------------------------------------------------------------ output */

  function guard(run, title) {
    if (busy) {
      PP.ui.toast('Подождите, ещё работаю');
      return Promise.resolve();
    }
    if (!PP.store.state.doc.items.length) {
      PP.ui.toast('Сначала добавьте фотографии', 'bad');
      return Promise.resolve();
    }
    busy = true;
    PP.ui.overlay.show(title, 'Готовлю листы…');
    return run()
      .then(function (result) {
        busy = false;
        PP.ui.overlay.hide();
        if (result && result.reduced) {
          PP.ui.toast('Лист очень большой — разрешение пришлось снизить', 'bad');
        }
        return result;
      })
      .catch(function (error) {
        busy = false;
        PP.ui.overlay.hide();
        PP.ui.toast('Не вышло: ' + (error.message || error), 'bad');
      });
  }

  function print() {
    return guard(function () {
      return PP.exporter.toPrinter(PP.store.state.doc, PP.ui.overlay.progress);
    }, 'Готовлю к печати…').then(function (result) {
      if (result) {
        PP.ui.toast('В окне печати выберите «Реальный размер» и поля «нет» — иначе размеры уедут');
      }
    });
  }

  function exportPdf() {
    return guard(function () {
      return PP.exporter.toPdf(PP.store.state.doc, PP.ui.overlay.progress);
    }, 'Собираю PDF…').then(function (result) {
      if (result) PP.ui.toast('PDF готов: ' + result.pages + ' лист(ов)');
    });
  }

  function exportImages() {
    return guard(function () {
      return PP.exporter.toImages(PP.store.state.doc, PP.ui.overlay.progress);
    }, 'Сохраняю листы…').then(function (result) {
      if (result) PP.ui.toast('Сохранено листов: ' + result.pages);
    });
  }

  function exportCards() {
    return guard(function () {
      return PP.exporter.toCards(PP.store.state.doc, PP.ui.overlay.progress);
    }, 'Сохраняю кадры…').then(function (result) {
      if (result) PP.ui.toast('Сохранено кадров: ' + result.pages);
    });
  }

  function saveProject(withPhotos) {
    if (!PP.store.state.doc.items.length && withPhotos) {
      PP.ui.toast('Пока нечего сохранять', 'bad');
      return Promise.resolve();
    }
    PP.ui.overlay.show('Сохраняю проект…', withPhotos ? 'Упаковываю фотографии' : '');
    return PP.exporter
      .saveProject(PP.store.state.doc, withPhotos)
      .then(function (result) {
        PP.ui.overlay.hide();
        PP.ui.toast(
          withPhotos
            ? 'Проект сохранён вместе с ' + result.photos + ' фото'
            : 'Настройки сохранены — фотографии нужно будет добавить заново',
        );
      })
      .catch(function (error) {
        PP.ui.overlay.hide();
        PP.ui.toast('Не сохранилось: ' + error.message, 'bad');
      });
  }

  function openProject(file) {
    PP.ui.overlay.show('Открываю проект…', '');
    return PP.exporter
      .loadProject(file)
      .then(function (doc) {
        PP.store.update(function (state, ui) {
          state.photos = doc.photos || [];
          state.items = doc.items || [];
          state.page = PP.store.merge(PP.store.defaultPage(), doc.page || {});
          state.output = PP.store.merge(PP.store.defaultOutput(), doc.output || {});
          state.defaults = PP.store.merge(PP.store.defaultItem(), doc.defaults || {});
          state.title = doc.title || 'Проект';
          ui.selected = [];
        });
        // Photographs that were not packed into the file cannot be drawn.
        var missing = PP.store.state.doc.photos.filter(function (photo) {
          return !PP.imaging.has(photo.id);
        });
        PP.render.clearCache();
        PP.ui.overlay.hide();
        PP.ui.toast(
          missing.length
            ? 'Проект открыт, но ' + missing.length + ' фото не хватает — добавьте их заново'
            : 'Проект открыт',
          missing.length ? 'bad' : '',
        );
        PP.ui.stage.fitToWindow();
      })
      .catch(function (error) {
        PP.ui.overlay.hide();
        PP.ui.toast('Не открылось: ' + error.message, 'bad');
      });
  }

  /* ------------------------------------------------------------- calibration */

  /**
   * A sheet with a square that is supposed to be exactly 50 mm. Measure what
   * comes out, tell the program, and every size after that is right.
   */
  function printCalibration() {
    var doc = PP.store.state.doc;
    var paper = PP.layout.paperSize(doc.page);
    var dpi = 300;
    var scale = dpi / PP.units.MM_PER_INCH;
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(paper.w * scale);
    canvas.height = Math.round(paper.h * scale);
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var sx = (doc.output.calibX || 100) / 100;
    var sy = (doc.output.calibY || 100) / 100;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(sx, sy);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);

    var mm = function (v) {
      return v * scale;
    };

    ctx.fillStyle = '#111';
    ctx.fillRect(mm(20), mm(30), mm(50), mm(50));

    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(1, mm(0.25));
    ctx.beginPath();
    ctx.moveTo(mm(20), mm(95));
    ctx.lineTo(mm(120), mm(95));
    for (var i = 0; i <= 100; i += 10) {
      ctx.moveTo(mm(20 + i), mm(95));
      ctx.lineTo(mm(20 + i), mm(95 + (i % 50 === 0 ? 6 : 3)));
    }
    ctx.moveTo(mm(20), mm(110));
    ctx.lineTo(mm(20), mm(210));
    for (var j = 0; j <= 100; j += 10) {
      ctx.moveTo(mm(20), mm(110 + j));
      ctx.lineTo(mm(20 + (j % 50 === 0 ? 6 : 3)), mm(110 + j));
    }
    ctx.stroke();

    ctx.fillStyle = '#111';
    ctx.font = mm(4) + 'px ' + PP.render.FONTS.sans;
    ctx.fillText('Отпечаток · калибровка принтера', mm(20), mm(20));
    ctx.font = mm(3.4) + 'px ' + PP.render.FONTS.sans;
    ctx.fillText('Квадрат должен быть ровно 50 × 50 мм.', mm(80), mm(40));
    ctx.fillText('Линейки — ровно 100 мм каждая.', mm(80), mm(47));
    ctx.fillText('Измерьте и впишите проценты во вкладке «Вывод».', mm(80), mm(54));
    ctx.fillText(
      'Печатать без масштабирования: «реальный размер», поля — нет.',
      mm(20),
      mm(225),
    );
    ctx.fillText(
      'Сейчас стоит: ' + PP.units.round(sx * 100, 1) + '% × ' + PP.units.round(sy * 100, 1) + '%',
      mm(20),
      mm(232),
    );

    var area = $('print-area');
    var styleTag = $('print-page-style');
    area.innerHTML = '';
    styleTag.textContent =
      '@page { size: ' + PP.units.round(paper.w, 2) + 'mm ' + PP.units.round(paper.h, 2) + 'mm; margin: 0; }';

    var sheetEl = el('div', { class: 'print-sheet' });
    sheetEl.style.width = paper.w + 'mm';
    sheetEl.style.height = paper.h + 'mm';
    var img = el('img', { src: canvas.toDataURL('image/png'), alt: 'Калибровка' });
    sheetEl.appendChild(img);
    area.appendChild(sheetEl);

    var go = function () {
      document.body.classList.add('printing');
      window.print();
      setTimeout(function () {
        document.body.classList.remove('printing');
        area.innerHTML = '';
      }, 1200);
    };
    if (img.complete) go();
    else img.onload = go;
  }

  /* -------------------------------------------------------------- the wiring */

  function wire() {
    $('btn-add').addEventListener('click', function () {
      $('file-input').click();
    });
    $('file-input').addEventListener('change', function (event) {
      addFiles(event.target.files);
      event.target.value = '';
    });
    $('project-input').addEventListener('change', function (event) {
      if (event.target.files[0]) openProject(event.target.files[0]);
      event.target.value = '';
    });

    $('btn-print').addEventListener('click', print);
    $('btn-undo').addEventListener('click', function () {
      if (!PP.store.undo()) PP.ui.toast('Отменять нечего');
    });
    $('btn-redo').addEventListener('click', function () {
      if (!PP.store.redo()) PP.ui.toast('Возвращать нечего');
    });

    PP.ui.bindMenu('btn-export', 'menu-export', function (action) {
      if (action === 'pdf') exportPdf();
      if (action === 'images') exportImages();
      if (action === 'cards') exportCards();
      if (action === 'calib') printCalibration();
    });

    PP.ui.bindMenu('btn-project', 'menu-project', function (action) {
      if (action === 'save-full') saveProject(true);
      if (action === 'save-light') saveProject(false);
      if (action === 'open') $('project-input').click();
      if (action === 'theme') toggleTheme();
      if (action === 'keys') PP.ui.shortcuts.help();
      if (action === 'clear') {
        PP.ui.confirm(
          'Очистить всё?',
          'Фотографии и раскладка уйдут. Отменить это уже нельзя.',
          'Очистить',
        ).then(function (yes) {
          if (yes) {
            PP.store.resetDocument();
            PP.render.clearCache();
            PP.ui.toast('Чисто');
          }
        });
      }
    });

    document.querySelectorAll('#mode-switch button').forEach(function (button) {
      button.addEventListener('click', function () {
        PP.store.ui(function (ui) {
          ui.mode = button.getAttribute('data-mode');
        }, 'mode');
      });
    });

    $('apply-all').addEventListener('change', function (event) {
      PP.store.ui(function (ui) {
        ui.applyToAll = event.target.checked;
      }, 'applyAll');
    });

    $('doc-title').addEventListener('input', function (event) {
      PP.store.update(
        function (doc) {
          doc.title = event.target.value;
        },
        { label: 'title', history: false },
      );
    });

    dragAndDrop();

    window.addEventListener('beforeunload', function (event) {
      if (!PP.store.state.doc.items.length) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function dragAndDrop() {
    var veil = $('drop-veil');
    var depth = 0;

    function hasFiles(event) {
      var types = event.dataTransfer && event.dataTransfer.types;
      if (!types) return false;
      return Array.prototype.indexOf.call(types, 'Files') >= 0;
    }

    window.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;
      depth++;
      veil.hidden = false;
    });
    window.addEventListener('dragover', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });
    window.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      veil.hidden = true;
      var files = Array.prototype.slice.call(event.dataTransfer.files);
      var project = files.filter(function (file) {
        return /\.json$/i.test(file.name);
      })[0];
      if (project) openProject(project);
      else addFiles(files);
    });
  }

  function toggleTheme() {
    var light = document.body.classList.toggle('theme-light');
    document.body.classList.toggle('theme-dark', !light);
    try {
      localStorage.setItem('otpechatok.theme', light ? 'light' : 'dark');
    } catch (error) {
      /* never mind */
    }
  }

  /* ------------------------------------------------------------- the repaint */

  function paint() {
    var state = PP.store.state;
    $('btn-undo').disabled = !PP.store.canUndo();
    $('btn-redo').disabled = !PP.store.canRedo();
    $('apply-all').checked = state.ui.applyToAll;
    if (document.activeElement !== $('doc-title')) $('doc-title').value = state.doc.title;

    document.querySelectorAll('#mode-switch button').forEach(function (button) {
      button.classList.toggle('on', button.getAttribute('data-mode') === state.ui.mode);
    });

    PP.ui.library.render();
    PP.ui.stage.render();
    PP.ui.inspector.render();
  }

  function boot() {
    PP.store.restore();
    try {
      if (localStorage.getItem('otpechatok.theme') === 'light') {
        document.body.classList.add('theme-light');
        document.body.classList.remove('theme-dark');
      }
    } catch (error) {
      /* never mind */
    }

    PP.ui.inspector.mount();
    PP.ui.library.mount();
    PP.ui.stage.mount();
    PP.ui.shortcuts.mount();
    wire();

    PP.store.subscribe(paint);
    paint();
    PP.ui.stage.fitToWindow();
  }

  PP.app = {
    boot: boot,
    addFiles: addFiles,
    print: print,
    exportPdf: exportPdf,
    exportImages: exportImages,
    exportCards: exportCards,
    saveProject: saveProject,
    openProject: openProject,
    printCalibration: printCalibration,
    toggleTheme: toggleTheme,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})((window.PP = window.PP || {}));
