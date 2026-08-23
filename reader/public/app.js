/**
 * The shell: the desk, the shelf, the panels, and the wiring between the page
 * you are reading and the server that set it.
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
  drop: $('drop'),
  dropHint: $('dropHint'),
  file: $('file'),
  fileCard: $('fileCard'),
  fileName: $('fileName'),
  fileIcon: $('fileIcon'),
  fileFacts: $('fileFacts'),
  fileClear: $('fileClear'),
  go: $('go'),
  note: $('intakeNote'),
  shelf: $('shelf'),
  shelfList: $('shelfList'),
  engine: $('engine'),
  article: $('article'),
  glossary: $('glossary'),
  glossaryList: $('glossaryList'),
  toc: $('toc'),
  tocToggle: $('tocToggle'),
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

// ------------------------------------------------------------------ settings

const SETTINGS_KEY = 'lectern.settings.v1';
const SHELF_KEY = 'lectern.shelf.v1';

const LANGUAGES = [
  ['ru', 'Russian'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
  ['fa', 'Persian'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
  ['sv', 'Swedish'], ['cs', 'Czech'], ['el', 'Greek'], ['ro', 'Romanian'],
  ['hu', 'Hungarian'], ['hy', 'Armenian'], ['ka', 'Georgian'], ['sr', 'Serbian'],
  ['bg', 'Bulgarian'], ['kk', 'Kazakh'], ['az', 'Azerbaijani'],
];

const defaults = {
  targetLang: 'ru',
  theme: 'auto',
  size: 20,
  measure: 34,
  justify: false,
  markSaved: true,
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

// --------------------------------------------------------------------- shelf

function loadShelf() {
  try {
    return JSON.parse(localStorage.getItem(SHELF_KEY)) || [];
  } catch {
    return [];
  }
}

function saveShelf(items) {
  // Keep the shelf under the storage cap by dropping the oldest pieces first.
  let kept = items.slice(0, 40);
  for (;;) {
    try {
      localStorage.setItem(SHELF_KEY, JSON.stringify(kept));
      return kept;
    } catch {
      if (kept.length <= 1) return kept;
      kept = kept.slice(0, Math.max(1, kept.length - 3));
    }
  }
}

function shelvePiece(piece) {
  const items = loadShelf().filter((item) => item.id !== piece.id);
  items.unshift(piece);
  drawShelf(saveShelf(items));
}

function drawShelf(items = loadShelf()) {
  el.shelfList.textContent = '';
  el.shelf.hidden = !items.length;
  for (const item of items) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'shelf-item';
    const title = document.createElement('b');
    title.textContent = item.title || 'Untitled';
    const facts = document.createElement('span');
    facts.textContent = `${item.minutes} min`;
    open.append(title, facts);
    open.addEventListener('click', () => openShelved(item));

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'shelf-drop';
    drop.textContent = '×';
    drop.title = 'Take it off the shelf';
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      drawShelf(saveShelf(loadShelf().filter((other) => other.id !== item.id)));
    });

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.append(open, drop);
    li.append(row);
    el.shelfList.append(li);
  }
}

// ------------------------------------------------------------------- reading

const readingLine = (words, minutes) =>
  `${words.toLocaleString()} words · about ${minutes} minute${minutes === 1 ? '' : 's'}`;

const saved = new SavedWords();

const state = {
  title: '',
  sourceLang: 'en',
  piece: null,
  streaming: false,
  abort: null,
};

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
  onWord: (element, override) => {
    const word = (override || element.textContent || '').trim();
    if (!word) return;
    card.open(element, {
      word,
      sentence: override ? '' : sentenceAround(element),
      title: state.title,
      sourceLang: state.sourceLang,
      targetLang: settings.targetLang,
    });
  },
});

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

/**
 * Which language is this written in? Enough of an answer to pick a voice and
 * tell the dictionary what it is looking at.
 */
function guessLanguage(text) {
  const sample = text.slice(0, 4000);
  const scripts = [
    [/[Ѐ-ӿ]/g, 'ru'], [/[Ͱ-Ͽ]/g, 'el'],
    [/[֐-׿]/g, 'he'], [/[؀-ۿ]/g, 'ar'],
    [/[԰-֏]/g, 'hy'], [/[Ⴀ-ჿ]/g, 'ka'],
    [/[ऀ-ॿ]/g, 'hi'], [/[぀-ヿ]/g, 'ja'],
    [/[가-힯]/g, 'ko'], [/[一-鿿]/g, 'zh'],
  ];
  for (const [pattern, code] of scripts) {
    if ((sample.match(pattern) || []).length > sample.length * 0.08) return code;
  }
  const words = sample.toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  const counts = { en: 0, es: 0, fr: 0, de: 0, it: 0, pt: 0, nl: 0 };
  const markers = {
    en: ['the', 'and', 'of', 'that', 'with', 'was'],
    es: ['que', 'los', 'las', 'por', 'una', 'del'],
    fr: ['les', 'des', 'est', 'une', 'dans', 'pour'],
    de: ['und', 'der', 'die', 'das', 'nicht', 'mit'],
    it: ['che', 'gli', 'per', 'con', 'una', 'del'],
    pt: ['que', 'nao', 'uma', 'com', 'dos', 'para'],
    nl: ['het', 'een', 'van', 'niet', 'dat', 'zijn'],
  };
  for (const word of words) {
    for (const [code, list] of Object.entries(markers)) {
      if (list.includes(word)) counts[code]++;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 3 ? best[0] : 'en';
}

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
  state.abort?.abort();
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

// ------------------------------------------------------------------ the wire

async function streamEvents(url, body, handlers, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `the server answered ${response.status}`);
  }

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
      let name = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        handlers[name]?.(JSON.parse(data));
      } catch {
        /* a frame we cannot read is a frame we can skip */
      }
    }
  }
}

async function typeset({ text, meta, pdfToken }) {
  state.sourceLang = guessLanguage(text || meta?.title || '');
  reader.reset();
  el.articleEnd.hidden = true;
  showReading();

  const controller = new AbortController();
  state.abort = controller;
  state.streaming = true;
  el.barStatus.textContent = 'setting…';

  const id = `p${Date.now().toString(36)}`;
  try {
    await streamEvents(
      '/api/typeset',
      { text, meta, pdfToken },
      {
        text: (event) => {
          reader.push(event.text);
          markSavedSoon();
        },
        progress: (event) => {
          el.barStatus.textContent =
            event.of > 1 ? `setting ${event.piece} of ${event.of}` : 'setting…';
        },
        failed: (event) => {
          el.barStatus.textContent = '';
          el.endNote.textContent = event.message;
          el.articleEnd.hidden = false;
        },
        done: () => {
          el.barStatus.textContent = '';
        },
      },
      controller.signal,
    );
  } catch (error) {
    if (error.name !== 'AbortError') {
      el.barStatus.textContent = '';
      el.endNote.textContent = `Could not set this: ${error.message}`;
      el.articleEnd.hidden = false;
    }
  } finally {
    state.streaming = false;
    state.abort = null;
  }

  const summary = reader.end();
  reader.markSaved((word) => saved.has(word));
  el.articleEnd.hidden = false;
  if (!el.endNote.textContent) {
    el.endNote.textContent = readingLine(summary.words, summary.minutes);
  }
  updateProgress();

  if (reader.protocol.trim().length > 40) {
    state.piece = {
      id,
      title: summary.title || meta?.title || 'Untitled',
      protocol: reader.protocol,
      words: summary.words,
      minutes: summary.minutes,
      lang: state.sourceLang,
      at: Date.now(),
    };
    shelvePiece(state.piece);
  }
}

function openShelved(piece) {
  state.sourceLang = piece.lang || 'en';
  state.piece = piece;
  showReading();
  reader.render(piece.protocol);
  reader.markSaved((word) => saved.has(word));
  const summary = reader.finish();
  state.title = summary.title || piece.title;
  el.barTitle.textContent = state.title;
  document.title = `${state.title} — Lectern`;
  el.endNote.textContent = readingLine(
    piece.words || summary.words,
    piece.minutes || summary.minutes,
  );
  el.articleEnd.hidden = false;
  updateProgress();
}

// -------------------------------------------------------------------- intake

let picked = null; // { name, bytes, extracted }

function say(message, bad = false) {
  el.note.textContent = message || '';
  el.note.classList.toggle('bad', Boolean(bad));
}

const prettyBytes = (n) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function clearFile() {
  picked = null;
  el.fileCard.hidden = true;
  el.file.value = '';
  el.source.disabled = false;
  say('');
}

async function takeFile(file) {
  if (!file) return;
  clearFile();
  picked = { name: file.name, size: file.size };
  el.fileName.textContent = file.name;
  el.fileIcon.textContent = (file.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
  el.fileFacts.textContent = `${prettyBytes(file.size)} · reading…`;
  el.fileCard.hidden = false;
  el.source.disabled = true;
  el.go.disabled = true;

  try {
    const bytes = await file.arrayBuffer();
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
      },
      body: bytes,
    });
    const result = await response.json();
    picked.extracted = result;

    if (result.canRead) {
      el.fileFacts.textContent = `${result.pages || '?'} pages · no text layer, so it will be read by eye`;
      say('This looks like a scan. It will be read from the page images.');
    } else if (!result.ok) {
      el.fileFacts.textContent = result.reason || 'could not be read';
      say(result.reason || 'That file could not be read.', true);
      el.go.disabled = false;
      return;
    } else {
      const parts = [prettyBytes(file.size)];
      if (result.pages) parts.push(`${result.pages} pages`);
      parts.push(`${result.words.toLocaleString()} words`);
      const minutes = readingMinutes(result.words);
      parts.push(`about ${minutes} min`);
      el.fileFacts.textContent = parts.join(' · ');
      say(result.truncated ? 'Very long — only the first part will be set.' : '');
    }
  } catch (error) {
    el.fileFacts.textContent = 'could not be read';
    say(`That file could not be read: ${error.message}`, true);
  } finally {
    el.go.disabled = false;
  }
}

async function takeUrl(url) {
  say('Fetching that page…');
  const response = await fetch('/api/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const result = await response.json();
  if (!result.ok && !result.canRead) {
    say(result.reason || 'That page could not be read.', true);
    return null;
  }
  say('');
  return result;
}

el.intake.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.streaming) return;

  const typed = el.source.value.trim();

  if (picked?.extracted) {
    const result = picked.extracted;
    if (!result.ok && !result.canRead) {
      say(result.reason || 'That file could not be read.', true);
      return;
    }
    await typeset({
      text: result.text || '',
      meta: result.meta || { name: picked.name },
      pdfToken: result.pdfToken,
    });
    return;
  }

  if (/^https?:\/\/\S+$/i.test(typed)) {
    el.go.disabled = true;
    try {
      const result = await takeUrl(typed);
      if (result) {
        await typeset({
          text: result.text || '',
          meta: result.meta,
          pdfToken: result.pdfToken,
        });
      }
    } finally {
      el.go.disabled = false;
    }
    return;
  }

  if (typed.length < 2) {
    say('Put something in first — paste some text, or choose a file.', true);
    el.source.focus();
    return;
  }
  await typeset({ text: typed, meta: {} });
});

el.file.addEventListener('change', (event) => takeFile(event.target.files?.[0]));
el.fileClear.addEventListener('click', clearFile);

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

for (const trigger of [$('wordsToggle'), $('deskWords')]) {
  trigger.addEventListener('click', () => {
    drawWords();
    openPanel(el.wordsPanel);
  });
}
for (const trigger of [$('settingsToggle'), $('deskSettings')]) {
  trigger.addEventListener('click', () => openPanel(el.settingsPanel));
}

for (const [code, name] of LANGUAGES) {
  const option = document.createElement('option');
  option.value = code;
  option.textContent = name;
  el.setLang.append(option);
}

el.setLang.addEventListener('change', () => {
  settings.targetLang = el.setLang.value;
  card.cache.clear();
  applySettings();
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
  selectionAnchor = { text, rect };
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
  card.open(holder, {
    word: phrase,
    sentence: '',
    title: state.title,
    sourceLang: state.sourceLang,
    targetLang: settings.targetLang,
  });
});

// ----------------------------------------------------------------------- boot

async function boot() {
  applySettings();
  drawShelf();
  drawWords();

  if (!canSpeak()) {
    el.settingsNote.textContent = 'This browser cannot read words aloud.';
  }

  try {
    const state_ = await (await fetch('/api/state')).json();
    if (state_.targetLang && !localStorage.getItem(SETTINGS_KEY)) {
      settings.targetLang = state_.targetLang;
      applySettings();
    }
    el.engine.textContent = state_.local
      ? 'Plain typesetting, borrowed dictionaries — add a key in .env for the real thing.'
      : `Setting type with ${state_.model}${state_.fast ? ', fast' : ''}.`;
  } catch {
    el.engine.textContent = 'The server is not answering.';
  }

  el.source.focus();
}

boot();
