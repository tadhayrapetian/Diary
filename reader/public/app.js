/**
 * The shell: the desk, the shelf, the panels, and the wiring between the page
 * you are reading and the work going on behind it.
 *
 * Work is a job on the server, not a request from this tab. Starting one hands
 * back an id; the page attaches to that id and can attach again later. Closing
 * the tab in the middle of a book costs nothing.
 */

import { Reader, sentenceAround } from './reader.js';
import { SavedWords, WordCard, canSpeak } from './lookup.js';
import { readingMinutes } from './blocks.js';

const $ = (id) => document.getElementById(id);

const el = {
  body: document.body,
  desk: $('desk'),
  reading: $('reading'),
  intake: $('intake'),
  source: $('source'),
  dropHint: $('dropHint'),
  file: $('file'),
  fileCard: $('fileCard'),
  fileName: $('fileName'),
  fileIcon: $('fileIcon'),
  fileFacts: $('fileFacts'),
  fileClear: $('fileClear'),
  modes: $('modes'),
  direction: $('direction'),
  fromLang: $('fromLang'),
  intoLang: $('intoLang'),
  swap: $('swap'),
  estimate: $('estimate'),
  go: $('go'),
  note: $('intakeNote'),
  running: $('running'),
  runningTitle: $('runningTitle'),
  runningFacts: $('runningFacts'),
  runningMeter: $('runningMeter'),
  runningOpen: $('runningOpen'),
  runningStop: $('runningStop'),
  shelf: $('shelf'),
  shelfList: $('shelfList'),
  engine: $('engine'),
  article: $('article'),
  glossary: $('glossary'),
  glossaryList: $('glossaryList'),
  toc: $('toc'),
  tocToggle: $('tocToggle'),
  facingToggle: $('facingToggle'),
  barTitle: $('barTitle'),
  barStatus: $('barStatus'),
  back: $('back'),
  progress: $('progress').firstElementChild,
  articleEnd: $('articleEnd'),
  endNote: $('endNote'),
  card: $('card'),
  cardScrim: $('cardScrim'),
  panelScrim: $('panelScrim'),
  wordsPanel: $('wordsPanel'),
  wordsList: $('wordsList'),
  wordsEmpty: $('wordsEmpty'),
  wordsExport: $('wordsExport'),
  wordsClear: $('wordsClear'),
  settingsPanel: $('settingsPanel'),
  setLang: $('setLang'),
  setTheme: $('setTheme'),
  setSize: $('setSize'),
  setMeasure: $('setMeasure'),
  setJustify: $('setJustify'),
  setHighlight: $('setHighlight'),
  sizeValue: $('sizeValue'),
  measureValue: $('measureValue'),
  settingsNote: $('settingsNote'),
  selectionCue: $('selectionCue'),
  selectionLook: $('selectionLook'),
};

const LANGUAGES = [
  ['ru', 'Russian'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
  ['fa', 'Persian'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
  ['sv', 'Swedish'], ['cs', 'Czech'], ['el', 'Greek'], ['ro', 'Romanian'],
  ['hu', 'Hungarian'], ['hy', 'Armenian'], ['ka', 'Georgian'], ['sr', 'Serbian'],
  ['bg', 'Bulgarian'], ['kk', 'Kazakh'], ['az', 'Azerbaijani'], ['la', 'Latin'],
];
const nameOf = (code) => LANGUAGES.find(([c]) => c === code)?.[1] || code;

// ------------------------------------------------------------------ settings

const SETTINGS_KEY = 'lectern.settings.v1';

const defaults = {
  targetLang: 'ru',
  theme: 'auto',
  size: 20,
  measure: 34,
  justify: false,
  markSaved: true,
  showSource: true,
};

function loadSettings() {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch {
    return { ...defaults };
  }
}

let settings = loadSettings();

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  root.style.setProperty('--size', `${settings.size}px`);
  root.style.setProperty('--measure', `${settings.measure}rem`);
  root.style.setProperty('--align', settings.justify ? 'justify' : 'left');
  el.body.classList.toggle('mark-saved', settings.markSaved);
  el.body.classList.toggle('hide-source', !settings.showSource);
  el.facingToggle.classList.toggle('on', settings.showSource);

  el.sizeValue.textContent = `${settings.size}px`;
  el.measureValue.textContent = `${settings.measure} rem`;
  el.setSize.value = settings.size;
  el.setMeasure.value = settings.measure;
  el.setJustify.checked = settings.justify;
  el.setHighlight.checked = settings.markSaved;
  el.setLang.value = settings.targetLang;
  for (const chip of el.setTheme.querySelectorAll('button')) {
    chip.setAttribute('aria-checked', String(chip.dataset.theme === settings.theme));
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: the settings simply will not persist */
  }
}

// --------------------------------------------------------------------- state

const saved = new SavedWords();

const state = {
  mode: 'typeset',
  fromLang: 'en',
  source: null, // what /api/extract found: token, words, pieces, meta
  jobId: null,
  articleLang: '',
  originalLang: '',
  title: '',
  streaming: false,
  attached: null,
  local: false,
  fast: false,
  armed: false, // a long job has been asked about and is waiting on a second click
};

const readingLine = (words, minutes) =>
  `${words.toLocaleString()} words · about ${minutes} minute${minutes === 1 ? '' : 's'}`;

const card = new WordCard({
  element: el.card,
  scrim: el.cardScrim,
  saved,
  onSavedChange: () => {
    reader.markSaved((word) => saved.has(word));
    drawWords();
  },
});

const reader = new Reader({
  article: el.article,
  glossary: el.glossary,
  glossaryList: el.glossaryList,
  toc: el.toc,
  onMeta: ({ title }) => {
    state.title = title;
    el.barTitle.textContent = title;
    document.title = `${title} — Lectern`;
  },
  onHeadings: (count) => {
    el.tocToggle.hidden = count < 3;
  },
  onFacing: (facing) => {
    el.facingToggle.hidden = !facing;
  },
  onWord: (element, override) => {
    const word = (override || element.textContent || '').trim();
    if (!word) return;

    // On facing pages the two columns are in different languages, so which one
    // the word came from decides both what it is and what to render it into.
    const inOriginal = Boolean(element.closest?.('.a-src'));
    const wordLang = (inOriginal ? state.originalLang : state.articleLang) || 'en';
    const into =
      wordLang.slice(0, 2) === settings.targetLang.slice(0, 2)
        ? state.originalLang || 'en'
        : settings.targetLang;

    card.open(element, {
      word,
      sentence: override ? '' : sentenceAround(element),
      title: state.title,
      sourceLang: wordLang,
      targetLang: into,
    });
  },
});

// ------------------------------------------------------- estimating the work

/**
 * Published Claude Opus 5 rates, in dollars per million tokens. A book is not a
 * free thing to translate and the reader deserves the number before the click,
 * not on a statement at the end of the month.
 */
const RATE = { input: 5, output: 25 };
/** Roughly what a streamed reply manages, in tokens a second. */
const TOKENS_PER_SECOND = 70;

function estimate(words, mode) {
  const input = words * 1.4;
  // Translating runs longer than the original, and Cyrillic costs more tokens
  // per character than Latin; facing pages emit the original as well.
  const factor = mode === 'bilingual' ? 2.6 : mode === 'translate' ? 1.7 : 1.15;
  const output = input * factor;
  const dollars = (input * RATE.input + output * RATE.output) / 1e6;
  const seconds = (output / TOKENS_PER_SECOND) * (state.fast ? 0.45 : 1);
  return { dollars, minutes: Math.max(1, Math.round(seconds / 60)) };
}

const money = (dollars) =>
  dollars < 0.1 ? 'a few cents' : dollars < 1 ? `about $${dollars.toFixed(2)}` : `about $${dollars.toFixed(dollars < 10 ? 1 : 0)}`;

function drawEstimate() {
  const source = state.source;
  if (!source || !source.words) {
    el.estimate.hidden = true;
    return;
  }
  const pieces = source.pieces?.[state.mode] ?? 1;
  const { dollars, minutes } = estimate(source.words, state.mode);
  const heavy = minutes >= 10 || dollars >= 1;

  const parts = [`<b>${source.words.toLocaleString()}</b> words`];
  if (source.pages) parts.push(`${source.pages} pages`);
  if (state.mode === 'typeset' && !heavy) {
    parts.push(`about ${readingMinutes(source.words)} minutes to read`);
  }
  if (pieces > 1) parts.push(`${pieces} pieces`);
  if (!state.local) {
    parts.push(`roughly <b>${minutes} min</b> of work`);
    parts.push(`${money(dollars)} at current rates`);
  }

  el.estimate.innerHTML = parts.join(' · ');
  el.estimate.classList.toggle('heavy', heavy && !state.local);
  el.estimate.hidden = false;
  state.heavy = heavy && !state.local;
  disarm();
}

function disarm() {
  state.armed = false;
  el.go.textContent =
    state.mode === 'typeset'
      ? 'Set it in type'
      : state.mode === 'bilingual'
        ? `Translate it facing the original`
        : `Translate it into ${nameOf(settings.targetLang)}`;
}

// --------------------------------------------------------------------- shelf

async function drawShelf() {
  let pieces = [];
  try {
    pieces = (await (await fetch('/api/library')).json()).pieces || [];
  } catch {
    pieces = [];
  }

  const running = pieces.find((piece) => piece.status === 'running');
  el.running.hidden = !running;
  if (running) {
    state.runningId = running.id;
    el.runningTitle.textContent = running.title || 'Working…';
    const done = running.progress?.piece || 0;
    const of = running.progress?.of || running.pieces || 1;
    el.runningFacts.textContent =
      done > 0
        ? `${labelFor(running.mode, running)} · piece ${done} of ${of}`
        : `${labelFor(running.mode, running)} · reading it through first`;
    el.runningMeter.classList.toggle('waiting', done === 0);
    el.runningMeter.style.width = done > 0 ? `${Math.round((done / of) * 100)}%` : '';
  }

  const shelved = pieces.filter((piece) => piece.status !== 'running');
  el.shelf.hidden = !shelved.length;
  el.shelfList.textContent = '';

  for (const piece of shelved) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'shelf-item';
    const title = document.createElement('b');
    title.textContent = piece.title || 'Untitled';
    const facts = document.createElement('span');
    facts.textContent =
      piece.status === 'done'
        ? labelFor(piece.mode, piece)
        : `${labelFor(piece.mode, piece)} · unfinished`;
    open.append(title, facts);
    open.addEventListener('click', () => openShelved(piece.id));

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'shelf-drop';
    drop.textContent = '×';
    drop.title = 'Take it off the shelf';
    drop.addEventListener('click', async (event) => {
      event.stopPropagation();
      await fetch(`/api/library/${piece.id}`, { method: 'DELETE' });
      drawShelf();
    });

    row.append(open, drop);
    li.append(row);
    el.shelfList.append(li);
  }
}

const labelFor = (mode, piece) =>
  mode === 'typeset'
    ? 'set in type'
    : `${nameOf(piece.sourceLang)} → ${nameOf(piece.targetLang)}${
        mode === 'bilingual' ? ', facing' : ''
      }`;

// ------------------------------------------------------------------ the wire

/** Attach to a job and follow it until it ends or this page looks away. */
async function follow(id, { onStart } = {}) {
  state.attached?.abort();
  const controller = new AbortController();
  state.attached = controller;
  state.jobId = id;
  state.streaming = true;

  let finished = false;
  try {
    const response = await fetch(`/api/job/${id}`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);

    const stream = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let name = '';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!name || !data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }

        if (name === 'start') {
          state.articleLang = payload.mode === 'typeset' ? payload.sourceLang : payload.targetLang;
          state.originalLang = payload.sourceLang;
          reader.setMode(payload.mode, payload.sourceLang);
          onStart?.(payload);
        } else if (name === 'text') {
          reader.push(payload.text);
          markSavedSoon();
        } else if (name === 'progress') {
          el.barStatus.textContent = payload.surveying
            ? 'reading it through'
            : payload.of > 1
              ? `piece ${payload.piece} of ${payload.of}`
              : 'working';
        } else if (name === 'done' || name === 'failed') {
          finished = true;
          if (name === 'failed' && payload.message) el.endNote.textContent = payload.message;
          break;
        }
      }
      if (finished) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      el.endNote.textContent = `Lost touch with the server: ${error.message}`;
      finished = true;
    }
  } finally {
    if (state.attached === controller) state.attached = null;
    state.streaming = false;
  }

  if (!finished) return;

  el.barStatus.textContent = '';
  const summary = reader.end();
  reader.markSaved((word) => saved.has(word));
  el.articleEnd.hidden = false;
  if (!el.endNote.textContent) {
    el.endNote.textContent = readingLine(summary.words, summary.minutes);
  }
  updateProgress();
  drawShelf();
}

async function start() {
  const source = state.source;
  const body = {
    mode: state.mode,
    sourceToken: source?.sourceToken || '',
    text: source?.sourceToken ? '' : el.source.value.trim(),
    meta: source?.meta || {},
    sourceLang: state.fromLang,
    targetLang: settings.targetLang,
  };

  let started;
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    started = await response.json();
    if (!response.ok) throw new Error(started.error || `the server answered ${response.status}`);
  } catch (error) {
    say(error.message, true);
    return;
  }

  reader.reset();
  reader.setMode(state.mode, state.fromLang);
  el.endNote.textContent = '';
  el.articleEnd.hidden = true;
  showReading();
  el.barStatus.textContent = 'starting';
  follow(started.id);
}

async function openShelved(id) {
  let piece;
  try {
    piece = await (await fetch(`/api/library/${id}`)).json();
  } catch {
    say('That piece could not be opened.', true);
    return;
  }
  state.articleLang = piece.mode === 'typeset' ? piece.sourceLang : piece.targetLang;
  state.originalLang = piece.sourceLang;
  state.jobId = id;

  showReading();
  reader.setMode(piece.mode, piece.sourceLang);
  reader.render(piece.protocol || '');
  reader.markSaved((word) => saved.has(word));

  const summary = reader.finish();
  state.title = summary.title || piece.title || '';
  el.barTitle.textContent = state.title;
  document.title = state.title ? `${state.title} — Lectern` : 'Lectern';
  el.endNote.textContent =
    piece.status === 'done'
      ? readingLine(summary.words, summary.minutes)
      : piece.message || 'This was never finished.';
  el.articleEnd.hidden = false;
  updateProgress();
}

// ------------------------------------------------------------------- screens

function showReading() {
  el.desk.hidden = true;
  el.reading.hidden = false;
  el.body.dataset.screen = 'reading';
  el.toc.hidden = true;
  el.tocToggle.classList.remove('on');
  window.scrollTo(0, 0);
  updateProgress();
}

function showDesk() {
  state.attached?.abort();
  state.attached = null;
  state.streaming = false;
  card.close();
  el.reading.hidden = true;
  el.desk.hidden = false;
  el.body.dataset.screen = 'desk';
  el.barStatus.textContent = '';
  document.title = 'Lectern';
  drawShelf();
  window.scrollTo(0, 0);
}

function updateProgress() {
  const total = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = total > 40 ? Math.min(1, Math.max(0, window.scrollY / total)) : 0;
  el.progress.style.width = `${ratio * 100}%`;
  el.progress.style.opacity = el.body.dataset.screen === 'reading' ? '1' : '0';
  el.body.classList.toggle('scrolled', window.scrollY > 30);
}

window.addEventListener('scroll', updateProgress, { passive: true });
window.addEventListener('resize', updateProgress);

/**
 * Marking saved words walks every word on the page, so while the article is
 * still arriving it runs on a timer rather than on every chunk.
 */
let markTimer = 0;
function markSavedSoon() {
  if (markTimer) return;
  markTimer = setTimeout(() => {
    markTimer = 0;
    reader.markSaved((word) => saved.has(word));
  }, 500);
}

// -------------------------------------------------------------------- intake

function say(message, bad = false) {
  el.note.textContent = message || '';
  el.note.classList.toggle('bad', Boolean(bad));
}

const prettyBytes = (n) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function clearSource() {
  state.source = null;
  el.fileCard.hidden = true;
  el.file.value = '';
  el.source.disabled = false;
  el.estimate.hidden = true;
  say('');
  disarm();
}

function tookSource(result, { name, size } = {}) {
  state.source = result;
  if (result.lang) {
    state.fromLang = result.lang;
    el.fromLang.value = result.lang;
    if (result.lang === settings.targetLang) {
      // Nobody wants a translation from Russian into Russian; offer the swap.
      settings.targetLang = result.lang === 'en' ? 'ru' : 'en';
      el.intoLang.value = settings.targetLang;
      el.setLang.value = settings.targetLang;
      applySettings();
    }
  }
  if (name) {
    el.fileName.textContent = name;
    el.fileIcon.textContent = (name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
    el.fileFacts.textContent = result.canRead
      ? `${result.pages || '?'} pages · a scan, so it will be read by eye`
      : [size ? prettyBytes(size) : '', result.pages ? `${result.pages} pages` : '', result.lang ? nameOf(result.lang) : '']
          .filter(Boolean)
          .join(' · ');
    el.fileCard.hidden = false;
    el.source.disabled = true;
  }
  drawEstimate();
  if (result.truncated) say('Very long — only the first part will be used.');
}

async function takeFile(file) {
  if (!file) return;
  clearSource();
  el.fileName.textContent = file.name;
  el.fileIcon.textContent = (file.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
  el.fileFacts.textContent = `${prettyBytes(file.size)} · reading…`;
  el.fileCard.hidden = false;
  el.source.disabled = true;
  el.go.disabled = true;

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
      },
      body: await file.arrayBuffer(),
    });
    const result = await response.json();
    if (!result.ok && !result.canRead) {
      el.fileFacts.textContent = result.reason || 'could not be read';
      say(result.reason || 'That file could not be read.', true);
      return;
    }
    tookSource(result, { name: file.name, size: file.size });
  } catch (error) {
    el.fileFacts.textContent = 'could not be read';
    say(`That file could not be read: ${error.message}`, true);
  } finally {
    el.go.disabled = false;
  }
}

async function takeUrl(url) {
  say('Fetching that page…');
  const result = await (
    await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  ).json();
  if (!result.ok && !result.canRead) {
    say(result.reason || 'That page could not be read.', true);
    return null;
  }
  say('');
  tookSource(result, { name: result.meta?.name || 'page', size: 0 });
  return result;
}

el.intake.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.streaming) return;

  const typed = el.source.value.trim();

  if (!state.source && /^https?:\/\/\S+$/i.test(typed)) {
    el.go.disabled = true;
    try {
      if (!(await takeUrl(typed))) return;
    } finally {
      el.go.disabled = false;
    }
    return; // the estimate is now on screen; the next click starts it
  }

  if (!state.source && typed.length < 2) {
    say('Put something in first — paste some text, or choose a file.', true);
    el.source.focus();
    return;
  }

  // Something that will take twenty minutes and real money gets asked about.
  if (state.heavy && !state.armed) {
    state.armed = true;
    el.go.textContent = 'Yes — start it';
    say('It will keep going if you close this page. Come back and it will be here.');
    return;
  }

  if (!state.source && typed) {
    state.fromLang = el.fromLang.value || state.fromLang;
  }
  await start();
});

el.file.addEventListener('change', (event) => takeFile(event.target.files?.[0]));
el.fileClear.addEventListener('click', clearSource);
/** The server's own chunk sizes, so pasted text can be sized up before it goes. */
const CHUNK_CHARS = { typeset: 24_000, translate: 30_000, bilingual: 18_000 };

let typingTimer = 0;
el.source.addEventListener('input', () => {
  if (el.source.disabled) return;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const text = el.source.value.trim();
    if (text.length < 400 || /^https?:\/\/\S+$/i.test(text)) {
      state.source = null;
      el.estimate.hidden = true;
      disarm();
      return;
    }
    const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
    state.source = {
      words,
      pages: 0,
      pieces: Object.fromEntries(
        Object.entries(CHUNK_CHARS).map(([mode, size]) => [
          mode,
          Math.max(1, Math.ceil(text.length / size)),
        ]),
      ),
      sourceToken: '',
      meta: {},
      lang: '',
    };
    drawEstimate();
  }, 350);
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (el.body.dataset.screen !== 'desk') return;
  event.preventDefault();
  dragDepth++;
  el.body.classList.add('dragging');
  el.dropHint.hidden = false;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.body.classList.remove('dragging');
    el.dropHint.hidden = true;
  }
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  el.body.classList.remove('dragging');
  el.dropHint.hidden = true;
  if (el.body.dataset.screen !== 'desk') return;
  const file = event.dataTransfer?.files?.[0];
  if (file) takeFile(file);
});

// --------------------------------------------------------------------- modes

el.modes.addEventListener('click', (event) => {
  const chip = event.target.closest('button');
  if (!chip || chip.disabled) return;
  state.mode = chip.dataset.mode;
  for (const other of el.modes.querySelectorAll('button')) {
    other.setAttribute('aria-checked', String(other === chip));
  }
  el.direction.hidden = state.mode === 'typeset';
  drawEstimate();
  disarm();
});

el.swap.addEventListener('click', () => {
  const from = el.fromLang.value;
  el.fromLang.value = settings.targetLang;
  state.fromLang = settings.targetLang;
  settings.targetLang = from;
  el.intoLang.value = from;
  el.setLang.value = from;
  card.cache.clear();
  applySettings();
  drawEstimate();
});

el.fromLang.addEventListener('change', () => {
  state.fromLang = el.fromLang.value;
  disarm();
});
el.intoLang.addEventListener('change', () => {
  settings.targetLang = el.intoLang.value;
  el.setLang.value = settings.targetLang;
  card.cache.clear();
  applySettings();
  disarm();
});

// ------------------------------------------------------------- work in flight

el.runningOpen.addEventListener('click', () => {
  if (!state.runningId) return;
  reader.reset();
  el.endNote.textContent = '';
  el.articleEnd.hidden = true;
  showReading();
  follow(state.runningId);
});

el.runningStop.addEventListener('click', async () => {
  if (!state.runningId) return;
  await fetch(`/api/job/${state.runningId}/cancel`, { method: 'POST' });
  drawShelf();
});

// -------------------------------------------------------------------- panels

function openPanel(panel) {
  el.panelScrim.hidden = false;
  panel.hidden = false;
}

function closePanels() {
  el.panelScrim.hidden = true;
  el.wordsPanel.hidden = true;
  el.settingsPanel.hidden = true;
}

el.panelScrim.addEventListener('click', closePanels);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', closePanels);
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePanels();
});

function drawWords() {
  const items = saved.all();
  el.wordsEmpty.hidden = items.length > 0;
  el.wordsList.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    const word = document.createElement('b');
    word.textContent = item.word;
    const gloss = document.createElement('span');
    gloss.textContent = item.translation || item.meaning || '';
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.textContent = '×';
    drop.setAttribute('aria-label', `Forget ${item.word}`);
    drop.addEventListener('click', () => {
      saved.remove(item.word);
      drawWords();
      reader.markSaved((w) => saved.has(w));
    });
    li.append(word, gloss, drop);
    el.wordsList.append(li);
  }
}

el.wordsExport.addEventListener('click', () => {
  const tsv = saved.toTsv();
  if (!tsv) return;
  const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'lectern-words.tsv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});

el.wordsClear.addEventListener('click', () => {
  if (!saved.all().length) return;
  saved.clear();
  drawWords();
  reader.markSaved(() => false);
});

// ------------------------------------------------------------------ controls

el.back.addEventListener('click', showDesk);

el.tocToggle.addEventListener('click', () => {
  const showing = el.toc.hidden;
  el.toc.hidden = !showing;
  el.tocToggle.classList.toggle('on', showing);
});
el.toc.addEventListener('click', (event) => {
  if (event.target.tagName === 'A') {
    el.toc.hidden = true;
    el.tocToggle.classList.remove('on');
  }
});

el.facingToggle.addEventListener('click', () => {
  settings.showSource = !settings.showSource;
  applySettings();
});

for (const trigger of [$('wordsToggle'), $('deskWords')]) {
  trigger.addEventListener('click', () => {
    drawWords();
    openPanel(el.wordsPanel);
  });
}
for (const trigger of [$('settingsToggle'), $('deskSettings')]) {
  trigger.addEventListener('click', () => openPanel(el.settingsPanel));
}

for (const select of [el.setLang, el.fromLang, el.intoLang]) {
  for (const [code, name] of LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    select.append(option);
  }
}

el.setLang.addEventListener('change', () => {
  settings.targetLang = el.setLang.value;
  el.intoLang.value = settings.targetLang;
  card.cache.clear();
  applySettings();
  disarm();
});
el.setTheme.addEventListener('click', (event) => {
  const chip = event.target.closest('button');
  if (!chip) return;
  settings.theme = chip.dataset.theme;
  applySettings();
});
el.setSize.addEventListener('input', () => {
  settings.size = Number(el.setSize.value);
  applySettings();
});
el.setMeasure.addEventListener('input', () => {
  settings.measure = Number(el.setMeasure.value);
  applySettings();
});
el.setJustify.addEventListener('change', () => {
  settings.justify = el.setJustify.checked;
  applySettings();
});
el.setHighlight.addEventListener('change', () => {
  settings.markSaved = el.setHighlight.checked;
  applySettings();
});

// ------------------------------------------------- looking up a whole phrase

let selectionAnchor = null;

function hideCue() {
  el.selectionCue.hidden = true;
  selectionAnchor = null;
}

document.addEventListener('selectionchange', () => {
  if (el.body.dataset.screen !== 'reading') return hideCue();
  const selection = document.getSelection();
  const text = selection?.toString().trim() || '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!text || words.length < 2 || words.length > 14 || text.length > 200) return hideCue();
  if (!selection.anchorNode || !el.article.contains(selection.anchorNode)) return hideCue();

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width) return hideCue();
  el.selectionCue.hidden = false;
  el.selectionCue.style.left = `${Math.max(
    8,
    Math.min(rect.left + rect.width / 2 - 45, window.innerWidth - 100),
  )}px`;
  el.selectionCue.style.top = `${Math.max(8, rect.top - 42)}px`;
  selectionAnchor = { text };
});

el.selectionLook.addEventListener('mousedown', (event) => event.preventDefault());
el.selectionLook.addEventListener('click', () => {
  if (!selectionAnchor) return;
  const phrase = selectionAnchor.text;
  const anchorNode = document.getSelection()?.anchorNode;
  const holder =
    (anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement)?.closest('w-') ||
    el.article;
  hideCue();
  reader.onWord(holder, phrase);
});

// ----------------------------------------------------------------------- boot

async function boot() {
  applySettings();
  drawWords();
  disarm();

  try {
    const server = await (await fetch('/api/state')).json();
    state.local = server.local;
    state.fast = server.fast;
    if (server.targetLang && !localStorage.getItem(SETTINGS_KEY)) {
      settings.targetLang = server.targetLang;
      applySettings();
    }
    el.intoLang.value = settings.targetLang;
    el.fromLang.value = state.fromLang;

    if (server.local) {
      for (const chip of el.modes.querySelectorAll('[data-mode]:not([data-mode="typeset"])')) {
        chip.disabled = true;
        chip.title = 'Translating needs an API key in .env';
      }
      el.engine.textContent =
        'Plain typesetting only — add a key in .env to translate and to look words up.';
    } else {
      el.engine.textContent = `${server.model}${server.fast ? ', fast' : ''}.`;
    }
  } catch {
    el.engine.textContent = 'The server is not answering.';
  }

  await drawShelf();
  if (!canSpeak()) el.settingsNote.textContent = 'This browser cannot read words aloud.';
  el.source.focus();

  // Keep the desk honest about work still going on behind it.
  setInterval(() => {
    if (el.body.dataset.screen === 'desk' && state.runningId) drawShelf();
  }, 4000);
}

boot();
