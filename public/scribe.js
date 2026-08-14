/**
 * The diary's own hand.
 *
 * Text arrives in pieces from the network and is laid down on the page one
 * character at a time, wet and dark at the nib, settling behind it. If the
 * network falls behind, the hand simply pauses mid-sentence — which is what a
 * person writing would do, and is the whole reason this app never needs a
 * spinner.
 */

export const FONT_STACK =
  '"Snell Roundhand", "Petit Formal Script", "Apple Chancery", "Savoye LET", "Zapfino", "Segoe Script", "Brush Script MT", cursive';

const SETTLED = 'rgba(26, 33, 58, 0.9)';
const WET = 'rgba(12, 16, 38, 0.62)';

/** Extra rest after a character, in ms at the reference speed. */
const PAUSES = {
  ',': 120,
  ';': 150,
  ':': 150,
  '—': 160,
  '.': 250,
  '!': 250,
  '?': 250,
  ' ': 18,
};

const REFERENCE_SPEED = 52;

/**
 * Choose a pixel size that looks the same weight on the page whichever script
 * face actually resolved. Snell Roundhand (what an iPad will use) has a small
 * x-height and tall capitals; Petit Formal Script (the bundled fallback) is the
 * other way about. Anchoring on x-height alone makes one of them tiny and the
 * other enormous, so anchor on a blend of the two and let the leading follow the
 * face's own ascenders and descenders.
 */
export function measureScript(targetLetter) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `100px ${FONT_STACK}`;

  const xh = probe.measureText('x').actualBoundingBoxAscent || 50;
  const cap = probe.measureText('H').actualBoundingBoxAscent || 72;
  const blended = (0.35 * xh + 0.65 * cap) / 100;

  const size = Math.max(14, Math.round(targetLetter / blended));

  probe.font = `${size}px ${FONT_STACK}`;
  const tall = probe.measureText('Hbdfhklgjpqy,');
  const ascent = Math.ceil(tall.actualBoundingBoxAscent || size * 0.85);
  const descent = Math.ceil(tall.actualBoundingBoxDescent || size * 0.28);

  const lineHeight = Math.round(
    Math.min(size * 1.75, Math.max(size * 1.05, (ascent + descent) * 1.12)),
  );

  return { size, ascent, descent, lineHeight };
}

export class Scribe {
  constructor({ flux, page, dpr }) {
    this.flux = flux;
    this.fluxCtx = flux.getContext('2d');
    this.page = page;
    this.pageCtx = page.getContext('2d');
    this.dpr = dpr;

    this.line = document.createElement('canvas');
    this.lineCtx = this.line.getContext('2d');
    this.wet = document.createElement('canvas');
    this.wetCtx = this.wet.getContext('2d');

    this.speed = REFERENCE_SPEED;
    this.rate = 1;
    this.running = false;
  }

  configure({ size, ascent, descent, lineHeight, width, speed }) {
    this.size = size;
    this.ascent = ascent;
    this.descent = descent;
    this.lineHeight = lineHeight;
    this.width = width;
    this.speed = speed || REFERENCE_SPEED;
    this.font = `${size}px ${FONT_STACK}`;

    this.boxTop = ascent + 8; // baseline offset inside the scratch canvas
    this.boxHeight = ascent + descent + 16;

    for (const [canvas, ctx] of [
      [this.line, this.lineCtx],
      [this.wet, this.wetCtx],
    ]) {
      canvas.width = Math.ceil(width * this.dpr);
      canvas.height = Math.ceil(this.boxHeight * this.dpr);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
    }

    this.lineCtx.font = this.font;
    this.wetCtx.font = this.font;
    this.emWidth = this.lineCtx.measureText('n').width || size * 0.4;
  }

  /**
   * @param {object} o
   * @param {number} o.x       left edge of the writing column
   * @param {number} o.y       baseline for the first line
   * @param {number} o.floor   lowest baseline allowed before more room is needed
   * @param {() => Promise<{y:number, floor:number}>} o.needRoom
   * @param {() => void} o.onDone
   */
  begin({ x, y, floor, needRoom, onDone }) {
    this.x = x;
    this.cursorY = y;
    this.floor = floor;
    this.needRoom = needRoom;
    this.onDone = onDone || (() => {});

    this.pending = '';
    this.lines = [];
    this.li = 0;
    this.ci = 0;
    this.charAt = 0;
    this.advances = [0];
    this.sealed = false;
    this.rate = 1;
    this.waiting = false;
    this.placing = false;
    this.bottomY = y;

    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.#tick(t));
  }

  feed(text) {
    if (!this.running) return;
    this.pending += text;
    this.#layout(false);
  }

  seal() {
    this.sealed = true;
    this.#layout(true);
  }

  /** A tap on the page while it writes: get on with it. */
  hasten() {
    if (this.running) this.rate = Math.min(3, this.rate * 2.2);
  }

  /** Abandon this reply. Settles the caller's promise so nothing is left hanging. */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.onDone();
  }

  // ------------------------------------------------------------------ layout

  #open() {
    const last = this.lines[this.lines.length - 1];
    if (last && !last.closed) return last;
    const line = { text: '', closed: false, y: null };
    this.lines.push(line);
    return line;
  }

  #close() {
    const last = this.lines[this.lines.length - 1];
    if (last && !last.closed) last.closed = true;
    else this.lines.push({ text: '', closed: true, y: null }); // a blank line
  }

  #fits(text) {
    this.lineCtx.font = this.font;
    return this.lineCtx.measureText(text).width <= this.width;
  }

  /**
   * Only lay out words we know are complete — a half-arrived word would wrap to
   * the wrong place and then jump when the rest of it lands.
   */
  #layout(final) {
    if (!this.pending) return;

    let chunk;
    if (final) {
      chunk = this.pending;
      this.pending = '';
    } else {
      let cut = -1;
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        if (/\s/.test(this.pending[i])) {
          cut = i;
          break;
        }
      }
      if (cut < 0) return;
      chunk = this.pending.slice(0, cut + 1);
      this.pending = this.pending.slice(cut + 1);
    }

    for (const token of chunk.split(/(\s+)/)) {
      if (!token) continue;

      if (/^\s+$/.test(token)) {
        const breaks = (token.match(/\n/g) || []).length;
        if (breaks) {
          for (let i = 0; i < Math.min(breaks, 2); i += 1) this.#close();
        } else {
          const line = this.#open();
          if (line.text) line.text += ' ';
        }
        continue;
      }

      let line = this.#open();
      const joined = line.text + token;
      if (line.text && !this.#fits(joined)) {
        this.#close();
        line = this.#open();
        line.text = this.#hardBreak(token, line);
      } else if (!line.text && !this.#fits(token)) {
        line.text = this.#hardBreak(token, line);
      } else {
        line.text = joined;
      }
    }

    this.#refreshAdvances();
  }

  /** A word wider than the column (a URL, say) is broken by character. */
  #hardBreak(token, line) {
    let held = '';
    for (const ch of token) {
      if (held && !this.#fits(held + ch)) {
        line.text = held;
        this.#close();
        line = this.#open();
        held = '';
      }
      held += ch;
    }
    return held;
  }

  #refreshAdvances() {
    const line = this.lines[this.li];
    if (!line) return;
    this.lineCtx.font = this.font;
    const adv = [0];
    for (let i = 1; i <= line.text.length; i += 1) {
      adv.push(this.lineCtx.measureText(line.text.slice(0, i)).width);
    }
    this.advances = adv;
  }

  // ------------------------------------------------------------------ the hand

  #duration(index) {
    const line = this.lines[this.li];
    const ch = line.text[index];
    const w = this.advances[index + 1] - this.advances[index];
    const scale = this.speed / REFERENCE_SPEED;
    const shape = Math.max(0.35, Math.min(2.6, 0.45 + (0.9 * w) / this.emWidth));
    const jitter = 0.86 + Math.random() * 0.28;
    const pause = (PAUSES[ch] || 0) * scale;
    return (this.speed * shape * jitter + pause) / this.rate;
  }

  #advanceLine() {
    const finished = this.lines[this.li];
    if (finished && finished.text) this.#settle(finished);
    this.#clearBand(finished);

    this.li += 1;
    this.ci = 0;
    this.advances = [0];
    this.#refreshAdvances();
  }

  /** Assign a baseline to a line about to be written, turning the page if need be. */
  async #place(line) {
    if (line.y !== null) return true;

    if (this.cursorY + this.descent > this.floor) {
      this.waiting = true;
      const room = await this.needRoom();
      this.waiting = false;
      if (!this.running) return false;
      this.cursorY = room.y;
      this.floor = room.floor;
    }
    line.y = this.cursorY;
    this.cursorY += this.lineHeight;
    this.bottomY = line.y + this.descent;
    return true;
  }

  #tick(now) {
    if (!this.running) return;
    const dt = now - this.last;
    this.last = now;

    if (!this.waiting) this.#step(dt);

    requestAnimationFrame((t) => this.#tick(t));
  }

  #step(dt) {
    const line = this.lines[this.li];

    if (!line) {
      // Nothing laid out yet. The page simply stays blank.
      if (this.sealed && !this.pending) this.#end();
      return;
    }

    if (line.y === null) {
      // Placing may turn the page, which is asynchronous. Guard against a second
      // frame starting a second turn while the first is still in the air.
      if (!this.placing) {
        this.placing = true;
        this.#place(line).finally(() => {
          this.placing = false;
        });
      }
      return;
    }

    if (this.ci >= line.text.length) {
      const isLast = this.li >= this.lines.length - 1;
      if (!isLast) {
        this.#advanceLine();
        return;
      }
      if (this.sealed && !this.pending) {
        this.#settleFinal(line);
        this.#end();
      }
      return; // starving: hand rests mid-line until more text arrives
    }

    this.charAt += dt;
    let budget = this.#duration(this.ci);

    while (this.charAt >= budget && this.ci < line.text.length) {
      this.charAt -= budget;
      this.ci += 1;
      if (this.ci < line.text.length) budget = this.#duration(this.ci);
      else break;
    }

    const from = this.advances[this.ci] ?? 0;
    const to = this.advances[this.ci + 1] ?? from;
    const frac = budget > 0 ? Math.min(1, this.charAt / budget) : 0;
    const nib = from + (to - from) * frac;

    this.#paint(nib);
  }

  #paint(nibX) {
    const line = this.lines[this.li];
    if (!line || line.y === null) return;

    const lctx = this.lineCtx;
    const wctx = this.wetCtx;
    const feather = Math.max(4, this.size * 0.13);
    const wetSpan = Math.max(18, this.size * 0.9);

    lctx.clearRect(0, 0, this.width, this.boxHeight);
    lctx.font = this.font;
    lctx.fillStyle = SETTLED;
    lctx.fillText(line.text, 0, this.boxTop);

    // The freshest ink is darker and still standing on the surface.
    wctx.clearRect(0, 0, this.width, this.boxHeight);
    wctx.font = this.font;
    wctx.fillStyle = WET;
    wctx.filter = 'blur(0.5px)';
    wctx.fillText(line.text, 0, this.boxTop);
    wctx.filter = 'none';
    const shine = wctx.createLinearGradient(nibX - wetSpan, 0, nibX, 0);
    shine.addColorStop(0, 'rgba(0,0,0,0)');
    shine.addColorStop(1, 'rgba(0,0,0,1)');
    wctx.globalCompositeOperation = 'destination-in';
    wctx.fillStyle = shine;
    wctx.fillRect(0, 0, this.width, this.boxHeight);
    wctx.globalCompositeOperation = 'source-over';
    lctx.drawImage(this.wet, 0, 0, this.width, this.boxHeight);

    // Everything past the nib has not been written yet.
    const edge = lctx.createLinearGradient(nibX - feather, 0, nibX, 0);
    edge.addColorStop(0, 'rgba(0,0,0,1)');
    edge.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.globalCompositeOperation = 'destination-in';
    lctx.fillStyle = edge;
    lctx.fillRect(0, 0, this.width, this.boxHeight);
    lctx.globalCompositeOperation = 'source-over';

    const top = line.y - this.boxTop;
    this.fluxCtx.clearRect(this.x, top, this.width, this.boxHeight);
    this.fluxCtx.drawImage(this.line, this.x, top, this.width, this.boxHeight);
  }

  /** Move a completed line onto the permanent page, with a touch of bleed. */
  #settle(line) {
    const ctx = this.pageCtx;
    ctx.save();
    ctx.font = this.font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = SETTLED;
    ctx.shadowColor = 'rgba(26, 33, 58, 0.3)';
    ctx.shadowBlur = 1.5;
    ctx.fillText(line.text, this.x, line.y);
    ctx.restore();
  }

  #settleFinal(line) {
    if (line.text) this.#settle(line);
    this.#clearBand(line);
  }

  #clearBand(line) {
    if (!line || line.y === null) return;
    this.fluxCtx.clearRect(
      this.x,
      line.y - this.boxTop,
      this.width,
      this.boxHeight,
    );
  }

  #end() {
    if (!this.running) return;
    this.running = false;
    const last = this.lines[this.lines.length - 1];
    if (last && last.y !== null) this.bottomY = last.y + this.descent;
    this.onDone();
  }
}
