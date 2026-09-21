/* Отпечаток — the keyboard.
 *
 * Anything you do more than twice should have a key. `?` prints the list.
 */
(function (PP) {
  'use strict';

  var el = PP.ui.el;

  var LIST = [
    ['A', 'добавить фотографии'],
    ['Ctrl + V', 'вставить фото из буфера'],
    ['Ctrl + A', 'выделить все кадры'],
    ['D', 'дубликат выделенного'],
    ['Delete', 'убрать выделенное'],
    ['E / L', 'кадр / лист'],
    ['[ и ]', 'повернуть на 90°'],
    ['стрелки', 'сдвинуть снимок в окне'],
    ['Shift + стрелки', 'сдвинуть заметно'],
    ['+ и −', 'масштаб предпросмотра'],
    ['0', 'вписать лист в окно'],
    ['1…6', 'вкладки справа'],
    ['Ctrl + Z', 'отменить'],
    ['Ctrl + Shift + Z', 'вернуть'],
    ['Ctrl + P', 'печать'],
    ['Ctrl + S', 'сохранить проект'],
    ['Ctrl + E', 'PDF'],
    ['?', 'этот список'],
  ];

  var TAB_KEYS = ['format', 'frame', 'color', 'text', 'page', 'out'];

  function typing(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function mount() {
    document.addEventListener('keydown', function (event) {
      var mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) PP.store.redo();
        else PP.store.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        PP.store.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        PP.app.print();
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        PP.app.saveProject(true);
        return;
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        PP.app.exportPdf();
        return;
      }
      if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        PP.ui.$('project-input').click();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a' && !typing(event.target)) {
        event.preventDefault();
        PP.ui.library.selectAll();
        return;
      }

      if (typing(event.target) || mod) return;

      switch (event.key) {
        case 'a':
        case 'A':
        case 'ф':
        case 'Ф':
          event.preventDefault();
          PP.ui.$('file-input').click();
          break;
        case 'd':
        case 'D':
        case 'в':
        case 'В':
          PP.ui.library.duplicate();
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          PP.ui.library.remove();
          break;
        case 'e':
        case 'E':
        case 'у':
        case 'У':
          PP.store.ui(function (ui) {
            ui.mode = 'editor';
          }, 'mode');
          break;
        case 'l':
        case 'L':
        case 'д':
        case 'Д':
          PP.store.ui(function (ui) {
            ui.mode = 'layout';
          }, 'mode');
          break;
        case '[':
          rotate(-90);
          break;
        case ']':
          rotate(90);
          break;
        case '+':
        case '=':
          PP.ui.stage.setZoom(PP.store.state.ui.zoom * 1.15);
          break;
        case '-':
        case '_':
          PP.ui.stage.setZoom(PP.store.state.ui.zoom / 1.15);
          break;
        case '0':
          PP.ui.stage.fitToWindow();
          break;
        case '?':
          help();
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown':
          nudge(event);
          break;
        default:
          if (/^[1-6]$/.test(event.key)) {
            var tab = TAB_KEYS[parseInt(event.key, 10) - 1];
            PP.store.ui(function (ui) {
              ui.tab = tab;
            }, 'tab');
          }
      }
    });

    document.addEventListener('paste', function (event) {
      var files = [];
      var items = (event.clipboardData && event.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var file = items[i].getAsFile();
          if (file && PP.imaging.isImage(file)) files.push(file);
        }
      }
      if (files.length) {
        event.preventDefault();
        PP.app.addFiles(files);
      }
    });
  }

  function rotate(delta) {
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

  function nudge(event) {
    var targets = PP.store.targets();
    if (!targets.length) return;
    event.preventDefault();
    var step = event.shiftKey ? 0.12 : 0.03;
    var dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    var dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    PP.store.update(
      function () {
        targets.forEach(function (item) {
          item.ox = PP.units.clamp((item.ox || 0) + dx, -1, 1);
          item.oy = PP.units.clamp((item.oy || 0) + dy, -1, 1);
        });
      },
      { label: 'nudge' },
    );
  }

  function help() {
    var table = el('div', { class: 'readout' });
    LIST.forEach(function (pair) {
      table.appendChild(el('dt', { text: pair[0] }));
      table.appendChild(el('dd', { text: pair[1] }));
    });
    PP.ui.modal({ title: 'Клавиши', body: table, ok: 'Ясно', cancel: false });
  }

  PP.ui.shortcuts = { mount: mount, help: help };
})((window.PP = window.PP || {}));
