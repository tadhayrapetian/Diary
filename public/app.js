import { Quill, absorb, liftInk } from './quill.js';
import { Scribe, measureScript } from './scribe.js';

const surface = document.getElementById('surface');
const pageCanvas = document.getElementById('page');
const fluxCanvas = document.getElementById('flux');
const turner = document.getElementById('turner');

const pageCtx = pageCanvas.getContext('2d');
const fluxCtx = fluxCanvas.getContext('2d');

const STORE_HISTORY = 'riddle.history.v1';
const STORE_SETTINGS = 'riddle.settings.v1';

const settings = loadSettings();
let history = loadHistory();

let dpr = 1;
let view = null; // { w, h, x, right, top, bottom, width }
let type = null; // { size, ascent, descent, lineHeight }
let flowBottom = 0;
let state = 'idle'; // idle | absorbing | replying
let scribe = null;
let inflight = null;
let pendingLayout = false;

// ---------------------------------------------------------------- persistence

function loadSettings() {
  const base = { speed: 52, idle: 1800, touch: true };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(STORE_SETTINGS) || '{}') };
  } catch {
    return base;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_SETTINGS, JSON.stringify(settings));
  } catch {
    /* private browsing; the diary simply forgets its preferences */
  }
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_HISTORY) || '[]');
    return Array.isArray(raw) ? raw.slice(-60) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(STORE_HISTORY, JSON.stringify(history.slice(-60)));
  } catch {
    /* nothing to be done */
  }
}

// ---------------------------------------------------------------- layout

function layout() {
  const w = surface.clientWidth;
  const h = surface.clientHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);

  const previous = view;
  let carried = null;
  if (previous && pageCanvas.width) {
    carried = document.createElement('canvas');
    carried.width = pageCanvas.width;
    carried.height = pageCanvas.height;
    carried.getContext('2d').drawImage(pageCanvas, 0, 0);
  }

  for (const canvas of [pageCanvas, fluxCanvas]) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const vmin = Math.min(w, h);
  const spine = Math.min(74, vmin * 0.09);

  view = {
    w,
    h,
    x: spine + Math.max(16, w * 0.032),
    right: w - Math.max(22, w * 0.05),
    top: Math.max(28, h * 0.07),
    bottom: h - Math.max(28, h * 0.075),
  };
  view.width = Math.max(120, view.right - view.x);

  type = measureScript(Math.max(13, Math.min(34, vmin * 0.038)));

  quill.setMetrics({
    baseWidth: Math.max(2.4, Math.min(5.2, vmin * 0.0045)),
  });

  if (carried && previous) {
    const scale = view.width / previous.width;
    pageCtx.save();
    pageCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pageCtx.translate(view.x, view.top);
    pageCtx.scale(scale, scale);
    pageCtx.drawImage(
      carried,
      previous.x * dpr,
      previous.top * dpr,
      carried.width - previous.x * dpr,
      carried.height - previous.top * dpr,
      0,
      0,
      (carried.width / dpr - previous.x),
      (carried.height / dpr - previous.top),
    );
    pageCtx.restore();
    flowBottom = view.top + (flowBottom - previous.top) * scale;
  } else {
    flowBottom = view.top;
  }

  flowBottom = Math.max(view.top, Math.min(view.bottom, flowBottom));
}

// ---------------------------------------------------------------- the page turn

function turnPage() {
  return new Promise((resolve) => {
    const done = () => {
      pageCtx.clearRect(0, 0, view.w, view.h);
      fluxCtx.clearRect(0, 0, view.w, view.h);
      flowBottom = view.top;
      resolve({ y: view.top + type.ascent, floor: view.bottom });
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done();
      return;
    }

    const leaf = document.createElement('canvas');
    leaf.width = pageCanvas.width;
    leaf.height = pageCanvas.height;
    leaf.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;';
    const lctx = leaf.getContext('2d');
    lctx.drawImage(pageCanvas, 0, 0);

    const shade = document.createElement('div');
    shade.className = 'shade';

    turner.append(leaf, shade);
    pageCtx.clearRect(0, 0, view.w, view.h);
    fluxCtx.clearRect(0, 0, view.w, view.h);

    const timing = { duration: 880, easing: 'cubic-bezier(.62,.02,.36,1)' };
    const spin = leaf.animate(
      [
        { transform: 'rotateY(0deg)', filter: 'brightness(1)' },
        { transform: 'rotateY(-96deg)', filter: 'brightness(.82)', offset: 0.62 },
        { transform: 'rotateY(-172deg)', filter: 'brightness(.7)' },
      ],
      timing,
    );
    shade.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0 }], timing);

    spin.onfinish = () => {
      leaf.remove();
      shade.remove();
      done();
    };
  });
}

async function makeRoom(needed) {
  if (flowBottom + needed <= view.bottom) return false;
  await turnPage();
  return true;
}

// ---------------------------------------------------------------- the network

function createPipe() {
  return {
    chunks: [],
    ended: false,
    sink: null,
    finish: null,
    push(text) {
      if (this.sink) this.sink(text);
      else this.chunks.push(text);
    },
    attach(sink, finish) {
      this.sink = sink;
      this.finish = finish;
      for (const chunk of this.chunks) sink(chunk);
      this.chunks.length = 0;
      if (this.ended) finish();
    },
    end() {
      this.ended = true;
      if (this.finish) this.finish();
    },
  };
}

function parseFrame(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

async function ask(image, pipe, signal) {
  const response = await fetch('/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image,
      history,
      turn: history.filter((m) => m.role === 'user').length + 1,
    }),
    signal,
  });

  if (!response.ok || !response.body) throw new Error(`http ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = parseFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (!frame) continue;

      if (frame.event === 'read') pipe.transcript = frame.data.text || null;
      else if (frame.event === 'ink') pipe.push(frame.data.text || '');
      else if (frame.event === 'done') {
        pipe.end();
        return;
      }
    }
  }
  pipe.end();
}

// ---------------------------------------------------------------- the exchange

let idleTimer = null;

function armIdle() {
  clearTimeout(idleTimer);
  if (state !== 'idle' || !quill.hasInk) return;
  if (!settings.idle) return; // manual only
  idleTimer = setTimeout(commit, settings.idle);
}

function disarm() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

async function commit() {
  disarm();
  if (state !== 'idle' || !quill.hasInk || !quill.bounds) return;

  state = 'absorbing';
  quill.setEnabled(false);

  const bounds = { ...quill.bounds };
  const image = liftInk(fluxCanvas, bounds, dpr);
  flowBottom = Math.max(flowBottom, bounds.bottom);

  const pipe = createPipe();
  const controller = new AbortController();
  inflight = controller;

  // Fire the request the instant the ink lifts — the absorption animation is
  // covering the latency, so every millisecond of it should already be spent.
  const request = image
    ? ask(image, pipe, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        console.error('[diary]', error);
        pipe.push('The ink runs thin just now. Write to me again in a moment.');
        pipe.end();
      })
    : Promise.resolve(pipe.end());

  await absorb(fluxCanvas, bounds, dpr, 1250);
  quill.reset();

  if (controller.signal.aborted) {
    state = 'idle';
    quill.setEnabled(true);
    return;
  }

  await reply(pipe);
  await request.catch(() => {});
  inflight = null;
}

async function reply(pipe) {
  state = 'replying';

  const gap = Math.round(type.lineHeight * 0.9);
  if (flowBottom + gap + type.ascent + type.descent > view.bottom) {
    await turnPage();
  }

  const startY = Math.max(view.top + type.ascent, flowBottom + gap + type.ascent);

  scribe = new Scribe({ flux: fluxCanvas, page: pageCanvas, dpr });
  scribe.configure({
    size: type.size,
    ascent: type.ascent,
    descent: type.descent,
    lineHeight: type.lineHeight,
    width: view.width,
    speed: settings.speed,
  });

  const written = [];
  const mine = scribe;

  await new Promise((resolve) => {
    scribe.begin({
      x: view.x,
      y: startY,
      floor: view.bottom,
      needRoom: async () => {
        const room = await turnPage();
        return room;
      },
      onDone: resolve,
    });

    pipe.attach(
      (text) => {
        written.push(text);
        scribe.feed(text);
      },
      () => scribe.seal(),
    );
  });

  // A new diary may have been started while this one was still writing; if so
  // this reply belongs to a book that no longer exists.
  if (scribe !== mine) return;

  flowBottom = Math.max(flowBottom, mine.bottomY);

  const said = written.join('').trim();
  history.push({
    role: 'user',
    content: pipe.transcript || '(a page of writing, unreadable to anyone but him)',
  });
  if (said) history.push({ role: 'assistant', content: said });
  saveHistory();

  scribe = null;
  state = 'idle';
  quill.setEnabled(true);

  if (pendingLayout) {
    pendingLayout = false;
    layout();
  }
}

// ---------------------------------------------------------------- input wiring

const quill = new Quill(fluxCanvas, {
  onStroke: disarm,
  onRest: armIdle,
  onExtent: (bounds) => {
    flowBottom = Math.max(flowBottom, bounds.bottom);
  },
});

// A tap on the page while it is writing tells the hand to get on with it.
fluxCanvas.addEventListener(
  'pointerdown',
  (event) => {
    if (state === 'replying' && scribe) {
      scribe.hasten();
      event.preventDefault();
    }
  },
  { capture: true },
);

// Two fingers at once always commits, whatever the pause setting says.
const touching = new Set();
fluxCanvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return;
  touching.add(event.pointerId);
  if (touching.size >= 2 && state === 'idle' && quill.hasInk) commit();
});
for (const kind of ['pointerup', 'pointercancel', 'pointerleave']) {
  fluxCanvas.addEventListener(kind, (event) => touching.delete(event.pointerId));
}

// ---------------------------------------------------------------- settings UI

const panel = document.getElementById('panel');
const ledger = document.getElementById('ledger');
const corner = document.getElementById('corner');

const optSpeed = document.getElementById('opt-speed');
const optIdle = document.getElementById('opt-idle');
const optTouch = document.getElementById('opt-touch');

optSpeed.value = String(settings.speed);
optIdle.value = String(settings.idle);
optTouch.checked = settings.touch;
quill.allowTouch = settings.touch;

optSpeed.addEventListener('change', () => {
  settings.speed = Number(optSpeed.value);
  saveSettings();
});
optIdle.addEventListener('change', () => {
  settings.idle = Number(optIdle.value);
  saveSettings();
});
optTouch.addEventListener('change', () => {
  settings.touch = optTouch.checked;
  quill.allowTouch = settings.touch;
  saveSettings();
});

let pressTimer = null;
let pressedRecently = false;

corner.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  pressedRecently = true;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => openPanel(), 620);
});
for (const kind of ['pointerup', 'pointercancel', 'pointerleave']) {
  corner.addEventListener(kind, () => {
    clearTimeout(pressTimer);
    setTimeout(() => {
      pressedRecently = false;
    }, 400);
  });
}
corner.addEventListener('click', () => {
  // Keyboard activation only — a pointer press is handled by the hold above.
  if (!pressedRecently) openPanel();
});

function openPanel() {
  disarm();
  document.getElementById('state-note').textContent = note;
  panel.hidden = false;
}

document.getElementById('act-close').addEventListener('click', () => {
  panel.hidden = true;
  armIdle();
});

document.getElementById('act-new').addEventListener('click', () => {
  history = [];
  saveHistory();
  inflight?.abort();
  scribe?.stop();
  scribe = null;
  disarm();
  pageCtx.clearRect(0, 0, view.w, view.h);
  fluxCtx.clearRect(0, 0, view.w, view.h);
  quill.reset();
  quill.setEnabled(true);
  state = 'idle';
  flowBottom = view.top;
  panel.hidden = true;
});

document.getElementById('act-ledger').addEventListener('click', () => {
  const body = document.getElementById('ledger-body');
  body.textContent = '';
  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'Nothing yet. The page is waiting.';
    body.append(empty);
  }
  for (const entry of history) {
    const div = document.createElement('div');
    div.className = `entry ${entry.role === 'assistant' ? 'him' : 'me'}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = entry.role === 'assistant' ? 'T. M. Riddle' : 'You wrote';
    const text = document.createElement('span');
    text.textContent = entry.content;
    div.append(who, text);
    body.append(div);
  }
  panel.hidden = true;
  ledger.hidden = false;
});

document.getElementById('ledger-close').addEventListener('click', () => {
  ledger.hidden = true;
  armIdle();
});

// ---------------------------------------------------------------- boot

let note = '';

async function readState() {
  try {
    const info = await fetch('/api/state').then((r) => r.json());
    note = info.hollow
      ? 'No key is set, so the diary is answering from memory alone. Add ANTHROPIC_API_KEY to .env and restart to wake it properly.'
      : `Answering with ${info.model}${info.fast ? ', in fast mode' : ''}.`;
  } catch {
    note = 'The diary cannot reach its own memory just now.';
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Never re-measure mid-sentence; catch up once the hand has stopped.
    if (state === 'replying') {
      pendingLayout = true;
      return;
    }
    layout();
  }, 180);
});

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

async function boot() {
  // Wait for the script face to load so the first reply is not measured against
  // a fallback and then re-laid out.
  if (document.fonts?.ready) {
    try {
      await document.fonts.load('40px "Petit Formal Script"');
    } catch {
      /* the system script face will do */
    }
    await document.fonts.ready;
  }
  layout();
  readState();
}

boot();
