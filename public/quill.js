/**
 * The writer's side of the page: capturing Apple Pencil strokes as ink, and
 * letting the paper drink them.
 */

export const INK = '26, 33, 58';

const MIN_PRESSURE = 0.18;

export class Quill {
  /**
   * @param {HTMLCanvasElement} canvas the transient (flux) layer
   * @param {object} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onStroke = opts.onStroke || (() => {});
    this.onRest = opts.onRest || (() => {});
    this.onExtent = opts.onExtent || (() => {});

    this.enabled = true;
    this.allowTouch = true;
    this.sawPen = false;

    this.active = null; // pointerId currently drawing
    this.points = [];
    this.bounds = null;
    this.marked = false;
    this.baseWidth = 3.6;

    this.#listen();
  }

  setMetrics({ baseWidth }) {
    this.baseWidth = baseWidth;
  }

  /** Ignore input entirely (while the page is absorbing or answering). */
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.#endStroke();
  }

  /** True once anything at all has been written since the last absorption. */
  get hasInk() {
    return this.marked;
  }

  reset() {
    this.marked = false;
    this.bounds = null;
    this.points = [];
    this.active = null;
  }

  // ------------------------------------------------------------------ input

  #listen() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.#down(e), { passive: false });
    c.addEventListener('pointermove', (e) => this.#move(e), { passive: false });
    c.addEventListener('pointerup', (e) => this.#up(e), { passive: false });
    c.addEventListener('pointercancel', (e) => this.#up(e), { passive: false });
    c.addEventListener('pointerleave', (e) => this.#up(e), { passive: false });
  }

  #accepts(event) {
    if (!this.enabled) return false;
    if (event.pointerType === 'pen') return true;
    // Once a pencil has touched the page, fingers are palm — reject them.
    if (this.sawPen) return false;
    if (event.pointerType === 'touch') return this.allowTouch;
    return true; // mouse / trackpad, for a desk rather than a lap
  }

  #point(event) {
    const rect = this.canvas.getBoundingClientRect();
    let pressure = event.pressure;
    if (!pressure || event.pointerType !== 'pen') pressure = 0.52;
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      p: Math.max(MIN_PRESSURE, Math.min(1, pressure)),
    };
  }

  #down(event) {
    if (event.pointerType === 'pen') this.sawPen = true;
    if (!this.#accepts(event)) return;
    if (this.active !== null) return;

    event.preventDefault();
    this.active = event.pointerId;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety, not a requirement */
    }

    const pt = this.#point(event);
    this.points = [pt, pt];
    this.#grow(pt, pt.p);
    this.marked = true;

    // Every new stroke resets the pause that decides when the page has had
    // enough — otherwise the diary would answer in the middle of a word.
    this.onStroke();

    // A tap alone should still leave a full stop on the page.
    this.#dot(pt);
  }

  #move(event) {
    if (this.active !== event.pointerId) return;
    event.preventDefault();

    const samples =
      typeof event.getCoalescedEvents === 'function'
        ? event.getCoalescedEvents()
        : [event];

    for (const sample of samples.length ? samples : [event]) {
      this.#extend(this.#point(sample));
    }
  }

  #up(event) {
    if (this.active !== event.pointerId) return;
    event.preventDefault();
    this.#endStroke();
    this.onRest();
  }

  #endStroke() {
    if (this.active === null) return;
    try {
      this.canvas.releasePointerCapture(this.active);
    } catch {
      /* already gone */
    }
    this.active = null;
    this.points = [];
  }

  // ------------------------------------------------------------------ drawing

  #extend(pt) {
    const pts = this.points;
    const prev = pts[pts.length - 1];
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    if (dx * dx + dy * dy < 0.35) return; // ignore tremor

    // Ease the pressure so the line swells rather than steps.
    pt.p = prev.p + (pt.p - prev.p) * 0.35;
    pts.push(pt);
    if (pts.length > 4) pts.shift();

    if (pts.length < 3) return;

    const [a, b, c] = pts.slice(-3);
    const from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const to = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };

    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = `rgba(${INK}, 0.93)`;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.#width(b.p);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(b.x, b.y, to.x, to.y);
    ctx.stroke();
    ctx.restore();

    this.#grow(pt, ctx.lineWidth);
  }

  #dot(pt) {
    const ctx = this.ctx;
    const r = this.#width(pt.p) / 2;
    ctx.save();
    ctx.fillStyle = `rgba(${INK}, 0.93)`;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  #width(pressure) {
    return this.baseWidth * (0.34 + 0.78 * pressure);
  }

  #grow(pt, width) {
    const pad = width / 2 + 2;
    const b = this.bounds;
    if (!b) {
      this.bounds = {
        left: pt.x - pad,
        top: pt.y - pad,
        right: pt.x + pad,
        bottom: pt.y + pad,
      };
    } else {
      b.left = Math.min(b.left, pt.x - pad);
      b.top = Math.min(b.top, pt.y - pad);
      b.right = Math.max(b.right, pt.x + pad);
      b.bottom = Math.max(b.bottom, pt.y + pad);
    }
    this.onExtent(this.bounds);
  }
}

// ---------------------------------------------------------------- snapshotting

/**
 * Lift the ink off the page as a flat image the diary can read: cropped to what
 * was actually written, laid on white for contrast, and no larger than it needs
 * to be.
 */
export function liftInk(canvas, bounds, dpr, maxEdge = 1400) {
  if (!bounds) return null;

  const pad = 26;
  const left = Math.max(0, Math.floor((bounds.left - pad) * dpr));
  const top = Math.max(0, Math.floor((bounds.top - pad) * dpr));
  const right = Math.min(canvas.width, Math.ceil((bounds.right + pad) * dpr));
  const bottom = Math.min(canvas.height, Math.ceil((bounds.bottom + pad) * dpr));

  const w = right - left;
  const h = bottom - top;
  if (w < 4 || h < 4) return null;

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));

  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, left, top, w, h, 0, 0, out.width, out.height);

  return out.toDataURL('image/png');
}

// ---------------------------------------------------------------- absorption

/**
 * The page drinks what was written: the ink spreads a moment into the fibres,
 * then is drawn away left to right, in the direction it was laid down.
 *
 * This animation is also the app's only "waiting" state. It is deliberately
 * diegetic — nothing spins, nothing pulses, nothing says the diary is thinking.
 */
export function absorb(canvas, bounds, dpr, duration = 1250) {
  return new Promise((resolve) => {
    const ctx = canvas.getContext('2d');

    if (!bounds) {
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      resolve();
      return;
    }

    const pad = 60;
    const left = Math.max(0, Math.floor(bounds.left - pad));
    const top = Math.max(0, Math.floor(bounds.top - pad));
    const right = Math.min(canvas.width / dpr, Math.ceil(bounds.right + pad));
    const bottom = Math.min(canvas.height / dpr, Math.ceil(bounds.bottom + pad));
    const w = Math.max(1, right - left);
    const h = Math.max(1, bottom - top);

    // Copy just the written region; blurring the whole page every frame is not
    // something a tablet should be asked to do.
    const snap = document.createElement('canvas');
    snap.width = Math.round(w * dpr);
    snap.height = Math.round(h * dpr);
    const sctx = snap.getContext('2d');
    sctx.scale(dpr, dpr);
    sctx.drawImage(
      canvas,
      Math.round(left * dpr),
      Math.round(top * dpr),
      Math.round(w * dpr),
      Math.round(h * dpr),
      0,
      0,
      w,
      h,
    );

    const stage = document.createElement('canvas');
    stage.width = snap.width;
    stage.height = snap.height;
    const stx = stage.getContext('2d');

    const feather = Math.max(70, w * 0.22);
    const started = performance.now();

    const frame = (now) => {
      const t = Math.min(1, (now - started) / duration);
      const ease = t * t * (3 - 2 * t);

      // Wet phase: the ink blooms very slightly into the paper before it goes.
      const spread = t < 0.24 ? t / 0.24 : 1;
      const blur = spread * 1.5 + ease * 2.2;
      const drift = ease * 5;

      stx.setTransform(1, 0, 0, 1, 0, 0);
      stx.clearRect(0, 0, stage.width, stage.height);
      stx.scale(dpr, dpr);
      stx.filter = `blur(${blur.toFixed(2)}px)`;
      stx.drawImage(snap, 0, 0, w, h, 0, drift, w, h);
      stx.filter = 'none';

      // Draw the sweep away.
      const sweep = -feather + (w + feather * 2) * (t < 0.24 ? 0 : (t - 0.24) / 0.76);
      const mask = stx.createLinearGradient(sweep - feather, 0, sweep, 0);
      mask.addColorStop(0, 'rgba(0,0,0,1)');
      mask.addColorStop(1, 'rgba(0,0,0,0)');
      stx.globalCompositeOperation = 'destination-out';
      stx.fillStyle = mask;
      stx.fillRect(0, 0, w, h);
      stx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.clearRect(left, top, w, h);
      ctx.globalAlpha = 1 - ease * 0.35;
      ctx.drawImage(stage, 0, 0, stage.width, stage.height, left, top, w, h);
      ctx.restore();

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        resolve();
      }
    };

    requestAnimationFrame(frame);
  });
}
