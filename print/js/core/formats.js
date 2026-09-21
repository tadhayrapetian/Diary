/* Отпечаток — the catalogue.
 *
 * Instant film is not a photograph with a white edge drawn on it: the card and
 * the window in it are two different sizes, and the window sits high. Every film
 * entry below carries its real card size and its real image window, in
 * millimetres, so a Polaroid printed here is the size of a Polaroid.
 *
 * `film.border` is the margin at the left, right and top; `film.bottom` is the
 * broad strip you hold and write on.
 */
(function (PP) {
  'use strict';

  var FORMATS = [
    // ---------------------------------------------------------------- мгновенная плёнка
    {
      id: 'pol-600',
      group: 'instant',
      name: 'Polaroid 600 / i-Type',
      w: 88,
      h: 107,
      film: { border: 4.5, bottom: 23.5 },
      note: 'Классика. Окно 79 × 79 мм',
    },
    {
      id: 'pol-sx70',
      group: 'instant',
      name: 'Polaroid SX-70',
      w: 88,
      h: 107,
      film: { border: 4.5, bottom: 23.5 },
      note: 'Тот же кадр, что у 600',
    },
    {
      id: 'pol-go',
      group: 'instant',
      name: 'Polaroid Go',
      w: 53.9,
      h: 66.6,
      film: { border: 3.45, bottom: 17.15 },
      note: 'Самый маленький. Окно 47 × 46 мм',
    },
    {
      id: 'pol-spectra',
      group: 'instant',
      name: 'Polaroid Spectra / Image',
      w: 101,
      h: 101,
      film: { border: 5, bottom: 23 },
      note: 'Квадратная карточка, горизонтальное окно 91 × 73 мм',
    },
    {
      id: 'pol-8x10',
      group: 'instant',
      name: 'Polaroid 8×10',
      w: 203,
      h: 254,
      film: { border: 9, bottom: 30 },
      note: 'Большой формат, размеры окна приблизительные',
    },
    {
      id: 'instax-mini',
      group: 'instant',
      name: 'Instax mini',
      w: 54,
      h: 86,
      film: { border: 4, bottom: 20 },
      note: 'Окно 46 × 62 мм',
    },
    {
      id: 'instax-square',
      group: 'instant',
      name: 'Instax Square',
      w: 72,
      h: 86,
      film: { border: 5, bottom: 19 },
      note: 'Окно 62 × 62 мм',
    },
    {
      id: 'instax-wide',
      group: 'instant',
      name: 'Instax Wide',
      w: 108,
      h: 86,
      film: { border: 4.5, bottom: 19.5 },
      note: 'Окно 99 × 62 мм',
    },

    // ---------------------------------------------------------------- обычные фото
    { id: 'p-9x13', group: 'photo', name: '9 × 13', w: 89, h: 127 },
    { id: 'p-10x15', group: 'photo', name: '10 × 15', w: 102, h: 152, note: 'Самый ходовой размер' },
    { id: 'p-13x18', group: 'photo', name: '13 × 18', w: 127, h: 178 },
    { id: 'p-15x20', group: 'photo', name: '15 × 20', w: 152, h: 203 },
    { id: 'p-15x21', group: 'photo', name: '15 × 21', w: 152, h: 216 },
    { id: 'p-20x30', group: 'photo', name: '20 × 30', w: 203, h: 305 },
    { id: 'p-21x30', group: 'photo', name: '21 × 30 (A4)', w: 210, h: 297 },
    { id: 'p-a6', group: 'photo', name: 'A6 — открытка', w: 105, h: 148 },
    { id: 'p-a5', group: 'photo', name: 'A5', w: 148, h: 210 },

    // ---------------------------------------------------------------- квадрат
    { id: 's-70', group: 'square', name: 'Квадрат 7 × 7', w: 70, h: 70 },
    { id: 's-100', group: 'square', name: 'Квадрат 10 × 10', w: 102, h: 102 },
    { id: 's-130', group: 'square', name: 'Квадрат 13 × 13', w: 127, h: 127 },
    { id: 's-150', group: 'square', name: 'Квадрат 15 × 15', w: 152, h: 152 },
    { id: 's-200', group: 'square', name: 'Квадрат 20 × 20', w: 203, h: 203 },
    { id: 's-300', group: 'square', name: 'Квадрат 30 × 30', w: 305, h: 305 },

    // ---------------------------------------------------------------- крупное
    { id: 'b-30x40', group: 'big', name: '30 × 40', w: 305, h: 406 },
    { id: 'b-30x45', group: 'big', name: '30 × 45', w: 305, h: 457 },
    { id: 'b-a3', group: 'big', name: 'A3', w: 297, h: 420 },
    { id: 'b-40x50', group: 'big', name: '40 × 50', w: 406, h: 508 },
    { id: 'b-50x70', group: 'big', name: '50 × 70', w: 508, h: 711 },
    { id: 'b-60x90', group: 'big', name: '60 × 90', w: 610, h: 914 },

    // ---------------------------------------------------------------- панорама
    { id: 'pan-10x30', group: 'pano', name: 'Панорама 10 × 30', w: 102, h: 305 },
    { id: 'pan-13x38', group: 'pano', name: 'Панорама 13 × 38', w: 127, h: 380 },
    { id: 'pan-15x45', group: 'pano', name: 'Панорама 15 × 45', w: 152, h: 457 },

    // ---------------------------------------------------------------- документы
    { id: 'd-35x45', group: 'doc', name: 'Паспорт 3,5 × 4,5', w: 35, h: 45, note: 'РФ, Шенген' },
    { id: 'd-30x40', group: 'doc', name: 'Документ 3 × 4', w: 30, h: 40, note: 'Пропуск, студенческий' },
    { id: 'd-40x60', group: 'doc', name: 'Документ 4 × 6', w: 40, h: 60 },
    { id: 'd-51x51', group: 'doc', name: 'Виза США 51 × 51', w: 51, h: 51 },
    { id: 'd-25x35', group: 'doc', name: 'Мини 2,5 × 3,5', w: 25, h: 35 },

    // ---------------------------------------------------------------- дюймы
    { id: 'i-wallet', group: 'inch', name: 'Wallet 2,5″ × 3,5″', w: 63.5, h: 88.9 },
    { id: 'i-4x6', group: 'inch', name: '4″ × 6″', w: 101.6, h: 152.4 },
    { id: 'i-5x7', group: 'inch', name: '5″ × 7″', w: 127, h: 177.8 },
    { id: 'i-8x10', group: 'inch', name: '8″ × 10″', w: 203.2, h: 254 },
    { id: 'i-letter', group: 'inch', name: '8,5″ × 11″', w: 215.9, h: 279.4 },
    { id: 'i-11x14', group: 'inch', name: '11″ × 14″', w: 279.4, h: 355.6 },

    // ---------------------------------------------------------------- мелочь
    { id: 'm-sticker', group: 'small', name: 'Стикер 5 × 5', w: 50, h: 50 },
    { id: 'm-mini', group: 'small', name: 'Миникарточка 6 × 9', w: 60, h: 90 },
    { id: 'm-bookmark', group: 'small', name: 'Закладка 5 × 15', w: 50, h: 150 },
    { id: 'm-card', group: 'small', name: 'Визитка 9 × 5', w: 90, h: 50 },
  ];

  var GROUPS = [
    { id: 'instant', name: 'Мгновенная плёнка' },
    { id: 'photo', name: 'Обычные фото' },
    { id: 'square', name: 'Квадрат' },
    { id: 'big', name: 'Крупный формат' },
    { id: 'pano', name: 'Панорама' },
    { id: 'doc', name: 'Документы' },
    { id: 'inch', name: 'Дюймовые' },
    { id: 'small', name: 'Мелочь' },
    { id: 'custom', name: 'Свой размер' },
  ];

  /* Paper. `safe` is the strip most inkjets physically cannot reach; a printer
   * with borderless printing ignores it, which is what the toggle is for. */
  var PAPERS = [
    { id: 'a4', name: 'A4', w: 210, h: 297, safe: 4 },
    { id: 'a3', name: 'A3', w: 297, h: 420, safe: 5 },
    { id: 'a5', name: 'A5', w: 148, h: 210, safe: 4 },
    { id: 'a6', name: 'A6', w: 105, h: 148, safe: 3 },
    { id: 'letter', name: 'Letter', w: 215.9, h: 279.4, safe: 4 },
    { id: 'legal', name: 'Legal', w: 215.9, h: 355.6, safe: 4 },
    { id: 'tabloid', name: 'Tabloid A3+', w: 279.4, h: 431.8, safe: 5 },
    { id: 'ph-10x15', name: 'Фотобумага 10 × 15', w: 102, h: 152, safe: 0 },
    { id: 'ph-13x18', name: 'Фотобумага 13 × 18', w: 127, h: 178, safe: 0 },
    { id: 'ph-20x30', name: 'Фотобумага 20 × 30', w: 203, h: 305, safe: 0 },
    { id: 'roll-100', name: 'Рулон 100 мм', w: 100, h: 3000, safe: 0, roll: true },
    { id: 'custom', name: 'Свой размер', w: 210, h: 297, safe: 0 },
  ];

  /* Ready-made frames. Numbers are millimetres unless the name says otherwise. */
  var FRAME_PRESETS = [
    {
      id: 'classic',
      name: 'Полароид белый',
      frame: { style: 'classic', color: '#fdfdfb', radius: 1.6, line: 0, lineColor: '#d8d3c6' },
    },
    {
      id: 'black',
      name: 'Полароид чёрный',
      frame: { style: 'classic', color: '#15161a', radius: 1.6, line: 0, lineColor: '#000000' },
    },
    {
      id: 'cream',
      name: 'Винтажный крем',
      frame: { style: 'classic', color: '#f3e7cf', radius: 2.2, line: 0.3, lineColor: '#c8b489' },
    },
    {
      id: 'kraft',
      name: 'Крафт',
      frame: { style: 'classic', color: '#cdb391', radius: 1, line: 0, lineColor: '#a98c66' },
    },
    {
      id: 'edge-white',
      name: 'Белое поле',
      frame: { style: 'edge', color: '#ffffff', border: 6, radius: 0, line: 0, lineColor: '#cccccc' },
    },
    {
      id: 'edge-thin',
      name: 'Тонкий кант',
      frame: { style: 'edge', color: '#ffffff', border: 2.5, radius: 0, line: 0.25, lineColor: '#1b1b1b' },
    },
    {
      id: 'matte',
      name: 'Паспарту',
      frame: { style: 'matte', color: '#f7f5ef', border: 12, radius: 0, line: 0.4, lineColor: '#b9b2a2' },
    },
    {
      id: 'none',
      name: 'Без рамки, в обрез',
      frame: { style: 'none', border: 0, radius: 0, line: 0 },
    },
  ];

  /* Proportions borrowed from a real 600 card: the side margin is 5.1% of the
   * card width, the writing strip 22% of its height. Applied to any format that
   * has no film geometry of its own, so a 10 × 15 can be a Polaroid too. */
  var CLASSIC_SIDE_RATIO = 4.5 / 88;
  var CLASSIC_BOTTOM_RATIO = 23.5 / 107;

  var byId = {};
  FORMATS.forEach(function (f) {
    byId[f.id] = f;
  });

  var papersById = {};
  PAPERS.forEach(function (p) {
    papersById[p.id] = p;
  });

  function get(id) {
    return byId[id] || null;
  }

  function paper(id) {
    return papersById[id] || papersById.a4;
  }

  function group(id) {
    return FORMATS.filter(function (f) {
      return f.group === id;
    });
  }

  /** Card size in mm, honouring the requested orientation. */
  function cardSize(item) {
    var def = item.formatId === 'custom' ? null : get(item.formatId);
    var w = def ? def.w : item.custom.w;
    var h = def ? def.h : item.custom.h;
    var orient = item.orient || 'portrait';
    if (orient === 'landscape' && h > w) return { w: h, h: w };
    if (orient === 'portrait' && w > h) return { w: h, h: w };
    return { w: w, h: h };
  }

  /**
   * Where the photo actually sits inside the card.
   *
   * Film formats in their native orientation use their measured window. Anything
   * else — a rotated Polaroid, a 13 × 18 wearing a Polaroid frame — gets the
   * classic proportions instead, which is the only honest thing to do when there
   * is no real film to copy.
   */
  function windowRect(item) {
    var card = cardSize(item);
    var frame = item.frame || {};
    var style = frame.style || 'none';

    if (style === 'none') {
      return { x: 0, y: 0, w: card.w, h: card.h, card: card };
    }

    if (style === 'edge' || style === 'matte') {
      var b = Math.max(0, Math.min(frame.border || 0, Math.min(card.w, card.h) / 2 - 1));
      return { x: b, y: b, w: card.w - b * 2, h: card.h - b * 2, card: card };
    }

    // classic: three narrow margins and one broad one.
    var def = item.formatId === 'custom' ? null : get(item.formatId);
    var native = def && def.film && !isRotated(def, card);
    var side = native ? def.film.border : card.w * CLASSIC_SIDE_RATIO;
    var bottom = native ? def.film.bottom : card.h * CLASSIC_BOTTOM_RATIO;

    if (frame.side != null) side = frame.side;
    if (frame.bottom != null) bottom = frame.bottom;

    side = Math.max(0, Math.min(side, card.w / 2 - 1));
    bottom = Math.max(side, Math.min(bottom, card.h - side - 4));

    return {
      x: side,
      y: side,
      w: card.w - side * 2,
      h: card.h - side - bottom,
      card: card,
      side: side,
      bottom: bottom,
    };
  }

  function isRotated(def, card) {
    var defLandscape = def.w > def.h;
    var cardLandscape = card.w > card.h;
    return defLandscape !== cardLandscape;
  }

  /** Natural orientation of a format, before the item overrides it. */
  function naturalOrient(formatId, custom) {
    var def = formatId === 'custom' ? null : get(formatId);
    var w = def ? def.w : (custom && custom.w) || 100;
    var h = def ? def.h : (custom && custom.h) || 150;
    return w > h ? 'landscape' : 'portrait';
  }

  function isFilm(formatId) {
    var def = get(formatId);
    return Boolean(def && def.film);
  }

  function framePreset(id) {
    for (var i = 0; i < FRAME_PRESETS.length; i++) {
      if (FRAME_PRESETS[i].id === id) return FRAME_PRESETS[i];
    }
    return null;
  }

  PP.formats = {
    FORMATS: FORMATS,
    GROUPS: GROUPS,
    PAPERS: PAPERS,
    FRAME_PRESETS: FRAME_PRESETS,
    get: get,
    paper: paper,
    group: group,
    cardSize: cardSize,
    windowRect: windowRect,
    naturalOrient: naturalOrient,
    isFilm: isFilm,
    framePreset: framePreset,
  };
})((window.PP = window.PP || {}));
