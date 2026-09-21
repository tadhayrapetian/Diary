/* Отпечаток — drawing a whole sheet.
 *
 * The same canvas code serves the screen and the printer. Cut marks sit outside
 * the card so the knife has something to aim at without leaving a line on the
 * photograph; the calibration scale is applied here, around the centre of the
 * paper, because that is where a printer's own error is smallest.
 */
(function (PP) {
  'use strict';

  function drawSheet(ctx, placed, info, doc, scale, opts) {
    var options = opts || {};
    var page = doc.page;
    var output = doc.output;
    var paper = info.paper;

    ctx.save();
    ctx.fillStyle = options.transparent ? 'rgba(0,0,0,0)' : page.background || '#ffffff';
    if (!options.transparent) ctx.fillRect(0, 0, paper.w * scale, paper.h * scale);

    if (page.paperTint && !options.transparent) {
      // A whisper of warmth, so white cards read as white on screen.
      ctx.fillStyle = 'rgba(247,242,230,0.55)';
      ctx.fillRect(0, 0, paper.w * scale, paper.h * scale);
    }

    if (options.calibrate !== false) {
      var sx = (output.calibX || 100) / 100;
      var sy = (output.calibY || 100) / 100;
      if (sx !== 1 || sy !== 1) {
        ctx.translate((paper.w * scale) / 2, (paper.h * scale) / 2);
        ctx.scale(sx, sy);
        ctx.translate(-(paper.w * scale) / 2, -(paper.h * scale) / 2);
      }
    }

    if (page.cutLines) drawCutLines(ctx, placed, info, scale);

    placed.forEach(function (card) {
      var item = card.item;
      var photo = PP.store.photo(item.photoId);
      var canvas = PP.render.cardCanvas(item, photo, scale * (card.scale || 1), {
        print: options.print,
        output: output,
        noCache: options.noCache,
      });

      ctx.save();
      ctx.translate(card.x * scale, card.y * scale);
      if (card.rot === 90) {
        ctx.translate(card.w * scale, 0);
        ctx.rotate(Math.PI / 2);
      }
      if (options.shadow) {
        ctx.shadowColor = 'rgba(15,16,24,0.28)';
        ctx.shadowBlur = 7;
        ctx.shadowOffsetY = 3;
      }
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();

      if (card.label) drawLabel(ctx, card, scale);
    });

    if (page.cutMarks) drawCutMarks(ctx, placed, scale);
    if (page.pageNumbers && options.pageNumber) {
      drawPageNumber(ctx, paper, scale, options.pageNumber, options.pageCount);
    }

    ctx.restore();
  }

  function drawCutMarks(ctx, placed, scale) {
    var length = 3.2 * scale;
    var offset = 1.2 * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(0.5, 0.18 * scale);
    placed.forEach(function (card) {
      var x1 = card.x * scale;
      var y1 = card.y * scale;
      var x2 = (card.x + card.w) * scale;
      var y2 = (card.y + card.h) * scale;
      corner(ctx, x1, y1, -1, -1, length, offset);
      corner(ctx, x2, y1, 1, -1, length, offset);
      corner(ctx, x1, y2, -1, 1, length, offset);
      corner(ctx, x2, y2, 1, 1, length, offset);
    });
    ctx.restore();
  }

  function corner(ctx, x, y, dx, dy, length, offset) {
    ctx.beginPath();
    ctx.moveTo(x + dx * offset, y);
    ctx.lineTo(x + dx * (offset + length), y);
    ctx.moveTo(x, y + dy * offset);
    ctx.lineTo(x, y + dy * (offset + length));
    ctx.stroke();
  }

  function drawCutLines(ctx, placed, info, scale) {
    var xs = {};
    var ys = {};
    placed.forEach(function (card) {
      xs[PP.units.round(card.x, 2)] = true;
      xs[PP.units.round(card.x + card.w, 2)] = true;
      ys[PP.units.round(card.y, 2)] = true;
      ys[PP.units.round(card.y + card.h, 2)] = true;
    });
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = Math.max(0.4, 0.12 * scale);
    ctx.setLineDash([2 * scale, 2 * scale]);
    Object.keys(xs).forEach(function (x) {
      ctx.beginPath();
      ctx.moveTo(parseFloat(x) * scale, 0);
      ctx.lineTo(parseFloat(x) * scale, info.paper.h * scale);
      ctx.stroke();
    });
    Object.keys(ys).forEach(function (y) {
      ctx.beginPath();
      ctx.moveTo(0, parseFloat(y) * scale);
      ctx.lineTo(info.paper.w * scale, parseFloat(y) * scale);
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawLabel(ctx, card, scale) {
    var photo = PP.store.photo(card.item.photoId);
    if (!photo) return;
    var size = Math.max(5, 2.6 * scale);
    ctx.save();
    ctx.font = size + 'px ' + PP.render.FONTS.sans;
    ctx.fillStyle = '#4a4a55';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var name = photo.name.length > 26 ? photo.name.slice(0, 24) + '…' : photo.name;
    ctx.fillText(name, (card.x + card.w / 2) * scale, card.labelY * scale);
    ctx.restore();
  }

  function drawPageNumber(ctx, paper, scale, index, count) {
    ctx.save();
    ctx.font = Math.max(6, 2.8 * scale) + 'px ' + PP.render.FONTS.sans;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      index + (count ? ' / ' + count : ''),
      (paper.w * scale) / 2,
      paper.h * scale - 3 * scale,
    );
    ctx.restore();
  }

  /** A whole sheet on its own canvas — used by the preview and by every export. */
  function sheetCanvas(placed, info, doc, scale, opts) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(info.paper.w * scale));
    canvas.height = Math.max(1, Math.round(info.paper.h * scale));
    var ctx = canvas.getContext('2d');
    drawSheet(ctx, placed, info, doc, scale, opts);
    return canvas;
  }

  PP.sheet = {
    drawSheet: drawSheet,
    sheetCanvas: sheetCanvas,
  };
})((window.PP = window.PP || {}));
