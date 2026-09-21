/* Отпечаток — colour.
 *
 * A tone curve baked into three lookup tables (one per channel, so warmth and
 * tint come for free), then one pass over the pixels for saturation, monochrome,
 * grain and vignette. Two passes over the image, no matter how many sliders are
 * open — which is what makes dragging one feel immediate at print resolution.
 */
(function (PP) {
  'use strict';

  var LUM_R = 0.2126;
  var LUM_G = 0.7152;
  var LUM_B = 0.0722;

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* --------------------------------------------------------------- the curve */

  function buildLut(adj) {
    var exposure = Math.pow(2, (adj.exposure || 0) / 100);
    var contrast = (adj.contrast || 0) / 100;
    var highlights = (adj.highlights || 0) / 100;
    var shadows = (adj.shadows || 0) / 100;
    var fade = (adj.fade || 0) / 100;

    // Warmth pulls red up and blue down; tint trades green against magenta.
    var temp = (adj.temp || 0) / 100;
    var tint = (adj.tint || 0) / 100;
    var gain = [
      1 + temp * 0.32 + tint * 0.02,
      1 - Math.abs(temp) * 0.04 - tint * 0.16,
      1 - temp * 0.32 + tint * 0.08,
    ];

    var luts = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];

    for (var c = 0; c < 3; c++) {
      for (var i = 0; i < 256; i++) {
        var v = i / 255;

        v = v * exposure * gain[c];

        // Shadows and highlights move the ends of the curve and leave the
        // middle alone; the weights are smooth so nothing posterises.
        if (shadows) {
          var wS = Math.pow(1 - clamp01(v), 2.2);
          v += shadows * 0.45 * wS;
        }
        if (highlights) {
          var wH = Math.pow(clamp01(v), 2.2);
          v += highlights * 0.45 * wH;
        }

        if (contrast) {
          var k = contrast > 0 ? 1 + contrast * 1.6 : 1 + contrast * 0.85;
          v = (v - 0.5) * k + 0.5;
          if (contrast > 0) {
            // A touch of S so the extremes roll off rather than clip flat.
            v = v + contrast * 0.06 * Math.sin((clamp01(v) - 0.5) * Math.PI * 2);
          }
        }

        if (fade) {
          v = v * (1 - fade * 0.28) + fade * 0.16;
        }

        luts[c][i] = Math.round(clamp01(v) * 255);
      }
    }
    return luts;
  }

  /* --------------------------------------------------------------- the pass */

  /**
   * Apply everything to a canvas in place.
   * `opts.scale` is 1 for print and smaller on screen; grain and vignette use it
   * so a preview looks like what comes out of the printer.
   */
  function apply(canvas, adj, opts) {
    if (!adj) return;
    var options = opts || {};
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!canvas.width || !canvas.height) return;

    if (adj.clarity) sharpen(ctx, canvas, (adj.clarity || 0) / 100);

    var image;
    try {
      image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (error) {
      console.warn('[отпечаток] пиксели недоступны:', error);
      return;
    }

    var data = image.data;
    var luts = buildLut(adj);
    var lutR = luts[0];
    var lutG = luts[1];
    var lutB = luts[2];

    var sat = 1 + (adj.saturation || 0) / 100;
    var mono = (adj.mono || 0) / 100;
    var sepia = (adj.sepia || 0) / 100;
    var grain = (adj.grain || 0) / 100;
    var vignette = (adj.vignette || 0) / 100;
    var hue = ((adj.rotateHue || 0) * Math.PI) / 180;

    var w = canvas.width;
    var h = canvas.height;
    var cx = w / 2;
    var cy = h / 2;
    var maxDist = Math.sqrt(cx * cx + cy * cy) || 1;

    var hueCos = Math.cos(hue);
    var hueSin = Math.sin(hue);
    var doHue = Math.abs(hue) > 0.0001;
    var grainAmp = grain * 46;

    // Grain is a physical size, not a pixel size: at 300 dpi one speck is
    // several pixels across, on screen it is one. Without this the same photo
    // looks sandy in the preview and smooth on paper.
    var grainStep = Math.max(1, Math.round((options.scale || 1) / 3.5));
    var noiseRow = grainAmp ? new Float32Array(Math.ceil(w / grainStep)) : null;

    for (var y = 0; y < h; y++) {
      var rowOffset = y * w * 4;
      var dy = (y - cy) / maxDist;
      if (noiseRow && y % grainStep === 0) {
        for (var n = 0; n < noiseRow.length; n++) {
          noiseRow[n] = (Math.random() - 0.5) * grainAmp;
        }
      }
      for (var x = 0; x < w; x++) {
        var p = rowOffset + x * 4;
        var r = lutR[data[p]];
        var g = lutG[data[p + 1]];
        var b = lutB[data[p + 2]];

        if (doHue) {
          var nr =
            (0.213 + hueCos * 0.787 - hueSin * 0.213) * r +
            (0.715 - hueCos * 0.715 - hueSin * 0.715) * g +
            (0.072 - hueCos * 0.072 + hueSin * 0.928) * b;
          var ng =
            (0.213 - hueCos * 0.213 + hueSin * 0.143) * r +
            (0.715 + hueCos * 0.285 + hueSin * 0.14) * g +
            (0.072 - hueCos * 0.072 - hueSin * 0.283) * b;
          var nb =
            (0.213 - hueCos * 0.213 - hueSin * 0.787) * r +
            (0.715 - hueCos * 0.715 + hueSin * 0.715) * g +
            (0.072 + hueCos * 0.928 + hueSin * 0.072) * b;
          r = nr;
          g = ng;
          b = nb;
        }

        var lum = LUM_R * r + LUM_G * g + LUM_B * b;

        if (sat !== 1) {
          r = lum + (r - lum) * sat;
          g = lum + (g - lum) * sat;
          b = lum + (b - lum) * sat;
        }

        if (mono) {
          r += (lum - r) * mono;
          g += (lum - g) * mono;
          b += (lum - b) * mono;
        }

        if (sepia) {
          r += (lum * 1.07 + 18 - r) * sepia;
          g += (lum * 0.94 + 6 - g) * sepia;
          b += (lum * 0.74 - 6 - b) * sepia;
        }

        if (vignette) {
          var dx = (x - cx) / maxDist;
          var d = Math.sqrt(dx * dx + dy * dy);
          var edge = d * d * d;
          var factor = 1 - vignette * edge * 1.35;
          r *= factor;
          g *= factor;
          b *= factor;
        }

        if (grainAmp) {
          // One value for all three channels reads as film, not as digital noise.
          var speck = noiseRow[(x / grainStep) | 0];
          r += speck;
          g += speck;
          b += speck;
        }

        data[p] = r < 0 ? 0 : r > 255 ? 255 : r;
        data[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        data[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }

    ctx.putImageData(image, 0, 0);
  }

  /** Unsharp for positive clarity, a small blur for negative. */
  function sharpen(ctx, canvas, amount) {
    var w = canvas.width;
    var h = canvas.height;
    if (w < 3 || h < 3) return;
    var image;
    try {
      image = ctx.getImageData(0, 0, w, h);
    } catch (error) {
      return;
    }
    var src = image.data;
    var out = new Uint8ClampedArray(src);
    var soft = amount < 0;
    var k = Math.abs(amount);

    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var p = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          var i = p + c;
          var around =
            src[i - 4] +
            src[i + 4] +
            src[i - w * 4] +
            src[i + w * 4] +
            src[i - w * 4 - 4] +
            src[i - w * 4 + 4] +
            src[i + w * 4 - 4] +
            src[i + w * 4 + 4];
          var mean = around / 8;
          out[i] = soft
            ? src[i] + (mean - src[i]) * k
            : src[i] + (src[i] - mean) * k * 1.6;
        }
      }
    }
    image.data.set(out);
    ctx.putImageData(image, 0, 0);
  }

  /* --------------------------------------------------------------- presets */

  var PRESETS = [
    { id: 'none', name: 'Как есть', adj: {} },
    { id: 'punch', name: 'Сочное', adj: { contrast: 18, saturation: 22, clarity: 12 } },
    { id: 'soft', name: 'Мягкий портрет', adj: { contrast: -8, saturation: -6, shadows: 14, clarity: -10, fade: 8 } },
    { id: 'bw', name: 'Чёрно-белое', adj: { mono: 100, contrast: 10, clarity: 8 } },
    { id: 'bw-hard', name: 'Ч/б контрастное', adj: { mono: 100, contrast: 42, shadows: -14, highlights: 8, clarity: 18, grain: 12 } },
    { id: 'sepia', name: 'Сепия', adj: { sepia: 82, mono: 20, contrast: 6, fade: 10 } },
    { id: 'film400', name: 'Плёнка 400', adj: { contrast: 12, saturation: -6, shadows: 10, grain: 22, fade: 12, temp: 6 } },
    { id: 'vintage', name: 'Винтаж', adj: { temp: 16, saturation: -18, fade: 26, vignette: 24, grain: 14, contrast: -6 } },
    { id: 'faded', name: 'Выцветшее', adj: { fade: 42, saturation: -22, contrast: -12, highlights: 10 } },
    { id: 'warm', name: 'Тёплое', adj: { temp: 26, saturation: 8, shadows: 6 } },
    { id: 'cool', name: 'Холодное', adj: { temp: -26, tint: -6, saturation: 4 } },
    { id: 'lomo', name: 'Ломо', adj: { contrast: 34, saturation: 30, vignette: 52, temp: 8, clarity: 10 } },
    { id: 'retro70', name: 'Ретро 70-е', adj: { temp: 22, tint: 8, saturation: -10, fade: 30, contrast: -6, grain: 18, vignette: 16 } },
    { id: 'polaroid', name: 'Полароидный сдвиг', adj: { temp: -8, tint: 12, fade: 22, contrast: -4, saturation: -8, highlights: 12 } },
    { id: 'drama', name: 'Драма', adj: { contrast: 40, shadows: -22, highlights: -16, clarity: 28, saturation: -10, vignette: 30 } },
    { id: 'sunny', name: 'Солнце', adj: { exposure: 12, temp: 14, contrast: 10, saturation: 12, highlights: -8 } },
    { id: 'night', name: 'Ночь', adj: { exposure: -14, temp: -18, contrast: 18, shadows: -12, grain: 16 } },
    { id: 'cross', name: 'Кросс-процесс', adj: { rotateHue: -12, saturation: 26, contrast: 24, tint: 14, highlights: 10 } },
  ];

  var NEUTRAL = {
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
  };

  function preset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return PRESETS[0];
  }

  /** A preset replaces the colour settings wholesale — no hidden leftovers. */
  function applyPreset(adj, id) {
    var chosen = preset(id);
    Object.keys(NEUTRAL).forEach(function (key) {
      adj[key] = NEUTRAL[key];
    });
    Object.keys(chosen.adj).forEach(function (key) {
      adj[key] = chosen.adj[key];
    });
    adj.preset = id;
    return adj;
  }

  function isNeutral(adj) {
    return Object.keys(NEUTRAL).every(function (key) {
      return !adj[key];
    });
  }

  PP.adjust = {
    apply: apply,
    sharpen: sharpen,
    buildLut: buildLut,
    PRESETS: PRESETS,
    NEUTRAL: NEUTRAL,
    preset: preset,
    applyPreset: applyPreset,
    isNeutral: isNeutral,
  };
})((window.PP = window.PP || {}));
