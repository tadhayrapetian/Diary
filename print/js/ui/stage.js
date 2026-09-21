/* Отпечаток — the middle of the room.
 *
 * Two views over the same document: the sheets as they will come out of the
 * printer, and one card on its own, big enough to place the photograph inside
 * its window by hand. Both are the same renderer at a different scale, so
 * nothing can look right here and wrong on paper.
 */
(function (PP) {
  'use strict';

  var el = PP.ui.el;
  var lastPlan = null;
  var sheetNodes = [];
  var editorState = { canvas: null, wrap: null, itemId: null };

  function mount() {
    var scroll = PP.ui.$('stage-scroll');

    PP.ui.$('zoom-range').addEventListener('input', function (event) {
      setZoom(parseInt(event.target.value, 10) / 100, false);
    });
    PP.ui.$('zoom-in').addEventListener('click', function () {
      setZoom(PP.store.state.ui.zoom * 1.18, false);
    });
    PP.ui.$('zoom-out').addEventListener('click', function () {
      setZoom(PP.store.state.ui.zoom / 1.18, false);
    });
    PP.ui.$('zoom-fit').addEventListener('click', fitToWindow);

    // Ctrl+wheel zooms, like every other program with a canvas in it.
    scroll.addEventListener(
      'wheel',
      function (event) {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        setZoom(PP.store.state.ui.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08), false);
      },
      { passive: false },
    );

    PP.ui.$('sheets').addEventListener('click', function (event) {
      var hit = event.target.closest('.hit');
      if (!hit) return;
      PP.ui.library.select(hit.getAttribute('data-id'), event);
    });
    PP.ui.$('sheets').addEventListener('dblclick', function (event) {
      var hit = event.target.closest('.hit');
      if (!hit) return;
      PP.store.ui(function (ui) {
        ui.mode = 'editor';
      }, 'mode');
    });

    window.addEventListener('resize', function () {
      if (PP.store.state.ui.fitZoom) fitToWindow();
    });
  }

  function setZoom(value, keepFit) {
    var zoom = PP.units.clamp(value, 0.15, 2.2);
    PP.store.ui(function (ui) {
      ui.zoom = zoom;
      if (!keepFit) ui.fitZoom = false;
    }, 'zoom');
  }

  function fitToWindow() {
    var plan = lastPlan;
    if (!plan || !plan.paper) return;
    var scroll = PP.ui.$('stage-scroll');
    var availW = scroll.clientWidth - 56;
    var availH = scroll.clientHeight - 56;
    var perMm = 96 / PP.units.MM_PER_INCH;
    var zoom = Math.min(availW / (plan.paper.w * perMm), availH / (plan.paper.h * perMm));
    PP.store.ui(function (ui) {
      ui.zoom = PP.units.clamp(zoom, 0.15, 2.2);
      ui.fitZoom = true;
    }, 'zoom');
  }

  /* -------------------------------------------------------------- the sheets */

  function render() {
    var ui = PP.store.state.ui;
    var doc = PP.store.state.doc;
    var layoutMode = ui.mode === 'layout';

    PP.ui.$('sheets').hidden = !layoutMode;
    PP.ui.$('editor').hidden = layoutMode;
    PP.ui.$('stage-empty').hidden = doc.items.length > 0;

    PP.ui.$('zoom-range').value = Math.round(ui.zoom * 100);
    PP.ui.$('zoom-label').textContent = Math.round(ui.zoom * 100) + '%';
    PP.ui.$('zoom-fit').classList.toggle('on', ui.fitZoom);

    if (layoutMode) renderSheets();
    else renderEditor();

    renderInfo();
  }

  function renderSheets() {
    var doc = PP.store.state.doc;
    var ui = PP.store.state.ui;
    var host = PP.ui.$('sheets');
    var plan = PP.layout.build(doc);
    lastPlan = plan;

    if (!plan.pages.length) {
      host.innerHTML = '';
      sheetNodes = [];
      return;
    }

    var scale = PP.units.screenScale(ui.zoom);
    var pxW = Math.round(plan.paper.w * scale);
    var pxH = Math.round(plan.paper.h * scale);

    while (sheetNodes.length > plan.pages.length) {
      var dead = sheetNodes.pop();
      if (dead.wrap.parentNode) dead.wrap.parentNode.removeChild(dead.wrap);
    }
    while (sheetNodes.length < plan.pages.length) {
      var canvas = el('canvas', { class: 'sheet' });
      var hits = el('div', { class: 'sheet-hit' });
      var label = el('div', { class: 'sheet-label' });
      var wrap = el('div', { class: 'sheet-wrap' }, [label, canvas, hits]);
      host.appendChild(wrap);
      sheetNodes.push({ wrap: wrap, canvas: canvas, hits: hits, label: label });
    }

    plan.pages.forEach(function (placed, index) {
      var node = sheetNodes[index];
      node.canvas.width = pxW;
      node.canvas.height = pxH;
      node.canvas.style.width = pxW + 'px';
      node.canvas.style.height = pxH + 'px';

      var ctx = node.canvas.getContext('2d');
      ctx.clearRect(0, 0, pxW, pxH);
      PP.sheet.drawSheet(ctx, placed, plan, doc, scale, {
        print: false,
        pageNumber: index + 1,
        pageCount: plan.pages.length,
        shadow: false,
      });

      node.label.innerHTML = '';
      node.label.appendChild(
        el('span', {
          html:
            'Лист <b>' +
            (index + 1) +
            '</b> из <b>' +
            plan.pages.length +
            '</b> · ' +
            PP.units.sizeLabel(plan.paper.w, plan.paper.h) +
            ' · заполнено ' +
            Math.round(PP.layout.coverage(placed, plan.sheet) * 100) +
            '%',
        }),
      );

      node.hits.innerHTML = '';
      placed.forEach(function (card) {
        var selected = ui.selected.indexOf(card.item.id) >= 0;
        node.hits.appendChild(
          el('div', {
            class: 'hit' + (selected ? ' sel' : ''),
            'data-id': card.item.id,
            style:
              'left:' +
              card.x * scale +
              'px;top:' +
              card.y * scale +
              'px;width:' +
              card.w * scale +
              'px;height:' +
              card.h * scale +
              'px',
          }),
        );
      });
    });
  }

  /* -------------------------------------------------------------- the card */

  function renderEditor() {
    var host = PP.ui.$('editor');
    var item = PP.store.subject();

    if (!item) {
      host.innerHTML = '';
      host.appendChild(
        el('div', {
          class: 'empty-note',
          text: 'Выберите кадр в библиотеке — и его можно будет двигать в рамке.',
        }),
      );
      editorState.itemId = null;
      return;
    }

    var photo = PP.store.photo(item.photoId);
    var card = PP.formats.cardSize(item);
    var scroll = PP.ui.$('stage-scroll');
    var availW = Math.max(240, scroll.clientWidth - 90);
    var availH = Math.max(240, scroll.clientHeight - 150);
    var scale = Math.min(availW / card.w, availH / card.h);

    if (editorState.itemId !== item.id || !editorState.canvas) {
      host.innerHTML = '';
      var canvas = el('canvas');
      var grid = el('div', { class: 'editor-grid' });
      var wrap = el('div', { class: 'editor-card' }, [canvas, grid]);
      var hint = el('div', {
        class: 'editor-hint',
        text: 'Тяните мышью, чтобы двигать снимок в окне · колесо — приближение · стрелки — по чуть-чуть',
      });
      var strip = el('div', { class: 'editor-strip' }, [
        button('Заполнить окно', function () {
          patch({ fit: 'cover' });
        }),
        button('Вписать целиком', function () {
          patch({ fit: 'contain' });
        }),
        button('⟲ 90°', function () {
          patch({ angle: normalizeAngle(angleOf() - 90) });
        }),
        button('⟳ 90°', function () {
          patch({ angle: normalizeAngle(angleOf() + 90) });
        }),
        button('В центр', function () {
          patch({ ox: 0, oy: 0, zoom: 1 });
        }),
      ]);
      host.appendChild(wrap);
      host.appendChild(strip);
      host.appendChild(hint);
      bindEditorGestures(wrap);
      editorState = { canvas: canvas, wrap: wrap, itemId: item.id };
    }

    var pxW = Math.round(card.w * scale);
    var pxH = Math.round(card.h * scale);
    editorState.canvas.width = pxW;
    editorState.canvas.height = pxH;
    editorState.canvas.style.width = pxW + 'px';
    editorState.canvas.style.height = pxH + 'px';
    editorState.wrap.style.width = pxW + 'px';
    editorState.wrap.style.height = pxH + 'px';
    editorState.scale = scale;

    var ctx = editorState.canvas.getContext('2d');
    ctx.clearRect(0, 0, pxW, pxH);
    PP.render.drawCard(ctx, item, photo, scale, { output: PP.store.state.doc.output });
  }

  function button(label, run) {
    return el('button', { class: 'mini', type: 'button', onclick: run }, [label]);
  }

  function angleOf() {
    var item = PP.store.subject();
    return item ? item.angle || 0 : 0;
  }

  function normalizeAngle(value) {
    var next = value % 360;
    if (next > 180) next -= 360;
    if (next < -180) next += 360;
    return next;
  }

  function patch(changes, label) {
    var targets = PP.store.targets();
    if (!targets.length) return;
    PP.store.update(
      function () {
        targets.forEach(function (item) {
          Object.keys(changes).forEach(function (key) {
            item[key] = changes[key];
          });
        });
      },
      { label: label || 'editor:' + Object.keys(changes).join(',') },
    );
  }

  function bindEditorGestures(wrap) {
    var dragging = null;

    wrap.addEventListener('pointerdown', function (event) {
      var item = PP.store.subject();
      if (!item) return;
      var photo = PP.store.photo(item.photoId);
      if (!photo) return;
      var place = PP.render.placement(item, photo);
      dragging = {
        x: event.clientX,
        y: event.clientY,
        ox: item.ox || 0,
        oy: item.oy || 0,
        slackX: place.slackX,
        slackY: place.slackY,
      };
      wrap.classList.add('dragging');
      wrap.setPointerCapture(event.pointerId);
    });

    wrap.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var scale = editorState.scale || 1;
      var dxMm = (event.clientX - dragging.x) / scale;
      var dyMm = (event.clientY - dragging.y) / scale;
      var next = {};
      if (dragging.slackX > 0.01) {
        next.ox = PP.units.clamp(dragging.ox + dxMm / dragging.slackX, -1, 1);
      }
      if (dragging.slackY > 0.01) {
        next.oy = PP.units.clamp(dragging.oy + dyMm / dragging.slackY, -1, 1);
      }
      if (Object.keys(next).length) patch(next, 'editor:pan');
    });

    function stop() {
      dragging = null;
      wrap.classList.remove('dragging');
    }
    wrap.addEventListener('pointerup', stop);
    wrap.addEventListener('pointercancel', stop);

    wrap.addEventListener(
      'wheel',
      function (event) {
        var item = PP.store.subject();
        if (!item) return;
        event.preventDefault();
        var factor = event.deltaY < 0 ? 1.06 : 1 / 1.06;
        patch({ zoom: PP.units.clamp((item.zoom || 1) * factor, 0.2, 6) }, 'editor:zoom');
      },
      { passive: false },
    );
  }

  /* -------------------------------------------------------------- the news */

  function renderInfo() {
    var doc = PP.store.state.doc;
    var info = PP.ui.$('stage-info');
    var plan = lastPlan;
    info.innerHTML = '';

    if (!doc.items.length) {
      PP.ui.$('status-main').textContent = 'Готово к работе';
      PP.ui.$('status-warn').textContent = '';
      PP.ui.$('status-dpi').textContent = '';
      return;
    }

    var cards = plan ? plan.cardCount : 0;
    var pages = plan ? plan.pages.length : 0;
    info.appendChild(
      el('span', {
        text:
          cards + ' ' + PP.units.plural(cards, 'карточка', 'карточки', 'карточек') +
          ' · ' +
          pages + ' ' + PP.units.plural(pages, 'лист', 'листа', 'листов'),
      }),
    );
    if (plan && plan.pages.length) {
      var total = plan.pages.reduce(function (sum, placed) {
        return sum + PP.layout.coverage(placed, plan.sheet);
      }, 0);
      info.appendChild(
        el('span', { text: 'бумага занята на ' + Math.round((total / plan.pages.length) * 100) + '%' }),
      );
    }

    var worst = null;
    doc.items.forEach(function (item) {
      var photo = PP.store.photo(item.photoId);
      if (!photo) return;
      var dpi = PP.render.itemDpi(item, photo);
      if (worst === null || dpi < worst) worst = dpi;
    });

    PP.ui.$('status-main').textContent =
      doc.items.length + ' ' + PP.units.plural(doc.items.length, 'кадр', 'кадра', 'кадров') +
      ' · ' + doc.output.dpi + ' dpi';

    if (worst !== null) {
      PP.ui.$('status-dpi').textContent = 'худшее качество: ' + Math.round(worst) + ' dpi';
    }

    var warnings = [];
    if (plan && plan.overflow && plan.overflow.length) {
      warnings.push(plan.overflow.length + ' не помещается на лист');
    }
    if (worst !== null && worst < 150) {
      warnings.push('есть кадры ниже 150 dpi — на бумаге будет видно');
    }
    PP.ui.$('status-warn').textContent = warnings.join(' · ');
  }

  PP.ui.stage = {
    mount: mount,
    render: render,
    fitToWindow: fitToWindow,
    setZoom: setZoom,
    plan: function () {
      return lastPlan;
    },
  };
})((window.PP = window.PP || {}));
