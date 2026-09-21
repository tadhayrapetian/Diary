/* Отпечаток — drawing one card.
 *
 * Everything on a sheet is a card: a rectangle of known millimetre size with a
 * window in it, a photograph behind the window, and whatever is written on the
 * white part underneath. The same function draws it at 40 px wide for a
 * thumbnail and at 1300 px for a printer; only `scale` differs, which is the
 * only way to be sure that what is on screen is what comes out.
 */
(function (PP) {
  'use strict';

  var FONTS = {
    // Petit Formal Script is Latin only — the bundled file has no Cyrillic in
    // it — so the chain keeps going until it finds a hand that can write "Лето".
    hand: "'Petit Formal Script', 'Segoe Script', 'Snell Roundhand', 'Comic Sans MS', cursive",
    sans: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    mono: "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    display: "'Futura', 'Century Gothic', 'Trebuchet MS', sans-serif",
    typewriter: "'Courier New', Courier, monospace",
  };

  var FONT_NAMES = [
    { id: 'hand', name: 'Рукописный' },
    { id: 'sans', name: 'Гротеск' },
    { id: 'serif', name: 'Антиква' },
    { id: 'mono', name: 'Моноширинный' },
    { id: 'display', name: 'Плакатный' },
    { id: 'typewriter', name: 'Пишущая машинка' },
  ];

  var cache = Object.create(null);
  var cacheOrder = [];
  var CACHE_LIMIT = 220;

  function roundRectPath(ctx, x, y, w, h, r) {
    var radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    if (!radius) {
      ctx.rect(x, y, w, h);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }

  /**
   * How the photograph sits in its window.
   * Returns millimetres, so the same numbers serve the renderer, the dragging
   * and the resolution warning.
   */
  function placement(item, photo) {
    var win = PP.formats.windowRect(item);
    var sw = photo ? photo.w : 1000;
    var sh = photo ? photo.h : 1000;
    var rad = ((item.angle || 0) * Math.PI) / 180;
    var cos = Math.abs(Math.cos(rad));
    var sin = Math.abs(Math.sin(rad));
    var boxW = sw * cos + sh * sin;
    var boxH = sw * sin + sh * cos;

    var fitScale =
      item.fit === 'contain'
        ? Math.min(win.w / boxW, win.h / boxH)
        : Math.max(win.w / boxW, win.h / boxH);
    var scale = fitScale * (item.zoom || 1); // millimetres per source pixel

    var drawnW = boxW * scale;
    var drawnH = boxH * scale;
    var slackX = Math.abs(drawnW - win.w) / 2;
    var slackY = Math.abs(drawnH - win.h) / 2;

    return {
      win: win,
      scale: scale,
      cx: win.x + win.w / 2 + (item.ox || 0) * slackX,
      cy: win.y + win.h / 2 + (item.oy || 0) * slackY,
      w: sw * scale,
      h: sh * scale,
      slackX: slackX,
      slackY: slackY,
      dpi: scale > 0 ? PP.units.MM_PER_INCH / scale : 0,
    };
  }

  /** Resolution the photo actually delivers at its printed size. */
  function itemDpi(item, photo) {
    if (!photo) return 0;
    return placement(item, photo).dpi;
  }

  /* ------------------------------------------------------------------ draw */

  /**
   * Draw the card into `ctx` with its top-left corner at (0, 0).
   * `scale` is pixels per millimetre.
   */
  function drawCard(ctx, item, photo, scale, opts) {
    var options = opts || {};
    var card = PP.formats.cardSize(item);
    var frame = item.frame || {};
    var style = frame.style || 'none';
    var win = PP.formats.windowRect(item);
    var W = card.w * scale;
    var H = card.h * scale;
    var radius = (frame.radius || 0) * scale;

    ctx.save();

    // The card itself.
    if (style !== 'none') {
      roundRectPath(ctx, 0, 0, W, H, radius);
      ctx.fillStyle = frame.color || '#ffffff';
      ctx.fill();
    } else if (options.paper) {
      roundRectPath(ctx, 0, 0, W, H, radius);
      ctx.fillStyle = options.paper;
      ctx.fill();
    }

    // The window, and the photograph in it.
    var wx = win.x * scale;
    var wy = win.y * scale;
    var ww = win.w * scale;
    var wh = win.h * scale;

    if (ww > 0.5 && wh > 0.5) {
      var patch = renderWindow(item, photo, ww, wh, scale, options);
      ctx.save();
      if (style === 'none' && radius) {
        roundRectPath(ctx, 0, 0, W, H, radius);
        ctx.clip();
      } else {
        ctx.beginPath();
        ctx.rect(wx, wy, ww, wh);
        ctx.clip();
      }
      if (patch) ctx.drawImage(patch, wx, wy);
      ctx.restore();

      // Hairline around the window — the inner keyline of a matted print.
      if (frame.line > 0 && style !== 'none') {
        ctx.save();
        ctx.strokeStyle = frame.lineColor || '#cccccc';
        ctx.lineWidth = Math.max(0.6, frame.line * scale);
        ctx.strokeRect(
          wx - ctx.lineWidth / 2,
          wy - ctx.lineWidth / 2,
          ww + ctx.lineWidth,
          wh + ctx.lineWidth,
        );
        ctx.restore();
      }

      if (style === 'matte') {
        // A matte has depth: a soft shadow falling inwards from the cut edge.
        ctx.save();
        var g = ctx.createLinearGradient(wx, wy, wx, wy + Math.min(wh, 6 * scale));
        g.addColorStop(0, 'rgba(0,0,0,0.16)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(wx, wy, ww, Math.min(wh, 6 * scale));
        ctx.restore();
      }
    }

    drawCaption(ctx, item, card, win, scale, options);

    ctx.restore();
    return { w: W, h: H };
  }

  /** The photograph, corrected, at exactly the window's pixel size. */
  function renderWindow(item, photo, ww, wh, scale, options) {
    var source = null;
    if (photo) {
      var needed = Math.max(ww, wh);
      source = PP.imaging.source(photo.id, options.print ? Infinity : needed);
    }

    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(ww));
    canvas.height = Math.max(1, Math.round(wh));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    ctx.fillStyle = item.fit === 'contain' ? (item.frame && item.frame.color) || '#ffffff' : '#e9e9ec';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!source) {
      drawPlaceholder(ctx, canvas.width, canvas.height);
      return canvas;
    }

    var place = placement(item, photo);
    var srcW = source.width || source.naturalWidth;
    var srcH = source.height || source.naturalHeight;
    // The preview copy is smaller than the original, so convert through its own
    // pixel count rather than the photo's.
    var mmPerPx = (place.w / srcW) || 0;

    var adj = item.adj || {};
    var blur = (adj.blur || 0) / 100;
    if (blur > 0) {
      var blurPx = blur * Math.min(canvas.width, canvas.height) * 0.06;
      if (blurPx >= 0.3) ctx.filter = 'blur(' + blurPx.toFixed(2) + 'px)';
    }

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate((place.cx - place.win.x) * scale, (place.cy - place.win.y) * scale);
    ctx.rotate(((item.angle || 0) * Math.PI) / 180);
    ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
    var dw = srcW * mmPerPx * scale;
    var dh = srcH * mmPerPx * scale;
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    ctx.filter = 'none';

    var effective = effectiveAdj(adj, options);
    if (effective) PP.adjust.apply(canvas, effective, { scale: scale });

    drawStamp(ctx, item, canvas.width, canvas.height, scale);
    return canvas;
  }

  /** Output-wide corrections (proof in grey, ink saver) fold into the item's. */
  function effectiveAdj(adj, options) {
    var output = options.output;
    if (!output || (!output.proofMono && !output.inkSaver)) return adj;
    var copy = {};
    Object.keys(adj).forEach(function (k) {
      copy[k] = adj[k];
    });
    if (output.proofMono) copy.mono = 100;
    if (output.inkSaver) {
      copy.exposure = (copy.exposure || 0) + 16;
      copy.saturation = (copy.saturation || 0) - 22;
      copy.contrast = (copy.contrast || 0) - 10;
    }
    return copy;
  }

  function drawPlaceholder(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = '#dcdce2';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#b9b9c4';
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.006);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, h);
    ctx.moveTo(w, 0);
    ctx.lineTo(0, h);
    ctx.stroke();
    ctx.restore();
  }

  /* --------------------------------------------------------------- writing */

  function drawCaption(ctx, item, card, win, scale, options) {
    var text = item.text || {};
    var caption = (text.caption || '').trim();
    if (!caption) return;

    var style = (item.frame && item.frame.style) || 'none';
    var size = Math.max(1, (text.size || 5) * scale);
    var font = FONTS[text.font] || FONTS.sans;

    var stripTop, stripHeight;
    if (style === 'classic') {
      stripTop = (win.y + win.h) * scale;
      stripHeight = card.h * scale - stripTop;
    } else if (style === 'edge' || style === 'matte') {
      stripTop = (win.y + win.h) * scale;
      stripHeight = card.h * scale - stripTop;
    } else {
      // Nothing to write on: lay it over the foot of the picture.
      stripTop = card.h * scale - size * 2.4;
      stripHeight = size * 2.4;
    }
    if (stripHeight < size * 0.9) {
      stripTop = card.h * scale - size * 2.2;
      stripHeight = size * 2.2;
    }

    var lines = caption.split('\n').slice(0, 4);
    var maxWidth = card.w * scale * 0.88;

    ctx.save();
    ctx.font = size + 'px ' + font;
    // Shrink to fit rather than clipping somebody's words.
    var widest = 0;
    lines.forEach(function (line) {
      widest = Math.max(widest, ctx.measureText(line).width);
    });
    if (widest > maxWidth) {
      size = size * (maxWidth / widest);
      ctx.font = size + 'px ' + font;
    }

    ctx.fillStyle = text.color || '#2b2b33';
    ctx.textAlign = text.align === 'left' ? 'left' : text.align === 'right' ? 'right' : 'center';
    ctx.textBaseline = 'middle';

    var pad = card.w * scale * 0.06;
    var x =
      ctx.textAlign === 'left'
        ? pad
        : ctx.textAlign === 'right'
          ? card.w * scale - pad
          : (card.w * scale) / 2;

    var lineHeight = size * 1.24;
    var block = lineHeight * lines.length;
    var top = stripTop + (stripHeight - block) / 2 + lineHeight / 2 + (text.offset || 0) * scale;

    if (style === 'none' && options.captionPlate !== false) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, stripTop, card.w * scale, stripHeight);
      ctx.restore();
    }

    lines.forEach(function (line, i) {
      ctx.fillText(line, x, top + i * lineHeight);
    });
    ctx.restore();
  }

  /** The orange date a film camera burned into the corner. */
  function drawStamp(ctx, item, w, h, scale) {
    var text = item.text || {};
    if (!text.stamp) return;
    var value = (text.stampText || '').trim();
    if (!value) return;

    var size = Math.max(6, (text.stampSize || 3.2) * scale);
    ctx.save();
    ctx.font = 'bold ' + size + 'px ' + FONTS.typewriter;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    var x = w - size * 0.9;
    var y = h - size * 0.7;
    ctx.shadowColor = 'rgba(255,140,0,0.75)';
    ctx.shadowBlur = size * 0.5;
    ctx.fillStyle = text.stampColor || '#ff8f2e';
    ctx.fillText(value, x, y);
    ctx.shadowBlur = 0;
    ctx.fillText(value, x, y);
    ctx.restore();
  }

  function stampFor(photo, pattern) {
    var date = photo && photo.date ? new Date(photo.date) : new Date();
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    var d = pad(date.getDate());
    var m = pad(date.getMonth() + 1);
    var y = String(date.getFullYear());
    switch (pattern) {
      case 'ymd':
        return y + ' ' + m + ' ' + d;
      case 'mdy':
        return m + ' ' + d + " '" + y.slice(2);
      case 'short':
        return d + '.' + m + '.' + y.slice(2);
      case 'time':
        return d + '.' + m + '.' + y + '  ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      default:
        return d + '.' + m + '.' + y;
    }
  }

  /* ------------------------------------------------------------- the cache */

  function signature(item, scale, options) {
    return (
      item.id +
      '|' +
      Math.round(scale * 100) +
      '|' +
      (options.print ? 'p' : 's') +
      '|' +
      (options.output ? (options.output.proofMono ? 'm' : '') + (options.output.inkSaver ? 'i' : '') : '') +
      '|' +
      JSON.stringify(item)
    );
  }

  /**
   * A card on its own canvas, remembered until something about it changes.
   * Grain is random per render, so cards with grain are cached like any other —
   * the noise simply stays put until the card is edited, which is what you want
   * when you are comparing two of them.
   */
  function cardCanvas(item, photo, scale, opts) {
    var options = opts || {};
    var key = options.noCache ? null : signature(item, scale, options);
    if (key && cache[key]) return cache[key];

    var card = PP.formats.cardSize(item);
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(card.w * scale));
    canvas.height = Math.max(1, Math.round(card.h * scale));
    var ctx = canvas.getContext('2d');
    drawCard(ctx, item, photo, scale, options);

    if (key) {
      cache[key] = canvas;
      cacheOrder.push(key);
      while (cacheOrder.length > CACHE_LIMIT) {
        delete cache[cacheOrder.shift()];
      }
    }
    return canvas;
  }

  function clearCache() {
    cache = Object.create(null);
    cacheOrder = [];
  }

  PP.render = {
    FONTS: FONTS,
    FONT_NAMES: FONT_NAMES,
    roundRectPath: roundRectPath,
    placement: placement,
    itemDpi: itemDpi,
    drawCard: drawCard,
    cardCanvas: cardCanvas,
    clearCache: clearCache,
    stampFor: stampFor,
  };
})((window.PP = window.PP || {}));
