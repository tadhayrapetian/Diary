/* Отпечаток — the tray on the left.
 *
 * It is not a photo album, it is the print queue: one chip per card that will be
 * printed, in the order they will be laid out. Dragging a chip moves the card on
 * the sheet, which is the shortest distance between wanting something moved and
 * it being moved.
 */
(function (PP) {
  'use strict';

  var el = PP.ui.el;
  var signature = '';
  var dragFrom = -1;

  function mount() {
    var tray = PP.ui.$('tray');

    tray.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) {
        if (!event.shiftKey && !event.metaKey && !event.ctrlKey) select(null, event);
        return;
      }
      select(chip.getAttribute('data-id'), event);
    });

    tray.addEventListener('dblclick', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) return;
      PP.store.ui(function (ui) {
        ui.mode = 'editor';
      }, 'mode');
    });

    PP.ui.$('btn-lib-all').addEventListener('click', selectAll);
    PP.ui.$('btn-dup').addEventListener('click', duplicate);
    PP.ui.$('btn-del').addEventListener('click', remove);
    PP.ui.$('btn-sort').addEventListener('click', sortByDate);
  }

  function select(id, event) {
    PP.store.ui(function (ui) {
      if (!id) {
        ui.selected = [];
        return;
      }
      var additive = event && (event.metaKey || event.ctrlKey);
      var ranged = event && event.shiftKey;
      var items = PP.store.state.doc.items;

      if (ranged && ui.selected.length) {
        var last = ui.selected[ui.selected.length - 1];
        var from = indexOf(items, last);
        var to = indexOf(items, id);
        if (from >= 0 && to >= 0) {
          var lo = Math.min(from, to);
          var hi = Math.max(from, to);
          var range = items.slice(lo, hi + 1).map(function (item) {
            return item.id;
          });
          ui.selected = range;
          return;
        }
      }
      if (additive) {
        var at = ui.selected.indexOf(id);
        if (at >= 0) ui.selected.splice(at, 1);
        else ui.selected.push(id);
        return;
      }
      ui.selected = [id];
    }, 'select');
  }

  function indexOf(items, id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
    return -1;
  }

  function selectAll() {
    PP.store.ui(function (ui, doc) {
      ui.selected =
        ui.selected.length === doc.items.length
          ? []
          : doc.items.map(function (item) {
              return item.id;
            });
    }, 'select');
  }

  function duplicate() {
    var chosen = PP.store.selectedItems();
    if (!chosen.length) return;
    PP.store.update(function (doc, ui) {
      var made = [];
      chosen.forEach(function (item) {
        var copy = PP.store.clone(item);
        copy.id = PP.store.uid('it');
        var at = indexOf(doc.items, item.id);
        doc.items.splice(at + 1, 0, copy);
        made.push(copy.id);
      });
      ui.selected = made;
    });
    PP.ui.toast('Дубликат сделан');
  }

  function remove() {
    var chosen = PP.store.state.ui.selected.slice();
    if (!chosen.length) return;
    PP.store.update(function (doc, ui) {
      doc.items = doc.items.filter(function (item) {
        return chosen.indexOf(item.id) < 0;
      });
      // A photograph nobody prints any more leaves the library too.
      var used = {};
      doc.items.forEach(function (item) {
        used[item.photoId] = true;
      });
      doc.photos = doc.photos.filter(function (photo) {
        return used[photo.id];
      });
      ui.selected = [];
    });
  }

  function sortByDate() {
    PP.store.update(function (doc) {
      doc.items.sort(function (a, b) {
        var pa = PP.store.photo(a.photoId);
        var pb = PP.store.photo(b.photoId);
        var da = pa && pa.date ? Date.parse(pa.date) : Infinity;
        var db = pb && pb.date ? Date.parse(pb.date) : Infinity;
        if (da === db) return (pa ? pa.name : '').localeCompare(pb ? pb.name : '');
        return da - db;
      });
    });
    PP.ui.toast('Отсортировано по дате съёмки');
  }

  function move(from, to) {
    if (from === to || from < 0) return;
    PP.store.update(function (doc) {
      var moved = doc.items.splice(from, 1)[0];
      doc.items.splice(to, 0, moved);
    });
  }

  /* ------------------------------------------------------------- rendering */

  function render() {
    var doc = PP.store.state.doc;
    var ui = PP.store.state.ui;
    var tray = PP.ui.$('tray');
    var empty = PP.ui.$('tray-empty');

    PP.ui.$('library-count').textContent = String(doc.items.length);
    empty.hidden = doc.items.length > 0;

    var nextSignature = doc.items
      .map(function (item) {
        return (
          item.id +
          ':' +
          item.photoId +
          ':' +
          item.copies +
          ':' +
          item.formatId +
          ':' +
          item.orient
        );
      })
      .join('|');

    if (nextSignature !== signature) {
      signature = nextSignature;
      tray.innerHTML = '';
      doc.items.forEach(function (item, index) {
        tray.appendChild(chipFor(item, index));
      });
    }

    Array.prototype.forEach.call(tray.children, function (chip) {
      chip.classList.toggle('sel', ui.selected.indexOf(chip.getAttribute('data-id')) >= 0);
    });

    var some = ui.selected.length > 0;
    PP.ui.$('btn-dup').disabled = !some;
    PP.ui.$('btn-del').disabled = !some;
  }

  function chipFor(item, index) {
    var photo = PP.store.photo(item.photoId);
    var card = PP.formats.cardSize(item);
    var dpi = photo ? PP.render.itemDpi(item, photo) : 0;
    var format = item.formatId === 'custom' ? null : PP.formats.get(item.formatId);

    var chip = el('div', {
      class: 'chip',
      'data-id': item.id,
      'data-index': index,
      draggable: 'true',
      title:
        (photo ? photo.name : 'без фото') +
        '\n' +
        (format ? format.name : 'свой размер') +
        ' · ' +
        PP.units.sizeLabel(card.w, card.h) +
        '\n' +
        Math.round(dpi) +
        ' dpi на печати',
    }, [
      el('img', { src: photo ? PP.imaging.thumb(photo.id) : '', alt: photo ? photo.name : '' }),
      el('span', { class: 'dot ' + PP.units.dpiVerdict(dpi) }),
      el('span', {
        class: 'tag',
        text: format ? shortName(format.name) : PP.units.round(card.w, 0) + '×' + PP.units.round(card.h, 0),
      }),
      item.copies > 1 ? el('span', { class: 'copies', text: '×' + item.copies }) : null,
    ]);

    chip.addEventListener('dragstart', function (event) {
      dragFrom = index;
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', item.id);
      } catch (error) {
        /* Safari is particular about this */
      }
    });
    chip.addEventListener('dragover', function (event) {
      if (dragFrom < 0) return;
      event.preventDefault();
      chip.classList.add('drag-over');
    });
    chip.addEventListener('dragleave', function () {
      chip.classList.remove('drag-over');
    });
    chip.addEventListener('drop', function (event) {
      if (dragFrom < 0) return;
      event.preventDefault();
      event.stopPropagation();
      chip.classList.remove('drag-over');
      move(dragFrom, index);
      dragFrom = -1;
    });
    chip.addEventListener('dragend', function () {
      dragFrom = -1;
      Array.prototype.forEach.call(document.querySelectorAll('.drag-over'), function (node) {
        node.classList.remove('drag-over');
      });
    });

    return chip;
  }

  function shortName(name) {
    return name
      .replace('Polaroid ', 'Pol ')
      .replace('Instax ', 'Ins ')
      .replace('Квадрат ', '□ ')
      .replace('Панорама ', '▭ ')
      .replace('Документ ', 'Док ')
      .slice(0, 12);
  }

  PP.ui.library = { mount: mount, render: render, select: select, selectAll: selectAll, duplicate: duplicate, remove: remove };
})((window.PP = window.PP || {}));
