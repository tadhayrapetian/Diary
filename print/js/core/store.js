/* Отпечаток — the document and its history.
 *
 * One object holds everything that would go into a saved project; everything
 * that is merely how the program looks right now lives beside it in `ui` and is
 * never undone. Photographs are split in two: the description (id, name, pixel
 * size, date) belongs to the document and is snapshotted, while the decoded
 * image itself sits in `PP.assets` and is never copied, because copying a
 * hundred megabytes on every slider drag is how a program becomes slow.
 */
(function (PP) {
  'use strict';

  var LS_KEY = 'otpechatok.settings.v1';

  var listeners = [];
  var history = [];
  var future = [];
  var lastLabel = null;
  var lastStamp = 0;
  var HISTORY_LIMIT = 60;

  function defaultItem() {
    return {
      id: '',
      photoId: '',
      copies: 1,
      formatId: 'pol-600',
      custom: { w: 100, h: 150 },
      orient: 'portrait',
      fit: 'cover',
      zoom: 1,
      ox: 0,
      oy: 0,
      angle: 0,
      flipH: false,
      flipV: false,
      frame: {
        style: 'classic',
        color: '#fdfdfb',
        border: 6,
        side: null, // null = take it from the film
        bottom: null,
        radius: 1.6,
        line: 0,
        lineColor: '#cfcabb',
        shadow: true, // screen only; never printed
      },
      adj: {
        preset: 'none',
        exposure: 0,
        contrast: 0,
        saturation: 0,
        temp: 0,
        tint: 0,
        highlights: 0,
        shadows: 0,
        clarity: 0,
        fade: 0,
        vignette: 0,
        grain: 0,
        blur: 0,
        mono: 0,
        sepia: 0,
        rotateHue: 0,
      },
      text: {
        caption: '',
        font: 'hand',
        size: 5,
        color: '#2b2b33',
        align: 'center',
        offset: 0,
        stamp: false,
        stampText: '',
        stampColor: '#ff8f2e',
        stampSize: 3.2,
      },
    };
  }

  function defaultPage() {
    return {
      paperId: 'a4',
      paperCustom: { w: 210, h: 297 },
      orient: 'portrait',
      margin: 6,
      borderless: false,
      gap: 4,
      mode: 'grid', // grid | pack | single | fill | contact
      align: 'center', // center | topleft
      autoRotate: true,
      cutMarks: false,
      cutLines: false,
      showNames: false,
      pageNumbers: false,
      contactCols: 5,
      fillCount: 0, // 0 = as many as fit
      background: '#ffffff',
      paperTint: false,
    };
  }

  function defaultOutput() {
    return {
      dpi: 300,
      quality: 0.94,
      format: 'jpeg',
      calibX: 100,
      calibY: 100,
      inkSaver: false,
      proofMono: false,
    };
  }

  var state = {
    doc: {
      version: 1,
      title: 'Без названия',
      photos: [],
      items: [],
      page: defaultPage(),
      output: defaultOutput(),
      defaults: defaultItem(),
    },
    ui: {
      mode: 'layout',
      tab: 'format',
      selected: [],
      pageIndex: 0,
      zoom: 0.62,
      fitZoom: true,
      unit: 'mm',
      inspectorOpen: true,
      libraryOpen: true,
      applyToAll: false,
      busy: false,
    },
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix) {
    return (
      (prefix || 'id') +
      '-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 7)
    );
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  var pending = null;
  function emit(reason) {
    // Coalesce a burst of changes into one repaint.
    if (pending) {
      pending.reasons[reason || 'change'] = true;
      return;
    }
    pending = { reasons: {} };
    pending.reasons[reason || 'change'] = true;
    requestAnimationFrame(function () {
      var reasons = pending.reasons;
      pending = null;
      listeners.forEach(function (fn) {
        try {
          fn(state, reasons);
        } catch (error) {
          console.error('[отпечаток] слушатель упал:', error);
        }
      });
    });
  }

  /**
   * Change the document.
   *
   * `label` groups rapid edits of the same thing — dragging one slider is one
   * step back, not forty. Pass `history: false` for changes nobody would want to
   * undo (page scroll, selection).
   */
  function update(mutate, options) {
    var opts = options || {};
    var label = opts.label || null;
    var now = Date.now();

    if (opts.history !== false) {
      var coalesce =
        label && label === lastLabel && now - lastStamp < 700 && history.length;
      if (!coalesce) {
        history.push(clone(state.doc));
        if (history.length > HISTORY_LIMIT) history.shift();
        future.length = 0;
      }
      lastLabel = label;
      lastStamp = now;
    }

    mutate(state.doc, state.ui);
    if (opts.persist !== false) persist();
    emit(opts.reason || 'doc');
  }

  /** UI-only change: no snapshot, no persistence of the document. */
  function ui(mutate, reason) {
    mutate(state.ui, state.doc);
    emit(reason || 'ui');
  }

  function undo() {
    if (!history.length) return false;
    future.push(clone(state.doc));
    state.doc = history.pop();
    lastLabel = null;
    pruneSelection();
    emit('history');
    return true;
  }

  function redo() {
    if (!future.length) return false;
    history.push(clone(state.doc));
    state.doc = future.pop();
    lastLabel = null;
    pruneSelection();
    emit('history');
    return true;
  }

  function canUndo() {
    return history.length > 0;
  }

  function canRedo() {
    return future.length > 0;
  }

  function pruneSelection() {
    var alive = {};
    state.doc.items.forEach(function (item) {
      alive[item.id] = true;
    });
    state.ui.selected = state.ui.selected.filter(function (id) {
      return alive[id];
    });
  }

  // ------------------------------------------------------------------ lookups

  function item(id) {
    for (var i = 0; i < state.doc.items.length; i++) {
      if (state.doc.items[i].id === id) return state.doc.items[i];
    }
    return null;
  }

  function photo(id) {
    for (var i = 0; i < state.doc.photos.length; i++) {
      if (state.doc.photos[i].id === id) return state.doc.photos[i];
    }
    return null;
  }

  function selectedItems() {
    var out = [];
    state.ui.selected.forEach(function (id) {
      var found = item(id);
      if (found) out.push(found);
    });
    return out;
  }

  /** The item the inspector talks about: the last one selected. */
  function focused() {
    var list = selectedItems();
    return list.length ? list[list.length - 1] : null;
  }

  /**
   * The item whose numbers the controls show. Normally the focused one; with
   * "change all at once" on and nothing picked, the first card stands in for the
   * whole set, so the panel shows real values instead of going blank.
   */
  function subject() {
    var item = focused();
    if (item) return item;
    if (state.ui.applyToAll && state.doc.items.length) return state.doc.items[0];
    return null;
  }

  /** Items an edit should touch — the selection, or everything when told. */
  function targets() {
    if (state.ui.applyToAll) return state.doc.items.slice();
    var list = selectedItems();
    return list.length ? list : [];
  }

  function makeItem(photoId, overrides) {
    var base = clone(state.doc.defaults);
    base.id = uid('it');
    base.photoId = photoId;
    if (overrides) Object.keys(overrides).forEach(function (k) {
      base[k] = overrides[k];
    });
    return base;
  }

  /** New photos remember how you set up the last one. */
  function rememberDefaults(from) {
    var d = clone(from);
    d.id = '';
    d.photoId = '';
    d.copies = 1;
    d.zoom = 1;
    d.ox = 0;
    d.oy = 0;
    d.angle = 0;
    d.text = clone(from.text);
    d.text.caption = '';
    state.doc.defaults = d;
  }

  // ------------------------------------------------------------------ storage

  function persist() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          page: state.doc.page,
          output: state.doc.output,
          defaults: state.doc.defaults,
          unit: state.ui.unit,
        }),
      );
    } catch (error) {
      /* private window, quota, or a browser that simply says no */
    }
  }

  function restore() {
    var raw;
    try {
      raw = localStorage.getItem(LS_KEY);
    } catch (error) {
      return;
    }
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      if (saved.page) state.doc.page = merge(defaultPage(), saved.page);
      if (saved.output) state.doc.output = merge(defaultOutput(), saved.output);
      if (saved.defaults) state.doc.defaults = merge(defaultItem(), saved.defaults);
      if (saved.unit) state.ui.unit = saved.unit;
    } catch (error) {
      /* a corrupt entry is not worth a crash */
    }
  }

  /** Shallow-deep merge that keeps new fields when the saved copy is older. */
  function merge(base, saved) {
    Object.keys(saved).forEach(function (key) {
      var value = saved[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && base[key]) {
        merge(base[key], value);
      } else if (value !== undefined) {
        base[key] = value;
      }
    });
    return base;
  }

  function resetDocument() {
    history.push(clone(state.doc));
    state.doc.photos = [];
    state.doc.items = [];
    state.doc.title = 'Без названия';
    state.ui.selected = [];
    state.ui.pageIndex = 0;
    emit('doc');
  }

  PP.store = {
    state: state,
    subscribe: subscribe,
    emit: emit,
    update: update,
    ui: ui,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    item: item,
    photo: photo,
    selectedItems: selectedItems,
    focused: focused,
    subject: subject,
    targets: targets,
    makeItem: makeItem,
    rememberDefaults: rememberDefaults,
    defaultItem: defaultItem,
    defaultPage: defaultPage,
    defaultOutput: defaultOutput,
    clone: clone,
    uid: uid,
    merge: merge,
    restore: restore,
    persist: persist,
    resetDocument: resetDocument,
    pruneSelection: pruneSelection,
  };
})((window.PP = window.PP || {}));
