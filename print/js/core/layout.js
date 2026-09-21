/* Отпечаток — filling the sheet.
 *
 * Paper costs money, so the point of this file is to waste as little of it as
 * possible while never silently shrinking anything: a card that does not fit is
 * reported, not quietly resized. Everything is millimetres.
 */
(function (PP) {
  'use strict';

  function paperSize(page) {
    var paper =
      page.paperId === 'custom'
        ? { w: page.paperCustom.w, h: page.paperCustom.h, safe: 0 }
        : PP.formats.paper(page.paperId);
    var w = paper.w;
    var h = paper.h;
    if (page.orient === 'landscape' && h > w) {
      var t = w;
      w = h;
      h = t;
    } else if (page.orient === 'portrait' && w > h) {
      var t2 = w;
      w = h;
      h = t2;
    }
    return { w: w, h: h, safe: paper.safe || 0, roll: Boolean(paper.roll) };
  }

  function margins(page) {
    if (page.borderless) return 0;
    return Math.max(0, page.margin || 0);
  }

  /** Every card the document asks for, copies expanded, in order. */
  function expand(doc, onlyIds) {
    var cards = [];
    doc.items.forEach(function (item) {
      if (onlyIds && onlyIds.indexOf(item.id) < 0) return;
      var size = PP.formats.cardSize(item);
      var copies = Math.max(1, Math.min(999, item.copies || 1));
      for (var i = 0; i < copies; i++) {
        cards.push({ item: item, w: size.w, h: size.h, copy: i, scale: 1, rot: 0 });
      }
    });
    return cards;
  }

  function place(card, x, y, rot, scale) {
    var s = scale || 1;
    var w = card.w * s;
    var h = card.h * s;
    return {
      item: card.item,
      copy: card.copy,
      x: x,
      y: y,
      w: rot ? h : w,
      h: rot ? w : h,
      cardW: card.w,
      cardH: card.h,
      rot: rot || 0,
      scale: s,
    };
  }

  /* ------------------------------------------------------------------ modes */

  function layoutGrid(cards, sheet, page) {
    var gap = Math.max(0, page.gap || 0);
    var cellW = 0;
    var cellH = 0;
    cards.forEach(function (c) {
      cellW = Math.max(cellW, c.w);
      cellH = Math.max(cellH, c.h);
    });
    if (!cards.length) return { pages: [], overflow: [] };

    var rotate = false;
    var cols = Math.floor((sheet.w + gap) / (cellW + gap));
    var rows = Math.floor((sheet.h + gap) / (cellH + gap));

    if (page.autoRotate) {
      var colsR = Math.floor((sheet.w + gap) / (cellH + gap));
      var rowsR = Math.floor((sheet.h + gap) / (cellW + gap));
      if (colsR * rowsR > cols * rows) {
        rotate = true;
        cols = colsR;
        rows = rowsR;
        var swap = cellW;
        cellW = cellH;
        cellH = swap;
      }
    }

    var overflow = [];
    if (cols < 1 || rows < 1) {
      return { pages: [], overflow: cards.slice() };
    }

    var perPage = cols * rows;
    var pages = [];
    var index = 0;

    while (index < cards.length) {
      var slice = cards.slice(index, index + perPage);
      var used = slice.length;
      var usedCols = Math.min(cols, used);
      var usedRows = Math.ceil(used / cols);
      var blockW = usedCols * cellW + (usedCols - 1) * gap;
      var blockH = usedRows * cellH + (usedRows - 1) * gap;
      var originX = page.align === 'topleft' ? sheet.x : sheet.x + (sheet.w - blockW) / 2;
      var originY = page.align === 'topleft' ? sheet.y : sheet.y + (sheet.h - blockH) / 2;

      var placed = slice.map(function (card, i) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var rot = rotate ? 90 : 0;
        var cw = rot ? card.h : card.w;
        var ch = rot ? card.w : card.h;
        var x = originX + col * (cellW + gap) + (cellW - cw) / 2;
        var y = originY + row * (cellH + gap) + (cellH - ch) / 2;
        return place(card, x, y, rot, 1);
      });
      pages.push(placed);
      index += perPage;
    }
    return { pages: pages, overflow: overflow };
  }

  function layoutPack(cards, sheet, page) {
    var gap = Math.max(0, page.gap || 0);
    var pages = [];
    var overflow = [];
    var current = [];
    var rowY = sheet.y;
    var rowX = sheet.x;
    var rowH = 0;

    function newPage() {
      if (current.length) pages.push(current);
      current = [];
      rowY = sheet.y;
      rowX = sheet.x;
      rowH = 0;
    }

    cards.forEach(function (card) {
      var w = card.w;
      var h = card.h;
      var rot = 0;

      if (w > sheet.w || h > sheet.h) {
        if (page.autoRotate && h <= sheet.w && w <= sheet.h) {
          rot = 90;
          var t = w;
          w = h;
          h = t;
        } else {
          overflow.push(card);
          return;
        }
      }

      // Turn it sideways when that is the only way it joins this row.
      if (page.autoRotate && !rot && rowX + w > sheet.x + sheet.w + 0.01) {
        if (h <= sheet.w && rowX + h <= sheet.x + sheet.w + 0.01 && w <= rowH + 0.01) {
          rot = 90;
          var t2 = w;
          w = h;
          h = t2;
        }
      }

      if (rowX + w > sheet.x + sheet.w + 0.01) {
        rowY += rowH + gap;
        rowX = sheet.x;
        rowH = 0;
      }
      if (rowY + h > sheet.y + sheet.h + 0.01) {
        newPage();
      }

      current.push(place({ item: card.item, w: card.w, h: card.h, copy: card.copy }, rowX, rowY, rot, 1));
      rowX += w + gap;
      rowH = Math.max(rowH, h);
    });

    if (current.length) pages.push(current);
    return { pages: pages, overflow: overflow };
  }

  function layoutSingle(cards, sheet, page) {
    var pages = [];
    var overflow = [];
    cards.forEach(function (card) {
      var rot = 0;
      var w = card.w;
      var h = card.h;
      if (page.autoRotate && (w > sheet.w || h > sheet.h) && h <= sheet.w && w <= sheet.h) {
        rot = 90;
        w = card.h;
        h = card.w;
      }
      var scale = 1;
      if (page.shrinkToFit && (w > sheet.w || h > sheet.h)) {
        scale = Math.min(sheet.w / w, sheet.h / h);
      } else if (w > sheet.w || h > sheet.h) {
        overflow.push(card);
      }
      var x = sheet.x + (sheet.w - w * scale) / 2;
      var y = sheet.y + (sheet.h - h * scale) / 2;
      pages.push([place(card, x, y, rot, scale)]);
    });
    return { pages: pages, overflow: overflow };
  }

  /** One card, repeated until the sheet is full — passport photos, stickers. */
  function layoutFill(cards, sheet, page) {
    if (!cards.length) return { pages: [], overflow: [] };
    var template = cards[0];
    var gap = Math.max(0, page.gap || 0);
    var cols = Math.floor((sheet.w + gap) / (template.w + gap));
    var rows = Math.floor((sheet.h + gap) / (template.h + gap));
    var rotated = false;

    if (page.autoRotate) {
      var colsR = Math.floor((sheet.w + gap) / (template.h + gap));
      var rowsR = Math.floor((sheet.h + gap) / (template.w + gap));
      if (colsR * rowsR > cols * rows) {
        rotated = true;
        cols = colsR;
        rows = rowsR;
      }
    }
    if (cols < 1 || rows < 1) return { pages: [], overflow: [template] };

    var want = page.fillCount > 0 ? page.fillCount : cols * rows;
    var copies = [];
    for (var i = 0; i < want; i++) copies.push(template);

    var cw = rotated ? template.h : template.w;
    var ch = rotated ? template.w : template.h;
    var pages = [];
    var index = 0;

    while (index < copies.length) {
      var take = Math.min(cols * rows, copies.length - index);
      var usedCols = Math.min(cols, take);
      var usedRows = Math.ceil(take / cols);
      var blockW = usedCols * cw + (usedCols - 1) * gap;
      var blockH = usedRows * ch + (usedRows - 1) * gap;
      var originX = sheet.x + (sheet.w - blockW) / 2;
      var originY = sheet.y + (sheet.h - blockH) / 2;
      var placed = [];
      for (var j = 0; j < take; j++) {
        var col = j % cols;
        var row = Math.floor(j / cols);
        placed.push(
          place(
            template,
            originX + col * (cw + gap),
            originY + row * (ch + gap),
            rotated ? 90 : 0,
            1,
          ),
        );
      }
      pages.push(placed);
      index += take;
    }
    return { pages: pages, overflow: [] };
  }

  /** Contact sheet: everything small, in order, to choose from. */
  function layoutContact(cards, sheet, page) {
    var cols = Math.max(1, Math.min(12, page.contactCols || 5));
    var gap = Math.max(1, page.gap || 0);
    var labelSpace = page.showNames ? 5 : 0;
    var cellW = (sheet.w - gap * (cols - 1)) / cols;
    var tallest = 0;
    cards.forEach(function (c) {
      tallest = Math.max(tallest, c.h / c.w);
    });
    var cellH = cellW * (tallest || 1.35) + labelSpace;
    var rows = Math.max(1, Math.floor((sheet.h + gap) / (cellH + gap)));
    var perPage = cols * rows;

    var pages = [];
    var index = 0;
    while (index < cards.length) {
      var slice = cards.slice(index, index + perPage);
      var placed = slice.map(function (card, i) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var scale = Math.min(cellW / card.w, (cellH - labelSpace) / card.h);
        var w = card.w * scale;
        var h = card.h * scale;
        var x = sheet.x + col * (cellW + gap) + (cellW - w) / 2;
        var y = sheet.y + row * (cellH + gap) + (cellH - labelSpace - h) / 2;
        var slot = place(card, x, y, 0, scale);
        slot.label = page.showNames ? true : false;
        slot.labelY = sheet.y + row * (cellH + gap) + cellH - 1;
        return slot;
      });
      pages.push(placed);
      index += perPage;
    }
    return { pages: pages, overflow: [] };
  }

  /* ----------------------------------------------------------------- build */

  /**
   * Turn the document into a list of sheets, each a list of placed cards.
   * Nothing is drawn here; this is only arithmetic, which makes it testable.
   */
  function build(doc, options) {
    var opts = options || {};
    var page = doc.page;
    var size = paperSize(page);
    var m = margins(page);
    var safe = page.borderless ? 0 : Math.max(m, opts.respectSafe ? size.safe : 0);

    var sheet = {
      x: safe,
      y: safe,
      w: Math.max(1, size.w - safe * 2),
      h: Math.max(1, size.h - safe * 2),
    };

    var cards = expand(doc, opts.onlyIds || null);
    if (!cards.length) {
      return { pages: [], paper: size, sheet: sheet, overflow: [], mode: page.mode };
    }

    var result;
    switch (page.mode) {
      case 'single':
        result = layoutSingle(cards, sheet, page);
        break;
      case 'pack':
        result = layoutPack(cards, sheet, page);
        break;
      case 'fill':
        result = layoutFill(cards, sheet, page);
        break;
      case 'contact':
        result = layoutContact(cards, sheet, page);
        break;
      default:
        result = layoutGrid(cards, sheet, page);
    }

    return {
      pages: result.pages,
      overflow: result.overflow,
      paper: size,
      sheet: sheet,
      mode: page.mode,
      cardCount: cards.length,
    };
  }

  /** Share of the printable area actually covered — the paper-waste number. */
  function coverage(placed, sheet) {
    var area = 0;
    placed.forEach(function (card) {
      area += card.w * card.h;
    });
    var total = sheet.w * sheet.h;
    return total > 0 ? area / total : 0;
  }

  var MODES = [
    { id: 'grid', name: 'Сетка', hint: 'Ровные ряды одинаковых ячеек' },
    { id: 'pack', name: 'Плотно', hint: 'Разные размеры без пустот' },
    { id: 'single', name: 'По одному на лист', hint: 'Каждое фото — свой лист' },
    { id: 'fill', name: 'Заполнить копиями', hint: 'Одно фото на весь лист, как на документы' },
    { id: 'contact', name: 'Контрольный лист', hint: 'Все кадры мелко, для выбора' },
  ];

  PP.layout = {
    build: build,
    expand: expand,
    paperSize: paperSize,
    margins: margins,
    coverage: coverage,
    MODES: MODES,
  };
})((window.PP = window.PP || {}));
