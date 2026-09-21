/* Отпечаток — the right-hand panel.
 *
 * Six panels, described as lists of controls. Item controls write to every
 * selected card at once (or to all of them, if the switch at the bottom is on),
 * which is what makes "sixty photographs, all the same frame" a two-second job.
 */
(function (PP) {
  'use strict';

  var el = PP.ui.el;
  var fields = PP.ui.fields;

  var TABS = [
    { id: 'format', name: 'Формат', scope: 'item' },
    { id: 'frame', name: 'Рамка', scope: 'item' },
    { id: 'color', name: 'Цвет', scope: 'item' },
    { id: 'text', name: 'Подпись', scope: 'item' },
    { id: 'page', name: 'Лист', scope: 'doc' },
    { id: 'out', name: 'Вывод', scope: 'doc' },
  ];

  var built = { tab: null, controls: [], head: null };

  /* ----------------------------------------------------------------- access */

  function itemCtx() {
    return {
      get: function (path) {
        var item = PP.store.subject();
        return item ? fields.getPath(item, path) : null;
      },
      set: function (path, value, opts) {
        var targets = PP.store.targets();
        if (!targets.length) return;
        PP.store.update(
          function () {
            targets.forEach(function (item) {
              fields.setPath(item, path, value);
              if (path.indexOf('adj.') === 0 && path !== 'adj.preset') item.adj.preset = 'custom';
            });
            var focus = PP.store.subject();
            if (focus) PP.store.rememberDefaults(focus);
          },
          { label: (opts && opts.label) || path, reason: 'item' },
        );
      },
    };
  }

  function docCtx(branch) {
    return {
      get: function (path) {
        return fields.getPath(PP.store.state.doc[branch], path);
      },
      set: function (path, value, opts) {
        PP.store.update(
          function (doc) {
            fields.setPath(doc[branch], path, value);
          },
          { label: branch + '.' + ((opts && opts.label) || path), reason: branch },
        );
      },
    };
  }

  /* ------------------------------------------------------------- the panels */

  function formatPanel() {
    return [
      { type: 'custom', build: formatChooser },
      { type: 'group', label: 'Ориентация' },
      {
        type: 'chips',
        key: 'orient',
        options: [
          { value: 'portrait', label: 'Вертикально' },
          { value: 'landscape', label: 'Горизонтально' },
        ],
      },
      {
        type: 'buttons',
        buttons: [
          {
            label: 'По фото',
            hint: 'Повернуть карточку под пропорции снимка',
            run: function () {
              orientByPhoto();
            },
          },
          {
            label: 'Вписать',
            hint: 'Целиком в кадр, с полями',
            run: function (ctx) {
              ctx.set('fit', 'contain', { label: 'fit' });
              resetPan();
            },
          },
          {
            label: 'Заполнить',
            hint: 'Заполнить окно, края обрезать',
            run: function (ctx) {
              ctx.set('fit', 'cover', { label: 'fit' });
              resetPan();
            },
          },
        ],
      },
      { type: 'group', label: 'Свой размер, мм' },
      { type: 'pair', label: 'Ширина и высота', keyA: 'custom.w', keyB: 'custom.h', min: 10, max: 1200, step: 1, unit: 'мм' },
      {
        type: 'buttons',
        buttons: [
          {
            label: 'Применить свой размер',
            run: function (ctx) {
              ctx.set('formatId', 'custom', { label: 'formatId' });
            },
          },
        ],
      },
      { type: 'group', label: 'Кадрирование' },
      { type: 'range', key: 'zoom', label: 'Приближение', min: 0.2, max: 6, step: 0.01, default: 1, places: 2 },
      { type: 'range', key: 'angle', label: 'Поворот', min: -180, max: 180, step: 0.5, default: 0, unit: '°', sign: true },
      { type: 'range', key: 'ox', label: 'Сдвиг по горизонтали', min: -1, max: 1, step: 0.01, default: 0, places: 2, sign: true },
      { type: 'range', key: 'oy', label: 'Сдвиг по вертикали', min: -1, max: 1, step: 0.01, default: 0, places: 2, sign: true },
      {
        type: 'buttons',
        buttons: [
          { label: '⟲ 90°', run: function () { rotateBy(-90); } },
          { label: '⟳ 90°', run: function () { rotateBy(90); } },
          { label: '⇋', hint: 'Отразить слева направо', run: function (ctx) { flip(ctx, 'flipH'); } },
          { label: '⇵', hint: 'Отразить сверху вниз', run: function (ctx) { flip(ctx, 'flipV'); } },
          { label: 'В центр', run: function () { resetPan(); } },
        ],
      },
      { type: 'group', label: 'Копии' },
      { type: 'number', key: 'copies', label: 'Сколько печатать', min: 1, max: 999, step: 1, places: 0 },
      { type: 'custom', build: readout },
    ];
  }

  function framePanel() {
    return [
      { type: 'custom', build: framePresets },
      { type: 'group', label: 'Вид рамки' },
      {
        type: 'chips',
        key: 'frame.style',
        options: [
          { value: 'classic', label: 'Полароид', hint: 'Широкое поле снизу' },
          { value: 'edge', label: 'Ровное поле' },
          { value: 'matte', label: 'Паспарту' },
          { value: 'none', label: 'В обрез' },
        ],
      },
      { type: 'color', key: 'frame.color', label: 'Цвет рамки' },
      { type: 'range', key: 'frame.border', label: 'Поле', min: 0, max: 40, step: 0.5, default: 6, unit: 'мм' },
      { type: 'note', text: 'Поле работает для «ровного поля» и паспарту. У полароида поля берутся от плёнки — ниже их можно переопределить.' },
      {
        type: 'range',
        key: 'frame.side',
        label: 'Поля по бокам',
        min: 0,
        max: 30,
        step: 0.5,
        default: 4.5,
        unit: 'мм',
        fallback: function () {
          return filmGeometry('side');
        },
      },
      {
        type: 'range',
        key: 'frame.bottom',
        label: 'Поле снизу',
        min: 0,
        max: 80,
        step: 0.5,
        default: 23.5,
        unit: 'мм',
        fallback: function () {
          return filmGeometry('bottom');
        },
      },
      {
        type: 'buttons',
        buttons: [
          {
            label: 'Вернуть поля плёнки',
            run: function (ctx) {
              ctx.set('frame.side', null, { label: 'frame.auto' });
              ctx.set('frame.bottom', null, { label: 'frame.auto' });
            },
          },
        ],
      },
      { type: 'group', label: 'Отделка' },
      { type: 'range', key: 'frame.radius', label: 'Скругление углов', min: 0, max: 14, step: 0.1, default: 1.6, unit: 'мм' },
      { type: 'range', key: 'frame.line', label: 'Кант у окна', min: 0, max: 2, step: 0.05, default: 0, unit: 'мм', places: 2 },
      { type: 'color', key: 'frame.lineColor', label: 'Цвет канта' },
      { type: 'toggle', key: 'frame.shadow', label: 'Тень на экране', hint: 'Только для предпросмотра, не печатается' },
    ];
  }

  function colorPanel() {
    return [
      { type: 'custom', build: colorPresets },
      { type: 'group', label: 'Свет' },
      { type: 'range', key: 'adj.exposure', label: 'Экспозиция', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.contrast', label: 'Контраст', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.highlights', label: 'Света', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.shadows', label: 'Тени', min: -100, max: 100, default: 0, sign: true },
      { type: 'group', label: 'Цвет' },
      { type: 'range', key: 'adj.saturation', label: 'Насыщенность', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.temp', label: 'Тепло', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.tint', label: 'Оттенок', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.rotateHue', label: 'Сдвиг тона', min: -180, max: 180, default: 0, unit: '°', sign: true },
      { type: 'range', key: 'adj.mono', label: 'Чёрно-белое', min: 0, max: 100, default: 0 },
      { type: 'range', key: 'adj.sepia', label: 'Сепия', min: 0, max: 100, default: 0 },
      { type: 'group', label: 'Фактура' },
      { type: 'range', key: 'adj.clarity', label: 'Чёткость', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.grain', label: 'Зерно', min: 0, max: 100, default: 0 },
      { type: 'range', key: 'adj.fade', label: 'Выцветание', min: 0, max: 100, default: 0 },
      { type: 'range', key: 'adj.vignette', label: 'Виньетка', min: -100, max: 100, default: 0, sign: true },
      { type: 'range', key: 'adj.blur', label: 'Размытие', min: 0, max: 100, default: 0 },
      {
        type: 'buttons',
        buttons: [
          {
            label: 'Сбросить цвет',
            run: function (ctx) {
              var targets = PP.store.targets();
              PP.store.update(
                function () {
                  targets.forEach(function (item) {
                    PP.adjust.applyPreset(item.adj, 'none');
                  });
                },
                { label: 'adj.reset' },
              );
            },
          },
          {
            label: 'Скопировать всем',
            hint: 'Цвет этого кадра — на все остальные',
            run: function () {
              var focus = PP.store.subject();
              if (!focus) return;
              var adj = PP.store.clone(focus.adj);
              PP.store.update(function (doc) {
                doc.items.forEach(function (item) {
                  item.adj = PP.store.clone(adj);
                });
              });
              PP.ui.toast('Цвет разошёлся по всем кадрам');
            },
          },
        ],
      },
    ];
  }

  function textPanel() {
    return [
      { type: 'group', label: 'Подпись на рамке' },
      { type: 'textarea', key: 'text.caption', label: 'Текст', placeholder: 'Лето, наконец-то…', rows: 2 },
      {
        type: 'select',
        key: 'text.font',
        label: 'Шрифт',
        options: PP.render.FONT_NAMES.map(function (font) {
          return { value: font.id, label: font.name };
        }),
      },
      { type: 'range', key: 'text.size', label: 'Размер', min: 1.5, max: 20, step: 0.1, default: 5, unit: 'мм' },
      { type: 'color', key: 'text.color', label: 'Цвет' },
      {
        type: 'chips',
        key: 'text.align',
        label: 'Выравнивание',
        options: [
          { value: 'left', label: 'Слева' },
          { value: 'center', label: 'По центру' },
          { value: 'right', label: 'Справа' },
        ],
      },
      { type: 'range', key: 'text.offset', label: 'Сдвиг вниз', min: -20, max: 20, step: 0.5, default: 0, unit: 'мм', sign: true },
      {
        type: 'buttons',
        buttons: [
          {
            label: 'Подставить имя файла',
            run: function () {
              fillCaption(function (photo) {
                return photo.name.replace(/\.[^.]+$/, '');
              });
            },
          },
          {
            label: 'Подставить дату съёмки',
            run: function () {
              fillCaption(function (photo) {
                return photo.date
                  ? new Date(photo.date).toLocaleDateString('ru-RU', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })
                  : '';
              });
            },
          },
          {
            label: 'Очистить',
            run: function (ctx) {
              ctx.set('text.caption', '', { label: 'caption.clear' });
            },
          },
        ],
      },
      { type: 'group', label: 'Дата в углу кадра' },
      { type: 'toggle', key: 'text.stamp', label: 'Ставить дату', hint: 'Как на плёночной мыльнице' },
      { type: 'text', key: 'text.stampText', label: 'Что печатать', placeholder: '11.06.2024' },
      {
        type: 'buttons',
        buttons: [
          { label: 'ДД.ММ.ГГГГ', run: function () { stampAll('dmy'); } },
          { label: 'ГГГГ ММ ДД', run: function () { stampAll('ymd'); } },
          { label: 'С временем', run: function () { stampAll('time'); } },
        ],
      },
      { type: 'color', key: 'text.stampColor', label: 'Цвет даты' },
      { type: 'range', key: 'text.stampSize', label: 'Размер даты', min: 1.5, max: 12, step: 0.1, default: 3.2, unit: 'мм' },
    ];
  }

  function pagePanel() {
    return [
      { type: 'group', label: 'Бумага' },
      {
        type: 'select',
        key: 'paperId',
        options: PP.formats.PAPERS.map(function (paper) {
          return {
            value: paper.id,
            label: paper.name + (paper.id === 'custom' ? '' : ' · ' + PP.units.sizeLabel(paper.w, paper.h)),
          };
        }),
      },
      { type: 'pair', label: 'Свой лист', keyA: 'paperCustom.w', keyB: 'paperCustom.h', min: 20, max: 3000, step: 1, unit: 'мм' },
      {
        type: 'chips',
        key: 'orient',
        label: 'Ориентация листа',
        options: [
          { value: 'portrait', label: 'Вертикально' },
          { value: 'landscape', label: 'Горизонтально' },
        ],
      },
      { type: 'range', key: 'margin', label: 'Поля листа', min: 0, max: 40, step: 0.5, default: 6, unit: 'мм' },
      { type: 'toggle', key: 'borderless', label: 'Печать без полей', hint: 'Если принтер так умеет' },
      { type: 'range', key: 'gap', label: 'Зазор между фото', min: 0, max: 30, step: 0.5, default: 4, unit: 'мм' },
      { type: 'group', label: 'Раскладка' },
      {
        type: 'chips',
        key: 'mode',
        options: PP.layout.MODES.map(function (mode) {
          return { value: mode.id, label: mode.name, hint: mode.hint };
        }),
      },
      {
        type: 'chips',
        key: 'align',
        label: 'Прижать',
        options: [
          { value: 'center', label: 'По центру' },
          { value: 'topleft', label: 'В угол' },
        ],
      },
      { type: 'toggle', key: 'autoRotate', label: 'Поворачивать, если так влезет больше' },
      { type: 'number', key: 'contactCols', label: 'Колонок на контрольном листе', min: 1, max: 12, step: 1, places: 0 },
      { type: 'number', key: 'fillCount', label: 'Сколько копий при заполнении (0 — сколько влезет)', min: 0, max: 200, step: 1, places: 0 },
      { type: 'group', label: 'Метки и фон' },
      { type: 'toggle', key: 'cutMarks', label: 'Метки реза по углам' },
      { type: 'toggle', key: 'cutLines', label: 'Линии реза насквозь' },
      { type: 'toggle', key: 'showNames', label: 'Имена файлов', hint: 'На контрольном листе' },
      { type: 'toggle', key: 'pageNumbers', label: 'Номер листа' },
      { type: 'color', key: 'background', label: 'Цвет бумаги' },
      { type: 'toggle', key: 'paperTint', label: 'Тёплый оттенок бумаги на экране' },
    ];
  }

  function outPanel() {
    return [
      { type: 'group', label: 'Качество' },
      {
        type: 'select',
        key: 'dpi',
        label: 'Разрешение печати',
        numeric: true,
        options: [
          { value: 150, label: '150 dpi — черновик' },
          { value: 200, label: '200 dpi — быстро' },
          { value: 300, label: '300 dpi — обычная печать' },
          { value: 400, label: '400 dpi — придирчиво' },
          { value: 600, label: '600 dpi — предел' },
        ],
      },
      {
        type: 'select',
        key: 'format',
        label: 'Формат картинок',
        options: [
          { value: 'jpeg', label: 'JPEG — меньше вес' },
          { value: 'png', label: 'PNG — без потерь' },
        ],
      },
      { type: 'range', key: 'quality', label: 'Качество JPEG', min: 0.5, max: 1, step: 0.01, default: 0.94, places: 2 },
      { type: 'group', label: 'Экономия и пробы' },
      { type: 'toggle', key: 'inkSaver', label: 'Экономить чернила', hint: 'Светлее и бледнее — для черновиков' },
      { type: 'toggle', key: 'proofMono', label: 'Пробная печать в сером' },
      { type: 'group', label: 'Калибровка принтера' },
      {
        type: 'note',
        text:
          'Напечатайте пробный лист, измерьте линейкой чёрный квадрат и, если он вышел не 50 мм, подправьте проценты — дальше все размеры будут точными.',
      },
      { type: 'range', key: 'calibX', label: 'По ширине', min: 90, max: 110, step: 0.1, default: 100, unit: '%', places: 1 },
      { type: 'range', key: 'calibY', label: 'По высоте', min: 90, max: 110, step: 0.1, default: 100, unit: '%', places: 1 },
      {
        type: 'buttons',
        buttons: [
          {
            label: 'Напечатать пробный лист',
            run: function () {
              PP.app.printCalibration();
            },
          },
          {
            label: 'Сбросить калибровку',
            run: function (ctx) {
              ctx.set('calibX', 100, { label: 'calib' });
              ctx.set('calibY', 100, { label: 'calib' });
            },
          },
        ],
      },
    ];
  }

  /* ------------------------------------------------------- custom controls */

  function formatChooser(ctx) {
    var search = el('input', { type: 'text', placeholder: 'Найти формат…' });
    var list = el('div', { class: 'format-list' });
    var node = el('div', {}, [el('div', { class: 'field' }, [search]), list]);
    var buttons = [];

    function paint() {
      list.innerHTML = '';
      buttons = [];
      var query = search.value.trim().toLowerCase();
      PP.formats.GROUPS.forEach(function (group) {
        if (group.id === 'custom') return;
        var entries = PP.formats.group(group.id).filter(function (format) {
          if (!query) return true;
          return (
            format.name.toLowerCase().indexOf(query) >= 0 ||
            PP.units.sizeLabel(format.w, format.h).indexOf(query) >= 0
          );
        });
        if (!entries.length) return;
        list.appendChild(el('div', { class: 'format-group', text: group.name }));
        entries.forEach(function (format) {
          var ratio = format.h / format.w;
          var swatch = el('span', {
            class: 'swatch',
            style: 'height:' + Math.min(26, Math.max(9, 15 * ratio)) + 'px',
          });
          var button = el('button', { class: 'format-item', type: 'button' }, [
            swatch,
            el('span', { class: 'fname', text: format.name }),
            el('span', { class: 'fsize', text: PP.units.sizeLabel(format.w, format.h) }),
          ]);
          button.title = format.note || '';
          button.addEventListener('click', function () {
            chooseFormat(format.id);
          });
          buttons.push({ button: button, id: format.id });
          list.appendChild(button);
        });
      });
      sync();
    }

    function sync() {
      var current = ctx.get('formatId');
      buttons.forEach(function (entry) {
        entry.button.classList.toggle('on', entry.id === current);
      });
    }

    search.addEventListener('input', paint);
    paint();
    return { node: node, sync: sync };
  }

  function framePresets(ctx) {
    var wrap = el('div', { class: 'chips' });
    PP.formats.FRAME_PRESETS.forEach(function (preset) {
      wrap.appendChild(
        el('button', {
          type: 'button',
          onclick: function () {
            applyFramePreset(preset.id);
          },
        }, [preset.name]),
      );
    });
    return { node: el('div', { class: 'field' }, [wrap]), sync: function () {} };
  }

  var presetThumbSource = null;

  function colorPresets(ctx) {
    var grid = el('div', { class: 'preset-grid' });
    var cells = [];

    PP.adjust.PRESETS.forEach(function (preset) {
      var canvas = el('canvas', { width: 78, height: 44 });
      var button = el('button', { class: 'preset', type: 'button', title: preset.name }, [
        canvas,
        el('span', { text: preset.name }),
      ]);
      button.addEventListener('click', function () {
        var targets = PP.store.targets();
        if (!targets.length) return;
        PP.store.update(
          function () {
            targets.forEach(function (item) {
              PP.adjust.applyPreset(item.adj, preset.id);
            });
          },
          { label: 'preset:' + preset.id },
        );
      });
      cells.push({ button: button, canvas: canvas, preset: preset });
      grid.appendChild(button);
    });

    function paintThumbs() {
      var item = PP.store.subject();
      var photo = item ? PP.store.photo(item.photoId) : null;
      var source = photo ? PP.imaging.source(photo.id, 200) : null;
      if (source === presetThumbSource && presetThumbSource) return;
      presetThumbSource = source;

      cells.forEach(function (cell) {
        var ctx2 = cell.canvas.getContext('2d', { willReadFrequently: true });
        ctx2.clearRect(0, 0, cell.canvas.width, cell.canvas.height);
        if (source) {
          var sw = source.width || source.naturalWidth;
          var sh = source.height || source.naturalHeight;
          var scale = Math.max(cell.canvas.width / sw, cell.canvas.height / sh);
          ctx2.drawImage(
            source,
            (cell.canvas.width - sw * scale) / 2,
            (cell.canvas.height - sh * scale) / 2,
            sw * scale,
            sh * scale,
          );
        } else {
          var gradient = ctx2.createLinearGradient(0, 0, 78, 44);
          gradient.addColorStop(0, '#8a6b4a');
          gradient.addColorStop(0.5, '#cfa87c');
          gradient.addColorStop(1, '#3d4a63');
          ctx2.fillStyle = gradient;
          ctx2.fillRect(0, 0, 78, 44);
        }
        var adj = PP.adjust.applyPreset({}, cell.preset.id);
        if (!PP.adjust.isNeutral(adj)) PP.adjust.apply(cell.canvas, adj, { scale: 0.2 });
      });
    }

    function sync() {
      paintThumbs();
      var current = ctx.get('adj.preset');
      cells.forEach(function (cell) {
        cell.button.classList.toggle('on', cell.preset.id === current);
      });
    }

    return { node: el('div', {}, [grid]), sync: sync };
  }

  function readout() {
    var node = el('dl', { class: 'readout' });
    function sync() {
      var item = PP.store.subject();
      node.innerHTML = '';
      if (!item) return;
      var photo = PP.store.photo(item.photoId);
      var card = PP.formats.cardSize(item);
      var win = PP.formats.windowRect(item);
      var dpi = photo ? PP.render.itemDpi(item, photo) : 0;
      var verdict = PP.units.dpiVerdict(dpi);

      function row(label, value, cls) {
        node.appendChild(el('dt', { text: label }));
        node.appendChild(el('dd', { class: cls || '', text: value }));
      }

      row('Карточка', PP.units.sizeLabel(card.w, card.h));
      row('Окно', PP.units.sizeLabel(win.w, win.h));
      if (photo) {
        row('Снимок', photo.w + ' × ' + photo.h + ' пикс');
        row(
          'На печати',
          dpi ? Math.round(dpi) + ' dpi' : '—',
          verdict,
        );
        if (photo.bytes) row('Файл', PP.units.formatBytes(photo.bytes));
        if (photo.camera) row('Камера', photo.camera);
        if (photo.date) row('Снято', new Date(photo.date).toLocaleDateString('ru-RU'));
      }
      return node;
    }
    return { node: node, sync: sync };
  }

  /* ------------------------------------------------------------- operations */

  /** What the film itself says the margins are, for a slider left on automatic. */
  function filmGeometry(which) {
    var item = PP.store.subject();
    if (!item) return null;
    var win = PP.formats.windowRect(item);
    return win[which] == null ? null : PP.units.round(win[which], 1);
  }

  function chooseFormat(formatId) {
    var targets = PP.store.targets();
    if (!targets.length) {
      // Nothing selected yet: remember it for the next photographs.
      PP.store.update(function (doc) {
        doc.defaults.formatId = formatId;
        doc.defaults.orient = PP.formats.naturalOrient(formatId, doc.defaults.custom);
        if (PP.formats.isFilm(formatId)) {
          doc.defaults.frame.style = 'classic';
          doc.defaults.frame.side = null;
          doc.defaults.frame.bottom = null;
        }
      });
      PP.ui.toast('Формат запомнен для новых фото');
      return;
    }
    PP.store.update(
      function () {
        targets.forEach(function (item) {
          item.formatId = formatId;
          if (PP.formats.isFilm(formatId)) {
            // Film is a physical object: a 600 card is portrait and that is that.
            item.orient = PP.formats.naturalOrient(formatId, item.custom);
            item.frame.style = 'classic';
            item.frame.side = null;
            item.frame.bottom = null;
          } else {
            // A paper size has no opinion, so follow the photograph.
            var photo = PP.store.photo(item.photoId);
            item.orient = photo
              ? photo.w > photo.h
                ? 'landscape'
                : 'portrait'
              : PP.formats.naturalOrient(formatId, item.custom);
          }
        });
        var focus = PP.store.subject();
        if (focus) PP.store.rememberDefaults(focus);
      },
      { label: 'format:' + formatId },
    );
  }

  function applyFramePreset(presetId) {
    var preset = PP.formats.framePreset(presetId);
    if (!preset) return;
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(
      function () {
        targets.forEach(function (item) {
          Object.keys(preset.frame).forEach(function (key) {
            item.frame[key] = preset.frame[key];
          });
          if (preset.frame.style === 'classic') {
            item.frame.side = null;
            item.frame.bottom = null;
          }
        });
        var focus = PP.store.subject();
        if (focus) PP.store.rememberDefaults(focus);
      },
      { label: 'frame:' + presetId },
    );
  }

  function orientByPhoto() {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(function () {
      targets.forEach(function (item) {
        var photo = PP.store.photo(item.photoId);
        if (!photo) return;
        item.orient = photo.w > photo.h ? 'landscape' : 'portrait';
      });
    });
  }

  function rotateBy(delta) {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(function () {
      targets.forEach(function (item) {
        var next = ((item.angle || 0) + delta) % 360;
        if (next > 180) next -= 360;
        if (next < -180) next += 360;
        item.angle = next;
      });
    });
  }

  function flip(ctx, key) {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(function () {
      targets.forEach(function (item) {
        item[key] = !item[key];
      });
    });
  }

  function resetPan() {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(function () {
      targets.forEach(function (item) {
        item.ox = 0;
        item.oy = 0;
        item.zoom = 1;
      });
    });
  }

  function fillCaption(make) {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(function () {
      targets.forEach(function (item) {
        var photo = PP.store.photo(item.photoId);
        if (photo) item.text.caption = make(photo);
      });
    });
  }

  function stampAll(pattern) {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(function () {
      targets.forEach(function (item) {
        var photo = PP.store.photo(item.photoId);
        item.text.stamp = true;
        item.text.stampText = PP.render.stampFor(photo, pattern);
      });
    });
  }

  /* ------------------------------------------------------------- rendering */

  var PANELS = {
    format: formatPanel,
    frame: framePanel,
    color: colorPanel,
    text: textPanel,
    page: pagePanel,
    out: outPanel,
  };

  function mount() {
    var tabsHost = PP.ui.$('tabs');
    tabsHost.innerHTML = '';
    TABS.forEach(function (tab) {
      var button = el('button', { type: 'button', 'data-tab': tab.id }, [tab.name]);
      button.addEventListener('click', function () {
        PP.store.ui(function (ui) {
          ui.tab = tab.id;
        }, 'tab');
      });
      tabsHost.appendChild(button);
    });
    render();
  }

  function render() {
    var ui = PP.store.state.ui;
    var tabsHost = PP.ui.$('tabs');
    Array.prototype.forEach.call(tabsHost.children, function (button) {
      button.classList.toggle('on', button.getAttribute('data-tab') === ui.tab);
    });

    var host = PP.ui.$('panels');
    var tab = TABS.filter(function (t) {
      return t.id === ui.tab;
    })[0] || TABS[0];

    if (built.tab !== tab.id) {
      host.innerHTML = '';
      built.controls = [];
      built.tab = tab.id;

      var ctx =
        tab.id === 'page' ? docCtx('page') : tab.id === 'out' ? docCtx('output') : itemCtx();

      if (tab.scope === 'item') {
        built.head = el('div', { class: 'empty-note' });
        host.appendChild(built.head);
      } else {
        built.head = null;
      }

      var list = PANELS[tab.id]();
      var wrap = el('div');
      list.forEach(function (spec) {
        var control = fields.build(spec, ctx);
        built.controls.push(control);
        wrap.appendChild(control.node);
      });
      host.appendChild(wrap);
      built.body = wrap;
    }

    var focus = PP.store.subject();
    if (built.head) {
      var count = PP.store.targets().length;
      var hasItems = PP.store.state.doc.items.length > 0;
      if (!focus && !PP.store.state.ui.applyToAll) {
        built.head.textContent = hasItems
          ? 'Выберите кадр слева или на листе — настройки применятся к нему.'
          : 'Добавьте фотографии, и здесь появятся настройки кадра.';
        built.head.hidden = false;
        built.body.style.opacity = hasItems ? '0.35' : '0.35';
        built.body.style.pointerEvents = 'none';
      } else {
        built.head.hidden = true;
        built.body.style.opacity = '1';
        built.body.style.pointerEvents = 'auto';
        if (count > 1) {
          built.head.hidden = false;
          built.head.textContent =
            'Правим ' + count + ' ' + PP.units.plural(count, 'кадр', 'кадра', 'кадров') + ' сразу';
          built.head.style.padding = '8px 4px';
        } else {
          built.head.style.padding = '';
        }
      }
    }

    built.controls.forEach(function (control) {
      control.sync();
    });
  }

  PP.ui.inspector = { mount: mount, render: render, chooseFormat: chooseFormat };
})((window.PP = window.PP || {}));
