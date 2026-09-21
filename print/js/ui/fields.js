/* Отпечаток — controls, built from a description rather than from HTML.
 *
 * Every panel in the inspector is a list of plain objects; this file turns one
 * into a control that reads and writes through the document. Adding a slider
 * anywhere in the program is one line in a list, which is the only way a program
 * with this many knobs stays maintainable.
 *
 * A control is built once and then only refreshed, so dragging a slider is never
 * interrupted by the interface rebuilding itself underneath your finger.
 */
(function (PP) {
  'use strict';

  var el = PP.ui.el;

  function getPath(object, path) {
    var parts = path.split('.');
    var node = object;
    for (var i = 0; i < parts.length && node != null; i++) node = node[parts[i]];
    return node;
  }

  function setPath(object, path, value) {
    var parts = path.split('.');
    var node = object;
    for (var i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }

  function fmt(value, spec) {
    if (typeof value !== 'number') return String(value == null ? '' : value);
    var rounded = PP.units.round(value, spec.places == null ? 1 : spec.places);
    var sign = spec.sign && rounded > 0 ? '+' : '';
    return sign + rounded + (spec.unit ? ' ' + spec.unit : '');
  }

  /**
   * @param spec  the control description
   * @param ctx   { get(path), set(path, value, opts), isDefault(path) }
   */
  function build(spec, ctx) {
    switch (spec.type) {
      case 'group':
        return { node: el('div', { class: 'group', text: spec.label }), sync: noop };
      case 'note':
        return { node: el('p', { class: 'note', html: spec.text }), sync: noop };
      case 'range':
        return rangeField(spec, ctx);
      case 'number':
        return numberField(spec, ctx);
      case 'pair':
        return pairField(spec, ctx);
      case 'text':
        return textField(spec, ctx, false);
      case 'textarea':
        return textField(spec, ctx, true);
      case 'select':
        return selectField(spec, ctx);
      case 'color':
        return colorField(spec, ctx);
      case 'toggle':
        return toggleField(spec, ctx);
      case 'chips':
        return chipsField(spec, ctx);
      case 'buttons':
        return buttonsField(spec, ctx);
      case 'custom':
        return spec.build(ctx, spec);
      default:
        return { node: el('div'), sync: noop };
    }
  }

  function noop() {}

  function labelRow(spec, valueNode) {
    return el('div', { class: 'lab' }, [el('span', { text: spec.label }), valueNode]);
  }

  function rangeField(spec, ctx) {
    var value = el('span', { class: 'val', title: 'Потяните вбок, двойной щелчок — сброс' });
    var input = el('input', {
      type: 'range',
      min: spec.min,
      max: spec.max,
      step: spec.step == null ? 1 : spec.step,
    });
    var node = el('div', { class: 'field' }, [labelRow(spec, value), input]);

    function write(v, label) {
      ctx.set(spec.key, clampSpec(v, spec), { label: label || spec.key });
    }

    input.addEventListener('input', function () {
      write(parseFloat(input.value));
    });

    // The number itself is a scrub handle — finer than the track, and the way
    // every grown-up photo program does it.
    var scrubbing = null;
    value.addEventListener('pointerdown', function (event) {
      scrubbing = { x: event.clientX, start: parseFloat(input.value) || 0 };
      value.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    value.addEventListener('pointermove', function (event) {
      if (!scrubbing) return;
      var span = spec.max - spec.min;
      var delta = ((event.clientX - scrubbing.x) / 220) * span;
      var step = spec.step == null ? 1 : spec.step;
      var next = Math.round((scrubbing.start + delta) / step) * step;
      write(next);
    });
    value.addEventListener('pointerup', function () {
      scrubbing = null;
    });
    value.addEventListener('dblclick', function () {
      write(spec.default == null ? 0 : spec.default, spec.key + ':reset');
    });

    function sync() {
      var current = ctx.get(spec.key);
      // A null means "work it out from the film"; show what was worked out
      // rather than a placeholder, or the number on screen would be a lie.
      var automatic = current == null;
      if (automatic && spec.fallback) current = spec.fallback();
      if (current == null) current = spec.default == null ? 0 : spec.default;
      input.value = current;
      value.textContent = fmt(current, spec) + (automatic && spec.fallback ? ' ⟲' : '');
      value.title = automatic && spec.fallback
        ? 'Взято от плёнки. Потяните — станет вашим'
        : 'Потяните вбок, двойной щелчок — сброс';
      var base = spec.default == null ? 0 : spec.default;
      value.classList.toggle('changed', !automatic && Math.abs(current - base) > 0.0001);
    }

    return { node: node, sync: sync };
  }

  function clampSpec(v, spec) {
    var value = PP.units.clamp(v, spec.min, spec.max);
    return isNaN(value) ? spec.default || 0 : value;
  }

  function numberField(spec, ctx) {
    var input = el('input', {
      type: 'number',
      min: spec.min,
      max: spec.max,
      step: spec.step == null ? 1 : spec.step,
    });
    var node = el('div', { class: 'field' }, [
      labelRow(spec, el('span', { class: 'unit', text: spec.unit || '' })),
      input,
    ]);
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      if (isNaN(v)) return;
      ctx.set(spec.key, PP.units.clamp(v, spec.min, spec.max), { label: spec.key });
    });
    function sync() {
      if (document.activeElement === input) return;
      input.value = PP.units.round(ctx.get(spec.key) || 0, spec.places == null ? 1 : spec.places);
    }
    return { node: node, sync: sync };
  }

  /** Two numbers side by side — width and height, mostly. */
  function pairField(spec, ctx) {
    var a = el('input', { type: 'number', min: spec.min, max: spec.max, step: spec.step || 1 });
    var b = el('input', { type: 'number', min: spec.min, max: spec.max, step: spec.step || 1 });
    var node = el('div', {}, [
      labelRow(spec, el('span', { class: 'unit', text: spec.unit || '' })),
      el('div', { class: 'field row2' }, [a, b]),
    ]);
    function push(input, key) {
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        if (isNaN(v)) return;
        ctx.set(key, PP.units.clamp(v, spec.min, spec.max), { label: key });
      });
    }
    push(a, spec.keyA);
    push(b, spec.keyB);
    function sync() {
      if (document.activeElement !== a) a.value = PP.units.round(ctx.get(spec.keyA) || 0, 1);
      if (document.activeElement !== b) b.value = PP.units.round(ctx.get(spec.keyB) || 0, 1);
    }
    return { node: node, sync: sync };
  }

  function textField(spec, ctx, multiline) {
    var input = el(multiline ? 'textarea' : 'input', {
      type: multiline ? null : 'text',
      placeholder: spec.placeholder || '',
      rows: spec.rows || 2,
    });
    var node = el('div', { class: 'field' }, [
      spec.label ? labelRow(spec, el('span', {})) : null,
      input,
    ]);
    input.addEventListener('input', function () {
      ctx.set(spec.key, input.value, { label: spec.key });
    });
    function sync() {
      if (document.activeElement === input) return;
      input.value = ctx.get(spec.key) || '';
    }
    return { node: node, sync: sync };
  }

  function selectField(spec, ctx) {
    var select = el('select');
    var options = typeof spec.options === 'function' ? spec.options() : spec.options;
    options.forEach(function (option) {
      select.appendChild(
        el('option', { value: option.value }, [option.label]),
      );
    });
    var node = el('div', { class: 'field' }, [
      spec.label ? labelRow(spec, el('span', {})) : null,
      select,
    ]);
    select.addEventListener('change', function () {
      var value = select.value;
      if (spec.numeric) value = parseFloat(value);
      ctx.set(spec.key, value, { label: spec.key + ':pick' });
    });
    function sync() {
      var current = ctx.get(spec.key);
      select.value = current == null ? '' : String(current);
    }
    return { node: node, sync: sync };
  }

  function colorField(spec, ctx) {
    var input = el('input', { type: 'color' });
    var node = el('div', { class: 'field' }, [labelRow(spec, el('span', {})), input]);
    input.addEventListener('input', function () {
      ctx.set(spec.key, input.value, { label: spec.key });
    });
    function sync() {
      var value = ctx.get(spec.key) || '#ffffff';
      if (/^#[0-9a-f]{6}$/i.test(value)) input.value = value;
    }
    return { node: node, sync: sync };
  }

  function toggleField(spec, ctx) {
    var input = el('input', { type: 'checkbox' });
    var node = el('label', { class: 'toggle' }, [
      el('span', {}, [
        document.createTextNode(spec.label),
        spec.hint ? el('span', { class: 'hint', text: spec.hint }) : null,
      ]),
      input,
    ]);
    input.addEventListener('change', function () {
      ctx.set(spec.key, input.checked, { label: spec.key + ':toggle' });
    });
    function sync() {
      input.checked = Boolean(ctx.get(spec.key));
    }
    return { node: node, sync: sync };
  }

  function chipsField(spec, ctx) {
    var buttons = [];
    var wrap = el('div', { class: 'chips' });
    var options = typeof spec.options === 'function' ? spec.options() : spec.options;
    options.forEach(function (option) {
      var button = el('button', { type: 'button', title: option.hint || '' }, [option.label]);
      button.addEventListener('click', function () {
        ctx.set(spec.key, option.value, { label: spec.key + ':pick' });
      });
      buttons.push({ button: button, value: option.value });
      wrap.appendChild(button);
    });
    var node = el('div', { class: 'field' }, [
      spec.label ? labelRow(spec, el('span', {})) : null,
      wrap,
    ]);
    function sync() {
      var current = ctx.get(spec.key);
      buttons.forEach(function (entry) {
        entry.button.classList.toggle('on', entry.value === current);
      });
    }
    return { node: node, sync: sync };
  }

  function buttonsField(spec, ctx) {
    var wrap = el('div', { class: 'btn-row' });
    spec.buttons.forEach(function (button) {
      wrap.appendChild(
        el('button', {
          type: 'button',
          title: button.hint || '',
          onclick: function () {
            button.run(ctx);
          },
        }, [button.label]),
      );
    });
    return { node: wrap, sync: noop };
  }

  PP.ui.fields = {
    build: build,
    getPath: getPath,
    setPath: setPath,
    fmt: fmt,
  };
})((window.PP = window.PP || {}));
