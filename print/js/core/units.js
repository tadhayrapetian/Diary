/* Отпечаток — units.
 *
 * Everything inside this program is millimetres. Pixels only ever appear at the
 * two edges of the pipeline: when a photo is decoded, and when a sheet is
 * rasterised for a printer. Keeping one unit in the middle is the whole reason
 * the sizes come out right on paper.
 */
(function (PP) {
  'use strict';

  var MM_PER_INCH = 25.4;

  function mmToPx(mm, dpi) {
    return (mm / MM_PER_INCH) * dpi;
  }

  function pxToMm(px, dpi) {
    return (px / dpi) * MM_PER_INCH;
  }

  function inchToMm(inch) {
    return inch * MM_PER_INCH;
  }

  function mmToInch(mm) {
    return mm / MM_PER_INCH;
  }

  /** Screen scale: CSS pixels per millimetre at a given zoom. */
  function screenScale(zoom) {
    // 96 CSS px per inch is the web's fixed notion of an inch. It is a fiction on
    // most displays, which is exactly why the calibration card exists.
    return (96 / MM_PER_INCH) * (zoom || 1);
  }

  /** How many dots per inch a photo actually delivers at a printed size. */
  function effectiveDpi(sourcePx, printedMm) {
    if (!printedMm) return 0;
    return sourcePx / mmToInch(printedMm);
  }

  /** Verdict on a resolution, for the badge on the thumbnail. */
  function dpiVerdict(dpi) {
    if (dpi >= 280) return 'good';
    if (dpi >= 180) return 'fair';
    if (dpi >= 120) return 'poor';
    return 'bad';
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function round(value, places) {
    var f = Math.pow(10, places == null ? 1 : places);
    return Math.round(value * f) / f;
  }

  /** "88 × 107 мм" — the way a size is spoken everywhere in the interface. */
  function sizeLabel(w, h, unit) {
    if (unit === 'in') {
      return round(mmToInch(w), 2) + ' × ' + round(mmToInch(h), 2) + '″';
    }
    return round(w, 1) + ' × ' + round(h, 1) + ' мм';
  }

  /** Plural forms, because "3 фотографий" reads like a machine wrote it. */
  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
    return round(bytes / (1024 * 1024), 1) + ' МБ';
  }

  PP.units = {
    MM_PER_INCH: MM_PER_INCH,
    mmToPx: mmToPx,
    pxToMm: pxToMm,
    inchToMm: inchToMm,
    mmToInch: mmToInch,
    screenScale: screenScale,
    effectiveDpi: effectiveDpi,
    dpiVerdict: dpiVerdict,
    clamp: clamp,
    round: round,
    sizeLabel: sizeLabel,
    plural: plural,
    formatBytes: formatBytes,
  };
})((window.PP = window.PP || {}));
