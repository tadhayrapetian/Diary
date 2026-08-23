/**
 * Быстрые заметки.
 *
 * Saving is the whole point, so it happens on three levels and the user is
 * never asked to think about any of them:
 *
 *   1. what you type is in the page's memory the instant you type it;
 *   2. anything the server has not confirmed is mirrored into localStorage, so
 *      a reload, a crashed tab or a stopped server cannot swallow it;
 *   3. the server writes it to disk, atomically, before it answers.
 *
 * The little dot in the corner reports level 3 only — the one that outlives
 * this browser.
 */

const $ = (id) => document.getElementById(id);

const els = {
  search: $('search'),
  status: $('status'),
  form: $('compose-form'),
  compose: $('compose'),
  add: $('add'),
  list: $('list'),
  empty: $('empty'),
  count: $('count'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
};

const DRAFT_KEY = 'quick-notes/draft';
const PENDING_KEY = 'quick-notes/pending';

/** How long a pause in typing counts as "finished for now". */
const SAVE_DELAY = 600;

const ICONS = {
  pin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.4 2.6 17.4 7.6M11 4.2 6.8 5.8a1 1 0 0 0-.35 1.64l6.1 6.1a1 1 0 0 0 1.64-.34L15.8 9M7 13 3 17"/></svg>',
  copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.5" y="7.5" width="9.5" height="9.5" rx="2.2"/><path d="M12.8 4.6A1.6 1.6 0 0 0 11.2 3H5.2A2.2 2.2 0 0 0 3 5.2v6a1.6 1.6 0 0 0 1.6 1.6"/></svg>',
  del: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.6 5.4h12.8M8 3.4h4M5.6 5.4l.7 10a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4l.7-10M8.4 8.4v5.6M11.6 8.4v5.6"/></svg>',
};

// ------------------------------------------------------------------ state

/** id → note, as we believe it to be right now. */
const notes = new Map();

/** id → text the server has not acknowledged yet. */
const dirty = new Map();

/** id → the <article> showing it, so rendering never rebuilds a row you are in. */
const rows = new Map();

let filter = '';
let order = [];
let flushing = false;
let failing = false;
let attempt = 0;
let saveTimer = null;
let retryTimer = null;
let toastTimer = null;
let undoAction = null;

// ------------------------------------------------------------------ storage

const local = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private browsing, a full quota — the server is still the real store.
    }
  },
};

function rememberPending() {
  local.write(PENDING_KEY, Object.fromEntries(dirty));
}

// ------------------------------------------------------------------ server

async function request(method, path, body, keepalive = false) {
  const response = await fetch(path, {
    method,
    keepalive,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.status.title = text;
  els.status.replaceChildren(
    Object.assign(document.createElement('span'), { textContent: text }),
  );
}

function refreshStatus() {
  if (failing) setStatus('error', dirty.size ? 'Не сохранено — повторяю' : 'Сервер не отвечает');
  else if (dirty.size) setStatus('saving', 'Сохраняю…');
  else setStatus('saved', 'Всё сохранено');
}

/** Marks a note as changed and starts the clock on writing it out. */
function edit(id, text) {
  if (text.trim()) {
    dirty.set(id, text);
    const note = notes.get(id);
    if (note) notes.set(id, { ...note, text });
  } else {
    // An emptied note is a delete waiting for you to look away, not a save.
    dirty.delete(id);
  }
  rememberPending();
  rows.get(id)?.classList.toggle('unsaved', !text.trim() || dirty.has(id));
  refreshStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

async function flush({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (flushing || !dirty.size) return;

  flushing = true;
  let broke = false;

  for (const [id, text] of [...dirty]) {
    if (!notes.has(id)) {
      dirty.delete(id);
      continue;
    }
    try {
      const { note } = await request(
        'PATCH',
        `/api/notes/${encodeURIComponent(id)}`,
        { text },
        keepalive,
      );
      // Only clear it if nothing was typed while the request was in the air.
      if (dirty.get(id) === text) dirty.delete(id);
      const newer = dirty.get(id);
      if (notes.has(id)) notes.set(id, { ...note, text: newer ?? note.text });
      rows.get(id)?.classList.toggle('unsaved', dirty.has(id));
    } catch (error) {
      broke = true;
      console.warn('[заметки] не сохранилось:', error.message);
      break;
    }
  }

  flushing = false;
  rememberPending();
  failing = broke;

  if (broke) {
    attempt = Math.min(attempt + 1, 5);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => flush(), Math.min(30_000, 1000 * 2 ** attempt));
  } else {
    attempt = 0;
    render();
  }
  refreshStatus();
}

// ------------------------------------------------------------------ actions

async function addNote(text) {
  const body = text.trim();
  if (!body) return;

  els.compose.value = '';
  local.write(DRAFT_KEY, '');
  autosize(els.compose);
  els.add.disabled = true;

  try {
    const { note } = await request('POST', '/api/notes', { text: body });
    notes.set(note.id, note);
    failing = false;
    render();
  } catch (error) {
    // Nothing typed may be lost: the text goes straight back where it was.
    els.compose.value = text;
    local.write(DRAFT_KEY, text);
    autosize(els.compose);
    els.add.disabled = false;
    failing = true;
    toast('Не сохранилось — текст вернулся в поле');
    console.warn('[заметки] не создалось:', error.message);
  }
  refreshStatus();
}

async function removeNote(id, { silent = false } = {}) {
  const note = notes.get(id);
  if (!note) return;

  notes.delete(id);
  dirty.delete(id);
  rememberPending();
  render();

  try {
    await request('DELETE', `/api/notes/${encodeURIComponent(id)}`);
    failing = false;
    if (!silent) toast('Заметка удалена', 'Вернуть', () => restoreNote(note));
  } catch (error) {
    notes.set(id, note);
    failing = true;
    render();
    toast('Не удалось удалить');
    console.warn('[заметки] не удалилось:', error.message);
  }
  refreshStatus();
}

async function restoreNote(note) {
  try {
    const { note: back } = await request('POST', '/api/notes', {
      id: note.id,
      text: note.text,
      created: note.created,
      pinned: note.pinned,
    });
    notes.set(back.id, back);
    failing = false;
    render();
  } catch (error) {
    failing = true;
    toast('Не удалось вернуть заметку');
    console.warn('[заметки] не вернулось:', error.message);
  }
  refreshStatus();
}

async function togglePin(id) {
  const note = notes.get(id);
  if (!note) return;

  const pinned = !note.pinned;
  notes.set(id, { ...note, pinned });
  render();

  try {
    const { note: saved } = await request(
      'PATCH',
      `/api/notes/${encodeURIComponent(id)}`,
      { pinned },
    );
    if (notes.has(id)) notes.set(id, { ...saved, text: dirty.get(id) ?? saved.text });
    failing = false;
  } catch (error) {
    notes.set(id, note);
    failing = true;
    toast('Не удалось закрепить');
    console.warn('[заметки] не закрепилось:', error.message);
  }
  render();
  refreshStatus();
}

async function copyNote(id) {
  const note = notes.get(id);
  if (!note) return;
  try {
    await navigator.clipboard.writeText(note.text);
    toast('Скопировано', null, null, 1600);
  } catch {
    toast('Браузер не дал доступ к буферу обмена');
  }
}

// ------------------------------------------------------------------ rendering

function autosize(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

function plural(n, one, few, many) {
  const ten = n % 10;
  const hundred = n % 100;
  if (ten === 1 && hundred !== 11) return one;
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return few;
  return many;
}

function when(ms) {
  const date = new Date(ms);
  const diff = Date.now() - ms;
  const clock = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  if (diff < 45_000) return 'только что';
  if (diff < 3_600_000) {
    const minutes = Math.max(1, Math.round(diff / 60_000));
    return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
  }

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return `сегодня, ${clock}`;
  if (date.toDateString() === yesterday.toDateString()) return `вчера, ${clock}`;

  const day = date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day}, ${clock}`;
}

function createRow(id) {
  const row = document.createElement('article');
  row.className = 'note';
  row.dataset.id = id;
  row.innerHTML = `
    <textarea class="note-text" rows="1" aria-label="Текст заметки"></textarea>
    <div class="note-bar">
      <time></time>
      <div class="tools">
        <button type="button" data-act="pin" aria-pressed="false" aria-label="Закрепить"
          title="Закрепить">${ICONS.pin}</button>
        <button type="button" data-act="copy" aria-label="Скопировать"
          title="Скопировать">${ICONS.copy}</button>
        <button type="button" data-act="del" aria-label="Удалить"
          title="Удалить">${ICONS.del}</button>
      </div>
    </div>`;

  const field = row.querySelector('.note-text');
  field.addEventListener('input', () => {
    autosize(field);
    edit(id, field.value);
  });
  field.addEventListener('blur', () => {
    if (!notes.has(id)) return;
    if (field.value.trim()) flush();
    else removeNote(id);
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      field.blur();
    }
  });

  row.querySelector('.tools').addEventListener('click', (event) => {
    const act = event.target.closest('button')?.dataset.act;
    if (act === 'pin') togglePin(id);
    if (act === 'copy') copyNote(id);
    if (act === 'del') removeNote(id);
  });

  rows.set(id, row);
  return row;
}

function updateRow(row, note) {
  const field = row.querySelector('.note-text');
  if (document.activeElement !== field && field.value !== note.text) {
    field.value = note.text;
    autosize(field);
  }

  const time = row.querySelector('time');
  time.dateTime = new Date(note.updated).toISOString();
  time.textContent = when(note.updated);

  const pin = row.querySelector('[data-act="pin"]');
  pin.setAttribute('aria-pressed', String(note.pinned));
  pin.title = note.pinned ? 'Открепить' : 'Закрепить';
  pin.setAttribute('aria-label', pin.title);

  row.classList.toggle('pinned', note.pinned);
  row.classList.toggle('unsaved', dirty.has(note.id) || !field.value.trim());
}

/**
 * Pinned first, then freshest. While a note is being typed in, the previous
 * order is held instead — a line of text should never walk off under the cursor
 * just because saving it made it the newest thing in the list. Only the cursor
 * freezes the order: pressing the pin is a request to see the note move.
 */
function arrange(visible) {
  const sorted = [...visible].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updated - a.updated;
  });

  if (!document.activeElement?.classList?.contains('note-text')) return sorted;

  const rank = new Map(order.map((id, index) => [id, index]));
  return sorted.sort(
    (a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1),
  );
}

function render() {
  const needle = filter.trim().toLowerCase();
  const all = [...notes.values()];
  const visible = arrange(
    needle ? all.filter((note) => note.text.toLowerCase().includes(needle)) : all,
  );

  const keep = new Set();
  visible.forEach((note, index) => {
    const row = rows.get(note.id) ?? createRow(note.id);
    keep.add(note.id);
    // Only touch the DOM when the position actually differs: re-inserting a row
    // would take the focus out of the textarea inside it.
    if (els.list.children[index] !== row) {
      els.list.insertBefore(row, els.list.children[index] ?? null);
    }
    updateRow(row, note);
  });

  for (const [id, row] of rows) {
    if (keep.has(id)) continue;
    row.remove();
    rows.delete(id);
  }

  order = visible.map((note) => note.id);

  els.empty.hidden = visible.length > 0;
  els.empty.textContent = all.length
    ? 'Ничего не найдено.'
    : 'Пока пусто. Первая заметка — в поле выше.';

  els.count.textContent = needle
    ? `Найдено ${visible.length} из ${all.length}`
    : `${all.length} ${plural(all.length, 'заметка', 'заметки', 'заметок')}`;
}

// ------------------------------------------------------------------ toast

function hideToast() {
  clearTimeout(toastTimer);
  undoAction = null;
  els.toast.hidden = true;
}

function toast(text, actionLabel = null, action = null, ms = 8000) {
  clearTimeout(toastTimer);
  els.toastText.textContent = text;
  els.toastAction.hidden = !actionLabel;
  els.toastAction.textContent = actionLabel || '';
  undoAction = action;
  els.toast.hidden = false;
  toastTimer = setTimeout(hideToast, ms);
}

els.toastAction.addEventListener('click', () => {
  const run = undoAction;
  hideToast();
  run?.();
});

// ------------------------------------------------------------------ input

els.compose.addEventListener('input', () => {
  autosize(els.compose);
  els.add.disabled = !els.compose.value.trim();
  local.write(DRAFT_KEY, els.compose.value);
});

els.compose.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    addNote(els.compose.value);
  }
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  addNote(els.compose.value);
});

els.search.addEventListener('input', () => {
  filter = els.search.value;
  render();
});

els.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  els.search.value = '';
  filter = '';
  render();
  els.search.blur();
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (command && key === 's') {
    event.preventDefault();
    flush();
    if (!dirty.size) toast('Всё уже на диске', null, null, 1400);
    return;
  }
  if (command && key === 'k') {
    event.preventDefault();
    els.search.focus();
    els.search.select();
    return;
  }
  if (command && key === 'z' && !typing && undoAction) {
    event.preventDefault();
    const run = undoAction;
    hideToast();
    run();
    return;
  }
  if (typing) return;

  if (key === '/') {
    event.preventDefault();
    els.search.focus();
  } else if (key === 'n') {
    event.preventDefault();
    els.compose.focus();
  }
});

// A field sized for a wide window clips its own text in a narrow one, so every
// box is measured again whenever the width changes — rotating a phone included.
let resizeFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    autosize(els.compose);
    for (const row of rows.values()) autosize(row.querySelector('.note-text'));
  });
});

// A tab going away is the last chance to write; keepalive lets the request
// outlive the page.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty.size) flush({ keepalive: true });
});
window.addEventListener('pagehide', () => {
  if (dirty.size) flush({ keepalive: true });
});

// Another tab (or another device) may have moved things on. Coming back is a
// good moment to catch up — without ever overwriting what is unsaved here.
window.addEventListener('focus', () => {
  if (!dirty.size && !flushing) load({ quiet: true });
});

// ------------------------------------------------------------------ start

async function load({ quiet = false } = {}) {
  try {
    const { notes: fetched } = await request('GET', '/api/notes');
    const pending = new Map(Object.entries(local.read(PENDING_KEY, {}) || {}));

    notes.clear();
    for (const note of fetched) {
      const unsaved = pending.get(note.id);
      if (unsaved && unsaved !== note.text) {
        // Written here, never acknowledged. The local copy wins and gets sent.
        notes.set(note.id, { ...note, text: unsaved });
        dirty.set(note.id, unsaved);
      } else {
        notes.set(note.id, note);
      }
    }

    // Anything pending for a note that no longer exists is gone with it.
    for (const id of [...dirty.keys()]) if (!notes.has(id)) dirty.delete(id);
    rememberPending();

    failing = false;
    render();
    if (dirty.size) flush();
  } catch (error) {
    failing = true;
    if (!quiet) {
      els.empty.hidden = false;
      els.empty.textContent = 'Сервер не отвечает. Запущен ли он?';
      console.warn('[заметки] не загрузилось:', error.message);
    }
  }
  refreshStatus();
}

const draft = local.read(DRAFT_KEY, '');
if (typeof draft === 'string' && draft) {
  els.compose.value = draft;
  autosize(els.compose);
}
els.add.disabled = !els.compose.value.trim();

// Relative times go stale on their own; nothing else here would repaint them.
setInterval(() => {
  for (const [id, row] of rows) {
    const note = notes.get(id);
    if (note) row.querySelector('time').textContent = when(note.updated);
  }
}, 60_000);

await load();
els.compose.focus();
