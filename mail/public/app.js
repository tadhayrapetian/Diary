import { folderIcon } from './icons.js';
import {
  h, svg, iconButton, api, streamPost, shortDate, longDate, dateGroup, fileSize, displayName, avatar, fileBadge,
  settings, saveSettings, applyLook, contacts, drafts, toast, isTyping, mod, modK, plural,
} from './lib.js';
import { renderBody } from './frame.js';
import { Composer, replyRecipients } from './compose.js';
import { openPalette, openSettings, openShortcuts, closeOverlay, overlayOpen, showMenu, closeMenu } from './overlays.js';

// ───────────────────────────────────────────── state

const state = {
  mode: 'demo',
  me: { name: '', address: '' },
  ai: false,
  folders: [],
  folder: null, // folder id
  query: '',
  filter: 'all',
  items: [],
  next: null,
  loading: true,
  loadingMore: false,
  error: null,
  cursor: null, // row key under the keyboard
  selection: new Set(), // row keys
  open: null, // { key, thread: [full], loading }
  summary: null, // { key, text, loading }
  allowRemote: new Set(),
  toggled: new Map(), // message key → expanded, when the reader overrides the default
  lastLoad: 0,
  sidebarOpen: false,
};

const el = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  list: document.getElementById('list-pane'),
  reader: document.getElementById('reader-pane'),
};

const folderById = (id) => state.folders.find((f) => f.id === id);
const folderByRole = (role) => state.folders.find((f) => f.role === role);
const currentFolder = () => folderById(state.folder) || { id: state.folder, name: 'Почта', role: null };
const isMine = (a) => a?.address && a.address.toLowerCase() === state.me.address.toLowerCase();

// ───────────────────────────────────────────── rows (conversations)

function rows() {
  if (!settings.conversations) {
    return state.items.map((m) => ({ key: `m:${m.folder}:${m.id}`, items: [m], latest: m }));
  }
  const byThread = new Map();
  const out = [];
  for (const m of state.items) {
    const key = `t:${m.threadId || `${m.folder}:${m.id}`}`;
    let row = byThread.get(key);
    if (!row) {
      row = { key, items: [], latest: m };
      byThread.set(key, row);
      out.push(row);
    }
    row.items.push(m);
  }
  return out;
}

const rowByKey = (key) => rows().find((r) => r.key === key);
const rowUnread = (r) => r.items.some((m) => !m.seen);
const rowFlagged = (r) => r.items.some((m) => m.flagged);

function targetRows() {
  const all = rows();
  if (state.selection.size) return all.filter((r) => state.selection.has(r.key));
  if (state.open) {
    const r = all.find((x) => x.key === state.open.key);
    return r ? [r] : [];
  }
  const c = all.find((r) => r.key === state.cursor);
  return c ? [c] : [];
}

function byFolder(items) {
  const map = new Map();
  for (const m of items) {
    if (!map.has(m.folder)) map.set(m.folder, []);
    map.get(m.folder).push(m.id);
  }
  return map;
}

// ───────────────────────────────────────────── loading

async function loadFolders() {
  try {
    state.folders = await api('/api/folders');
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderSidebar();
  if (!state.loading && document.activeElement?.id !== 'search') el.list.querySelector('.list-head')?.replaceWith(listHead());
  const inbox = folderByRole('inbox');
  document.title = inbox?.unread ? `(${inbox.unread}) Aether` : 'Aether — почта';
}
let foldersTimer;
const refreshFoldersSoon = () => {
  clearTimeout(foldersTimer);
  foldersTimer = setTimeout(loadFolders, 700);
};

let listToken = 0;
async function loadList({ more = false, quiet = false } = {}) {
  const token = ++listToken;
  if (more) {
    if (state.next == null || state.loadingMore) return;
    state.loadingMore = true;
  } else if (!quiet) {
    state.loading = true;
    state.items = [];
    state.next = null;
    state.error = null;
    renderList();
  }
  const params = new URLSearchParams({ folder: state.folder, filter: state.filter, limit: '50' });
  if (state.query) params.set('q', state.query);
  if (more) params.set('offset', String(state.next));
  else if (quiet) params.set('limit', String(Math.min(100, Math.max(50, state.items.length))));
  try {
    const page = await api(`/api/messages?${params}`);
    if (token !== listToken) return;
    if (more) {
      const seen = new Set(state.items.map((m) => `${m.folder}:${m.id}`));
      state.items.push(...page.items.filter((m) => !seen.has(`${m.folder}:${m.id}`)));
    } else state.items = page.items;
    state.next = page.next;
    state.total = page.total;
    state.lastLoad = Date.now();
    for (const m of page.items) contacts.learn(isMine(m.from) ? [...m.to, ...m.cc] : [m.from], isMine(m.from) ? 2 : 1);
  } catch (err) {
    if (token !== listToken) return;
    state.error = err.message;
  } finally {
    if (token === listToken) {
      state.loading = false;
      state.loadingMore = false;
      renderList();
    }
  }
}

function goFolder(id, { keepQuery = false } = {}) {
  if (!keepQuery) state.query = '';
  state.folder = id;
  state.filter = 'all';
  state.selection.clear();
  state.cursor = null;
  state.sidebarOpen = false;
  closeReader();
  renderSidebar();
  loadList();
  try {
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  } catch {
    /* sandboxed previews */
  }
}

// ───────────────────────────────────────────── reading

async function openRow(row, { focusReader = false } = {}) {
  if (!row) return;
  state.cursor = row.key;
  state.summary = state.summary?.key === row.key ? state.summary : null;
  state.open = { key: row.key, thread: [], loading: true };
  state.toggled = new Map();
  el.app.classList.add('reading');
  renderList();
  renderReader();

  const m = row.latest;
  const unread = row.items.filter((x) => !x.seen);
  if (unread.length) setFlag(unread, 'seen', true, { quiet: true });

  try {
    const q = `folder=${encodeURIComponent(m.folder)}&id=${encodeURIComponent(m.id)}`;
    const thread = settings.conversations ? await api(`/api/thread?${q}`) : [await api(`/api/message?${q}`)];
    if (state.open?.key !== row.key) return;
    for (const t of thread) {
      if (unread.some((u) => u.id === t.id && u.folder === t.folder)) t.seen = false; // so it opens expanded
      contacts.learn([t.from, ...t.to, ...t.cc]);
    }
    state.open = { key: row.key, thread, loading: false };
    renderReader();
    if (focusReader) el.reader.querySelector('.reader')?.focus();
  } catch (err) {
    if (state.open?.key !== row.key) return;
    state.open = { key: row.key, thread: [], loading: false, error: err.message };
    renderReader();
  }
}

function closeReader() {
  state.open = null;
  state.summary = null;
  el.app.classList.remove('reading');
  renderReader();
}

function step(delta, { open = Boolean(state.open) } = {}) {
  const all = rows();
  if (!all.length) return;
  const at = all.findIndex((r) => r.key === (state.open?.key || state.cursor));
  const next = all[Math.max(0, Math.min(all.length - 1, at < 0 ? 0 : at + delta))];
  if (open) openRow(next);
  else {
    state.cursor = next.key;
    renderList();
  }
  requestAnimationFrame(() => el.list.querySelector(`.row[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' }));
  if (state.next != null && at > all.length - 8) loadList({ more: true });
}

// ───────────────────────────────────────────── actions

async function setFlag(items, flag, on, { quiet = false } = {}) {
  const changed = items.filter((m) => (flag === 'seen' ? m.seen : m.flagged) !== on);
  if (!changed.length) return;
  for (const m of changed) m[flag] = on;
  for (const t of state.open?.thread || []) {
    if (changed.some((m) => m.id === t.id && m.folder === t.folder)) t[flag] = on;
  }
  renderList();
  if (!quiet) renderReader();
  try {
    await Promise.all([...byFolder(changed)].map(([folder, ids]) => api('/api/flags', { folder, ids, [on ? 'add' : 'remove']: [flag] })));
  } catch (err) {
    for (const m of changed) m[flag] = !on;
    renderList();
    toast(err.message, { error: true });
  }
  refreshFoldersSoon();
}

function toggleStar() {
  const target = targetRows();
  if (!target.length) return;
  const on = !target.every(rowFlagged);
  // Starring a conversation stars its latest message, as most clients do.
  setFlag(target.map((r) => (on ? r.latest : r.items)).flat(), 'flagged', on);
  if (!state.selection.size) toast(on ? 'Добавлено в избранное' : 'Убрано из избранного', { icon: 'star' });
}

function toggleRead() {
  const target = targetRows();
  if (!target.length) return;
  const markRead = target.some(rowUnread);
  setFlag(target.flatMap((r) => r.items), 'seen', markRead);
  if (!markRead && state.open && target.some((r) => r.key === state.open.key)) closeReader();
}

const pending = new Set();

/**
 * Archive, trash, spam, move: the rows leave at once, the server hears about it
 * when the undo window closes.
 */
function moveRows(target, to, { label, icon = 'archive' } = {}) {
  if (!target.length) return;
  const dest = folderByRole(to) || folderById(to);
  const here = currentFolder();
  if (dest && dest.id === here.id) return;
  const permanent = to === 'trash' && here.role === 'trash';
  const items = target.flatMap((r) => r.items);
  const keys = new Set(target.map((r) => r.key));

  const all = rows();
  const openKey = state.open?.key;
  let advance = null;
  if (openKey && keys.has(openKey)) {
    const i = all.findIndex((r) => r.key === openKey);
    advance = all.slice(i + 1).find((r) => !keys.has(r.key)) || all.slice(0, i).reverse().find((r) => !keys.has(r.key));
  }

  // animate out, then drop
  for (const k of keys) el.list.querySelector(`.row[data-key="${CSS.escape(k)}"]`)?.classList.add('leaving');
  const snapshot = [...state.items];
  setTimeout(() => {
    state.items = state.items.filter((m) => !items.includes(m));
    state.selection.clear();
    if (openKey && keys.has(openKey)) {
      if (advance && window.innerWidth > 820) openRow(advance);
      else closeReader();
    }
    renderList();
  }, 220);

  const job = {
    run: () => Promise.all([...byFolder(items)].map(([folder, ids]) => api(permanent ? '/api/destroy' : '/api/move', { folder, ids, to }))),
  };
  pending.add(job);
  const n = items.length;
  const what = target.length > 1 ? `${target.length} ${plural(target.length, 'беседа', 'беседы', 'бесед')}` : n > 1 ? 'Беседа' : 'Письмо';
  const verb = permanent ? 'удалено навсегда' : label || `перемещено в «${dest?.name || to}»`;
  toast(`${what} ${target.length > 1 ? verb.replace(/^(\S+?)ено(\s|$)/, '$1ены$2') : verb}`, {
    icon,
    action: 'Отменить',
    progress: true,
    duration: 5000,
    onAction: () => {
      pending.delete(job);
      state.items = snapshot;
      renderList();
      toast('Отменено', { icon: 'undo' });
    },
    onExpire: async () => {
      if (!pending.delete(job)) return;
      try {
        await job.run();
      } catch (err) {
        toast(`Не получилось: ${err.message}`, { error: true });
        loadList({ quiet: true });
      }
      refreshFoldersSoon();
    },
  });
}

const archiveRole = () => (folderByRole('archive') ? 'archive' : folderByRole('all') ? 'all' : 'archive');

const archive = () => {
  const here = currentFolder();
  if (here.role === 'archive') return moveRows(targetRows(), 'inbox', { label: 'возвращено во «Входящие»', icon: 'inbox' });
  moveRows(targetRows(), archiveRole(), { label: 'в архиве' });
};
const trash = () => moveRows(targetRows(), 'trash', { label: 'в корзине', icon: 'trash' });
const spam = () => {
  if (currentFolder().role === 'junk') return moveRows(targetRows(), 'inbox', { label: 'не спам — во «Входящих»', icon: 'inbox' });
  moveRows(targetRows(), 'junk', { label: 'в спаме', icon: 'spam' });
};

function moveMenu(anchor) {
  const target = targetRows();
  if (!target.length) return;
  showMenu(anchor, state.folders
    .filter((f) => f.id !== state.folder && f.role !== 'flagged' && f.role !== 'drafts' && f.role !== 'sent' && f.role !== 'all')
    .map((f) => ({ icon: folderIcon(f), label: f.name, run: () => moveRows(target, f.role || f.id, { icon: folderIcon(f) }) })));
}

window.addEventListener('pagehide', () => {
  for (const job of pending) job.run();
  pending.clear();
});

function markAllRead() {
  const unread = state.items.filter((m) => !m.seen);
  if (!unread.length) return toast('Всё уже прочитано', { icon: 'check' });
  setFlag(unread, 'seen', true);
  toast(`${unread.length} ${plural(unread.length, 'письмо отмечено', 'письма отмечены', 'писем отмечено')} прочитанными`, { icon: 'check' });
}

// ───────────────────────────────────────────── writing

function compose(opts = {}) {
  return new Composer({
    me: state.me,
    aiEnabled: state.ai,
    onSend: sendMail,
    onDraft: () => {
      if (currentFolder().role === 'drafts') renderList();
      renderSidebar();
    },
    ...opts,
  });
}

function replyTo(mode, message, ai) {
  const thread = state.open?.thread || [];
  const source = message || [...thread].reverse().find((m) => !isMine(m.from)) || thread[thread.length - 1];
  if (!source) return;
  compose({ mode, source, ai });
}

function sendMail(mail, composer) {
  const deliver = async () => {
    const sending = toast('Отправляю…', { icon: 'send', duration: 60_000 });
    try {
      await api('/api/send', mail);
      sending.close();
      composer.forget();
      toast('Письмо отправлено', { icon: 'send' });
      refreshFoldersSoon();
      if (['sent', 'inbox'].includes(currentFolder().role)) setTimeout(() => loadList({ quiet: true }), 400);
      if (state.open && mail.replyTo) {
        for (const t of state.open.thread) if (t.id === mail.replyTo.id) t.answered = true;
      }
    } catch (err) {
      sending.close();
      toast(`Не отправлено: ${err.message}`, { error: true, duration: 6000 });
      composer.reopen();
    }
  };
  const wait = Number(settings.undoSeconds) * 1000;
  if (!wait) return deliver();
  let undone = false;
  toast('Письмо уходит…', {
    icon: 'send',
    action: 'Отменить',
    progress: true,
    duration: wait,
    onAction: () => {
      undone = true;
      composer.reopen();
    },
    onExpire: () => {
      if (!undone) deliver();
    },
  });
}

// ───────────────────────────────────────────── assistant

async function summarize() {
  if (!state.ai) return toast('Ассистент выключен: добавьте ANTHROPIC_API_KEY в .env', { icon: 'sparkles' });
  const open = state.open;
  if (!open || open.loading || !open.thread.length) return;
  if (state.summary?.key === open.key && !state.summary.error) {
    state.summary = null;
    return renderReader();
  }
  const latest = open.thread[open.thread.length - 1];
  state.summary = { key: open.key, text: '', loading: true };
  renderReader();
  try {
    await streamPost('/api/ai', { action: 'summarize', folder: latest.folder, id: latest.id }, (event, data) => {
      if (state.summary?.key !== open.key) return;
      if (event === 'text') {
        state.summary.text += data.text;
        const body = el.reader.querySelector('.ai-body');
        if (body) body.textContent = state.summary.text.trimStart();
      } else if (event === 'error') throw new Error(data.error);
    });
    if (state.summary?.key === open.key) state.summary.loading = false;
  } catch (err) {
    if (state.summary?.key === open.key) state.summary = { key: open.key, text: err.message, loading: false, error: true };
  }
  renderReader();
}

// ───────────────────────────────────────────── sidebar

function renderSidebar() {
  const localDrafts = Object.keys(drafts.all()).length;
  const roles = state.folders.filter((f) => f.role);
  const others = state.folders.filter((f) => !f.role);

  const item = (f) => {
    const count = f.role === 'drafts' ? f.total + localDrafts : f.role === 'sent' || f.role === 'trash' || f.role === 'all' || f.role === 'flagged' ? 0 : f.unread;
    const hot = f.role === 'inbox' || (!f.role && f.unread);
    return h('button.nav-item', {
      type: 'button', class: f.id === state.folder ? 'active' : '', title: f.name,
      onclick: () => goFolder(f.id),
      ondragover: (e) => { if (e.dataTransfer.types.includes('application/x-aether') && f.role !== 'flagged') { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drop');
        const keys = JSON.parse(e.dataTransfer.getData('application/x-aether') || '[]');
        const target = rows().filter((r) => keys.includes(r.key));
        moveRows(target, f.role || f.id, { icon: folderIcon(f), label: `перемещено в «${f.name}»` });
      },
    }, svg(folderIcon(f), 18), h('span.name', f.name), count ? h('span.count', { class: hot ? 'hot' : '' }, count > 999 ? '999+' : count) : null);
  };

  el.sidebar.classList.toggle('open', state.sidebarOpen);
  el.sidebar.replaceChildren(
    h('div.brand', h('div.brand-mark', svg('sparkles', 16)), h('span.brand-name', 'Aether'), state.mode === 'demo' ? h('span.brand-mode', 'демо') : null),
    h('button.compose-btn', { type: 'button', onclick: () => compose() }, svg('compose', 18), h('span', 'Написать'), h('kbd', 'C')),
    h('nav.nav', { 'aria-label': 'Папки' },
      ...roles.map(item),
      others.length ? h('div.nav-label', 'Папки') : null,
      ...others.map(item)),
    h('div.side-foot',
      avatar(state.me, 'sm'),
      h('div.who', h('b', state.me.name || 'Моя почта'), h('span', state.me.address)),
      iconButton('command', `Команды  ${modK}`, palette),
      iconButton('settings', 'Настройки', settingsSheet)));
}

// ───────────────────────────────────────────── list

let searchTimer;

function listHead() {
  const f = currentFolder();
  const searching = Boolean(state.query);
  const input = h('input', {
    type: 'search', placeholder: 'Поиск по почте', value: state.query, 'aria-label': 'Поиск', id: 'search',
    oninput: () => {
      wrap.classList.toggle('has', Boolean(input.value));
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = input.value.trim();
        state.selection.clear();
        loadList();
      }, 280);
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value) {
          input.value = '';
          wrap.classList.remove('has');
          state.query = '';
          loadList();
        } else input.blur();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        if (state.query !== input.value.trim()) {
          state.query = input.value.trim();
          loadList();
        }
        input.blur();
        if (!state.cursor && rows()[0]) {
          state.cursor = rows()[0].key;
          renderList();
        }
      }
    },
  });
  const wrap = h('label.search', { class: state.query ? 'has' : '' }, svg('search', 17), input,
    h('button.icon-btn.clear', { type: 'button', 'aria-label': 'Очистить', style: { width: '26px', height: '26px' }, onclick: (e) => { e.preventDefault(); input.value = ''; wrap.classList.remove('has'); state.query = ''; loadList(); input.focus(); } }, svg('x', 15)),
    h('kbd', '/'));

  const unread = f.unread && !searching ? h('small', `${f.unread} ${plural(f.unread, 'новое', 'новых', 'новых')}`) : null;
  const title = h('div.title-row',
    h('button.icon-btn.mobile-only', { type: 'button', 'aria-label': 'Папки', onclick: () => { state.sidebarOpen = true; renderSidebar(); } }, svg('menu', 20)),
    h('h1', searching ? `«${state.query}»` : f.name, unread),
    iconButton('check', 'Прочитать всё', markAllRead),
    iconButton('refresh', 'Обновить', () => { loadList({ quiet: true }); loadFolders(); }));

  const chip = (value, label, icon) =>
    h('button.chip', { type: 'button', class: state.filter === value ? 'on' : '', onclick: () => { state.filter = state.filter === value && value !== 'all' ? 'all' : value; state.selection.clear(); loadList(); } }, icon ? svg(icon, 13) : null, label);
  const chips = h('div.chips', chip('all', 'Все'), chip('unread', 'Непрочитанные', 'mail'), chip('flagged', 'Избранные', 'star'), chip('attachments', 'С вложениями', 'clip'));

  let bulk = null;
  if (state.selection.size) {
    const n = state.selection.size;
    bulk = h('div.bulk', h('span', `Выбрано: ${n}`),
      iconButton('archive', 'В архив (e)', archive),
      iconButton('trash', 'Удалить (#)', trash),
      iconButton('mailOpen', 'Прочитано / нет (u)', toggleRead),
      iconButton('star', 'Избранное (s)', toggleStar),
      iconButton('folder', 'Переместить', (e) => moveMenu(e.currentTarget)),
      iconButton('x', 'Снять выделение', () => { state.selection.clear(); renderList(); }));
  }
  const fab = h('button.fab.mobile-only', { type: 'button', 'aria-label': 'Написать', onclick: () => compose() }, svg('compose', 24));
  return h('div.list-head', wrap, title, bulk || chips, fab);
}

function rowNode(r) {
  const m = r.latest;
  const sentView = ['sent', 'drafts'].includes(currentFolder().role) || isMine(m.from);
  const person = sentView ? m.to[0] || m.from : m.from;
  const unread = rowUnread(r);
  const flagged = rowFlagged(r);
  const attach = r.items.some((x) => x.hasAttachments);

  let who;
  if (r.items.length > 1) {
    const names = [];
    for (const x of [...r.items].reverse()) {
      const n = isMine(x.from) ? 'я' : displayName(x.from).split(/\s+/)[0];
      if (!names.includes(n)) names.push(n);
    }
    who = h('span.who', names.slice(-3).join(', '), h('span.count-badge', r.items.length));
  } else {
    who = h('span.who', sentView ? `Кому: ${displayName(person)}` : displayName(person));
  }

  const avatarEl = avatar(person);
  avatarEl.append(h('span.tick', svg('check', 16)));
  avatarEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelect(r.key);
  });

  const node = h('div.row', {
    role: 'option', tabIndex: -1, 'aria-selected': String(state.open?.key === r.key),
    class: [unread ? 'unread' : '', state.open?.key === r.key ? 'active' : '', state.cursor === r.key && state.open?.key !== r.key ? 'cursor' : '', state.selection.has(r.key) ? 'selected' : '', m._fresh ? 'fresh' : ''].join(' '),
    dataset: { key: r.key },
    draggable: true,
    onclick: (e) => {
      if (e.shiftKey || e.metaKey || e.ctrlKey) return selectFrom(r.key, e.shiftKey);
      openRow(r);
    },
    oncontextmenu: (e) => {
      e.preventDefault();
      if (!state.selection.has(r.key)) {
        state.selection.clear();
        state.cursor = r.key;
      }
      renderList();
      rowMenu({ x: e.clientX, y: e.clientY }, r);
    },
    ondragstart: (e) => {
      const keys = state.selection.has(r.key) ? [...state.selection] : [r.key];
      e.dataTransfer.setData('application/x-aether', JSON.stringify(keys));
      e.dataTransfer.effectAllowed = 'move';
    },
  },
    unread ? h('i.dot') : null,
    avatarEl,
    h('div.row-main',
      h('div.row-top', who, h('span.marks', attach ? svg('clip', 13) : null, flagged ? h('span.starred', svg('star', 13)) : null), h('time', { datetime: m.date, title: longDate(m.date) }, shortDate(m.date))),
      h('div.subj', m.subject || '(без темы)'),
      h('div.snip', m.snippet || ' ')),
    h('div.row-actions', { onclick: (e) => e.stopPropagation() },
      iconButton('archive', 'В архив', () => moveRows([r], archiveRole(), { label: 'в архиве' })),
      iconButton('trash', 'Удалить', () => moveRows([r], 'trash', { label: 'в корзине', icon: 'trash' })),
      iconButton(unread ? 'mailOpen' : 'mail', unread ? 'Прочитано' : 'Непрочитано', () => setFlag(r.items, 'seen', unread)),
      iconButton('star', flagged ? 'Убрать из избранного' : 'В избранное', () => setFlag(flagged ? r.items : [r.latest], 'flagged', !flagged), { class: flagged ? 'star-on' : '' })));
  delete m._fresh;
  return node;
}

function rowMenu(at, r) {
  const unread = rowUnread(r);
  const flagged = rowFlagged(r);
  const target = () => (state.selection.size ? targetRows() : [r]);
  showMenu(at, [
    { icon: 'eye', label: 'Открыть', run: () => openRow(r) },
    { icon: 'reply', label: 'Ответить', run: async () => { await openRow(r); replyTo('reply'); } },
    { icon: 'forward', label: 'Переслать', run: async () => { await openRow(r); replyTo('forward', state.open?.thread.at(-1)); } },
    '-',
    { icon: unread ? 'mailOpen' : 'mail', label: unread ? 'Отметить прочитанным' : 'Отметить непрочитанным', run: () => setFlag(target().flatMap((x) => x.items), 'seen', unread) },
    { icon: 'star', label: flagged ? 'Убрать из избранного' : 'В избранное', run: () => setFlag(target().map((x) => (flagged ? x.items : x.latest)).flat(), 'flagged', !flagged) },
    '-',
    { icon: 'archive', label: 'Архивировать', run: () => moveRows(target(), archiveRole(), { label: 'в архиве' }) },
    { icon: 'folder', label: 'Переместить…', run: () => { state.selection = new Set(target().map((x) => x.key)); moveMenu(at); } },
    { icon: 'spam', label: currentFolder().role === 'junk' ? 'Не спам' : 'В спам', run: () => { state.selection = new Set(target().map((x) => x.key)); spam(); } },
    { icon: 'trash', label: 'Удалить', run: () => moveRows(target(), 'trash', { label: 'в корзине', icon: 'trash' }) },
  ]);
}

function toggleSelect(key) {
  if (state.selection.has(key)) state.selection.delete(key);
  else state.selection.add(key);
  state.cursor = key;
  renderList();
}

function selectFrom(key, range) {
  if (range && state.cursor) {
    const all = rows();
    const a = all.findIndex((r) => r.key === state.cursor);
    const b = all.findIndex((r) => r.key === key);
    for (const r of all.slice(Math.min(a, b), Math.max(a, b) + 1)) state.selection.add(r.key);
    renderList();
  } else toggleSelect(key);
}

function draftRows() {
  const all = Object.values(drafts.all()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return all.map((d) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = d.html || '';
    tmp.querySelectorAll('.sig, blockquote, .attrib, .fwd').forEach((n) => n.remove());
    const text = tmp.textContent.trim();
    const who = d.to?.[0];
    return h('div.row', { onclick: () => (Composer.openFor(d.key)?.restore() || compose({ draft: d, mode: d.mode })) },
      who ? avatar(who) : h('div.avatar', { style: { background: 'var(--ink-4)' } }, svg('draft', 16)),
      h('div.row-main',
        h('div.row-top', h('span.who', { style: { color: 'var(--danger)' } }, 'Черновик', who ? h('span', { style: { color: 'var(--ink-2)' } }, ` · ${displayName(who)}`) : null), h('time', shortDate(d.savedAt))),
        h('div.subj', d.subject || '(без темы)'),
        h('div.snip', text || ' ')));
  });
}

function emptyList() {
  const f = currentFolder();
  if (state.error) {
    return h('div.empty', h('div.orb.small'), h('h2', 'Не получилось загрузить'), h('p', state.error),
      h('div.quick', h('button', { type: 'button', onclick: () => loadList() }, svg('refresh', 16), 'Ещё раз')));
  }
  if (state.query) return h('div.empty', h('div.orb.small'), h('h2', 'Ничего не нашлось'), h('p', 'Попробуйте другое слово или уберите фильтр.'));
  if (state.filter !== 'all') return h('div.empty', h('div.orb.small'), h('h2', 'Пусто'), h('p', 'С этим фильтром писем нет.'));
  const copy = {
    inbox: ['Входящие пусты', 'Красота. Можно выдохнуть и заняться чем-нибудь приятным.'],
    flagged: ['Нет избранного', 'Отмечайте важное звёздочкой — клавиша S.'],
    drafts: ['Черновиков нет', 'Всё, что вы начали писать, сохранится здесь.'],
    sent: ['Пока ничего не отправлено', 'Нажмите C, чтобы написать первое письмо.'],
    junk: ['Спама нет', 'Чисто и спокойно.'],
    trash: ['Корзина пуста', 'Удалённые письма будут здесь.'],
    archive: ['Архив пуст', 'Нажмите E на письме — оно уйдёт сюда, но не потеряется.'],
  }[f.role] || ['Здесь пусто', 'В этой папке пока нет писем.'];
  return h('div.empty', h('div.orb'), h('h2', copy[0]), h('p', copy[1]));
}

function renderList() {
  const scroller = el.list.querySelector('.list');
  const scroll = scroller?.scrollTop || 0;
  const head = listHead();
  const list = h('div.list', { role: 'listbox', 'aria-label': 'Письма' });

  if (state.loading) {
    for (let i = 0; i < 9; i++) {
      list.append(h('div.skeleton', h('i.a'), h('div', h('i.l', { style: { width: `${40 + ((i * 37) % 35)}%` } }), h('i.l', { style: { width: `${70 + ((i * 13) % 25)}%` } }), h('i.l', { style: { width: `${55 + ((i * 29) % 35)}%`, opacity: 0.6 } }))));
    }
  } else {
    const all = rows();
    const isDrafts = currentFolder().role === 'drafts' && !state.query && state.filter === 'all';
    const local = isDrafts ? draftRows() : [];
    if (!all.length && !local.length) {
      el.list.replaceChildren(head, emptyList());
      return;
    }
    if (local.length) list.append(h('div.group', 'На этом устройстве'), ...local);
    let group = null;
    for (const r of all) {
      const g = dateGroup(r.latest.date);
      if (g !== group) {
        group = g;
        list.append(h('div.group', g));
      }
      list.append(rowNode(r));
    }
    if (state.next != null) {
      const sentinel = h('div.list-end', state.loadingMore ? 'Загружаю…' : '');
      list.append(sentinel);
      new IntersectionObserver((entries, obs) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          loadList({ more: true });
        }
      }, { root: list, rootMargin: '400px' }).observe(sentinel);
    } else if (all.length > 8) {
      list.append(h('div.list-end', '· · ·'));
    }
  }
  const focused = document.activeElement?.id === 'search';
  const caret = focused ? document.activeElement.selectionStart : null;
  el.list.replaceChildren(head, list);
  list.scrollTop = scroll;
  if (focused) {
    const s = document.getElementById('search');
    s.focus();
    s.setSelectionRange(caret, caret);
  }
}

// ───────────────────────────────────────────── reader

function peopleLine(m) {
  const fmt = (list) => list.map((a) => (isMine(a) ? 'мне' : displayName(a))).join(', ');
  const parts = [];
  if (m.to?.length) parts.push(`кому: ${fmt(m.to)}`);
  if (m.cc?.length) parts.push(`копия: ${fmt(m.cc)}`);
  return parts.join(' · ');
}

function attachmentsNode(m) {
  const list = (m.attachments || []).filter((a) => !a.inline);
  if (!list.length) return null;
  return h('div.atts', ...list.map((a) => {
    const url = `/api/attachment?folder=${encodeURIComponent(m.folder)}&id=${encodeURIComponent(m.id)}&index=${a.index}`;
    const image = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i.test(a.contentType);
    const badge = fileBadge(a.filename);
    const thumb = image
      ? h('span.thumb', { style: { backgroundImage: `url("${url}")` } })
      : h('span.thumb', { style: { background: badge.color } }, badge.ext);
    const viewable = image || /pdf/i.test(a.contentType);
    return h('a.att', { href: viewable ? url : `${url}&download=1`, target: viewable ? '_blank' : null, rel: 'noopener', download: viewable ? null : a.filename, title: a.filename },
      thumb, h('span.meta', h('b', a.filename), h('small', fileSize(a.size))));
  }));
}

function messageCard(m, { collapsed }) {
  const k = `${m.folder}:${m.id}`;
  const trusted = settings.remoteImages === 'always' || settings.trusted.includes(m.from.address) || state.allowRemote.has(k);
  const card = h('article.msg', { class: collapsed ? 'collapsed' : '' });

  const head = h('header.msg-head', {
    onclick: (e) => {
      if (e.target.closest('.acts') || state.open.thread.length < 2) return;
      state.toggled.set(k, collapsed);
      renderReader({ keepScroll: true });
    },
  },
    avatar(m.from, 'lg'),
    h('div.msg-who',
      h('div.name', isMine(m.from) ? 'Вы' : displayName(m.from), m.from.name && !isMine(m.from) ? h('span.addr', m.from.address) : null),
      h('div.to', peopleLine(m)),
      h('div.preview', m.snippet)),
    h('time', { datetime: m.date }, longDate(m.date)),
    h('div.acts',
      iconButton('reply', 'Ответить', () => replyTo('reply', m)),
      iconButton('more', 'Ещё', (e) => showMenu(e.currentTarget, [
        { icon: 'replyAll', label: 'Ответить всем', run: () => replyTo('replyAll', m) },
        { icon: 'forward', label: 'Переслать', run: () => replyTo('forward', m) },
        state.ai ? { icon: 'sparkles', label: 'Ответ с Claude', run: () => compose({ mode: 'reply', source: m, ai: 'auto' }) } : null,
        '-',
        { icon: 'mail', label: 'Отметить непрочитанным', run: () => { setFlag([m, ...state.items.filter((x) => x.id === m.id && x.folder === m.folder)], 'seen', false); closeReader(); } },
        !settings.trusted.includes(m.from.address) ? { icon: 'image', label: 'Всегда показывать картинки от отправителя', run: () => { saveSettings({ trusted: [...settings.trusted, m.from.address] }); renderReader({ keepScroll: true }); } } : null,
      ]))));
  card.append(head);

  if (!collapsed) {
    const { node, remote } = renderBody(m, { allowRemote: trusted });
    const body = h('div.msg-body');
    if (remote && !trusted) {
      body.append(h('div.remote-bar', svg('image', 16), h('span', 'Картинки из интернета скрыты, чтобы отправитель не узнал о прочтении.'),
        h('button', { type: 'button', onclick: () => { state.allowRemote.add(k); renderReader({ keepScroll: true }); } }, 'Показать'),
        h('button', { type: 'button', onclick: () => { saveSettings({ trusted: [...settings.trusted, m.from.address] }); renderReader({ keepScroll: true }); } }, 'Всегда от отправителя')));
    }
    body.append(node, attachmentsNode(m) || '');
    card.append(body);
  }
  return card;
}

function readerBar(row) {
  const open = state.open;
  const thread = open?.thread || [];
  const f = currentFolder();
  const flagged = row ? rowFlagged(row) : thread.some((m) => m.flagged);
  const has = Boolean(open);
  return h('div.reader-bar',
    h('button.icon-btn.back', { type: 'button', 'aria-label': 'Назад', onclick: closeReader }, svg('back', 20)),
    iconButton(f.role === 'archive' ? 'inbox' : 'archive', f.role === 'archive' ? 'Во «Входящие» (e)' : 'В архив (e)', archive, { disabled: !has }),
    iconButton('trash', 'Удалить (#)', trash, { disabled: !has }),
    iconButton('spam', f.role === 'junk' ? 'Не спам (!)' : 'В спам (!)', spam, { disabled: !has }),
    h('span.sep'),
    iconButton('mail', 'Непрочитано (u)', toggleRead, { disabled: !has }),
    iconButton('star', 'Избранное (s)', toggleStar, { disabled: !has, class: flagged ? 'star-on' : '' }),
    iconButton('folder', 'Переместить', (e) => moveMenu(e.currentTarget), { disabled: !has }),
    h('span.grow'),
    state.ai ? iconButton('sparkles', 'Кратко от Claude (.)', summarize, { disabled: !has || open?.loading, class: state.summary?.key === open?.key ? 'on' : '' }) : null,
    iconButton('reply', 'Ответить (r)', () => replyTo('reply'), { disabled: !has || open?.loading }),
    iconButton('replyAll', 'Ответить всем (a)', () => replyTo('replyAll'), { disabled: !has || open?.loading }),
    iconButton('forward', 'Переслать (f)', () => replyTo('forward', thread.at(-1)), { disabled: !has || open?.loading }));
}

function renderReader({ keepScroll = false } = {}) {
  const prev = el.reader.querySelector('.reader');
  const scroll = keepScroll ? prev?.scrollTop || 0 : 0;
  const open = state.open;
  const row = open ? rowByKey(open.key) : null;

  if (!open) {
    el.reader.replaceChildren(readerBar(null), h('div.empty',
      h('div.orb'),
      h('h2', 'Выберите письмо'),
      h('p', 'Или напишите новое — оно уже ждёт.'),
      h('div.hint', h('span', h('kbd', 'j'), h('kbd', 'k'), 'листать'), h('span', h('kbd', 'c'), 'написать'), h('span', h('kbd', mod), h('kbd', 'K'), 'команды'), h('span', h('kbd', '?'), 'все клавиши'))));
    return;
  }

  const body = h('div.reader', { tabIndex: -1 });
  const inner = h('div.reader-inner');
  body.append(inner);

  if (open.loading) {
    const latest = row?.latest;
    inner.append(h('h2.subject', latest?.subject || ''),
      h('div.skeleton', { style: { padding: '20px 0' } }, h('i.a'), h('div', h('i.l', { style: { width: '35%' } }), h('i.l', { style: { width: '22%' } }))),
      ...[92, 86, 95, 60].map((w) => h('div.skeleton', { style: { display: 'block', padding: '4px 0' } }, h('i.l', { style: { width: `${w}%` } }))));
  } else if (open.error) {
    inner.append(h('div.empty', h('div.orb.small'), h('h2', 'Письмо не открылось'), h('p', open.error)));
  } else {
    const thread = open.thread;
    const latest = thread[thread.length - 1];
    const participants = new Set(thread.flatMap((m) => [m.from, ...m.to, ...m.cc]).map((a) => a.address));
    const atts = thread.reduce((n, m) => n + (m.attachments || []).filter((a) => !a.inline).length, 0);
    inner.append(
      h('h2.subject', latest.subject || '(без темы)'),
      h('div.subject-meta',
        thread.length > 1 ? h('span.tag', svg('layers', 13), `${thread.length} ${plural(thread.length, 'письмо', 'письма', 'писем')}`) : null,
        participants.size > 2 ? h('span.tag', `${participants.size} ${plural(participants.size, 'участник', 'участника', 'участников')}`) : null,
        atts ? h('span.tag', svg('clip', 13), `${atts} ${plural(atts, 'вложение', 'вложения', 'вложений')}`) : null,
        thread.some((m) => m.flagged) ? h('span.tag', { style: { color: '#c98400' } }, svg('star', 13), 'избранное') : null));

    if (state.summary?.key === open.key) {
      const s = state.summary;
      inner.append(h('div.ai-card', { class: s.loading ? 'loading' : '' }, svg('sparkles', 18),
        h('div.ai-title', s.error ? 'Не получилось' : 'Кратко'),
        h('div.ai-body', s.text.trimStart()),
        iconButton('x', 'Скрыть', () => { state.summary = null; renderReader({ keepScroll: true }); }, { class: 'close' })));
    }

    thread.forEach((m, i) => {
      const k = `${m.folder}:${m.id}`;
      const last = i === thread.length - 1;
      const open = state.toggled.has(k) ? state.toggled.get(k) : last || !m.seen;
      inner.append(messageCard(m, { collapsed: !open && thread.length > 1, last }));
    });

    const others = new Set(thread.flatMap((m) => [m.from, ...m.to, ...m.cc]).filter((a) => !isMine(a)).map((a) => a.address));
    inner.append(h('div.quick',
      h('button', { type: 'button', onclick: () => replyTo('reply') }, svg('reply', 16), 'Ответить'),
      others.size > 1 ? h('button', { type: 'button', onclick: () => replyTo('replyAll') }, svg('replyAll', 16), 'Ответить всем') : null,
      h('button', { type: 'button', onclick: () => replyTo('forward', latest) }, svg('forward', 16), 'Переслать'),
      state.ai ? h('button.magic', { type: 'button', onclick: () => replyTo('reply', null, 'auto') }, svg('sparkles', 16), 'Ответ с Claude') : null));
  }

  el.reader.replaceChildren(readerBar(row), body);
  body.scrollTop = scroll;
}

// ───────────────────────────────────────────── palette & settings

function palette() {
  const cmds = [];
  const add = (section, title, icon, run, keys, keywords) => cmds.push({ section, title, icon, run, keys, keywords });
  add('Действия', 'Написать письмо', 'compose', () => compose(), ['c'], 'new compose новое');
  if (state.open) {
    add('Действия', 'Ответить', 'reply', () => replyTo('reply'), ['r'], 'reply');
    add('Действия', 'Ответить всем', 'replyAll', () => replyTo('replyAll'), ['a'], 'reply all');
    add('Действия', 'Переслать', 'forward', () => replyTo('forward', state.open.thread.at(-1)), ['f'], 'forward');
    if (state.ai) {
      add('Действия', 'Кратко от Claude', 'sparkles', summarize, ['.'], 'summary ai ии саммари');
      add('Действия', 'Ответ с Claude', 'sparkles', () => replyTo('reply', null, 'auto'), null, 'ai draft черновик ии');
    }
    add('Действия', 'Архивировать', 'archive', archive, ['e'], 'archive');
    add('Действия', 'Удалить', 'trash', trash, ['#'], 'delete trash корзина');
    add('Действия', 'Избранное', 'star', toggleStar, ['s'], 'star flag звезда');
  }
  add('Действия', 'Прочитать всё в папке', 'check', markAllRead, null, 'mark all read');
  add('Действия', 'Обновить', 'refresh', () => { loadList({ quiet: true }); loadFolders(); }, ['⇧', 'R'], 'refresh reload');
  for (const f of state.folders) add('Папки', f.name, folderIcon(f), () => goFolder(f.id), null, `${f.role || ''} папка folder`);
  add('Вид', 'Светлая тема', 'sun', () => saveSettings({ theme: 'light' }), null, 'light theme');
  add('Вид', 'Тёмная тема', 'moon', () => saveSettings({ theme: 'dark' }), null, 'dark theme ночь');
  add('Вид', 'Тема как в системе', 'monitor', () => saveSettings({ theme: 'auto' }), null, 'auto theme');
  add('Вид', settings.density === 'compact' ? 'Просторный список' : 'Компактный список', 'list', () => { saveSettings({ density: settings.density === 'compact' ? 'comfortable' : 'compact' }); }, null, 'density плотность');
  add('Вид', settings.conversations ? 'Показывать письма по одному' : 'Собирать в беседы', 'layers', () => { saveSettings({ conversations: !settings.conversations }); renderList(); closeReader(); }, null, 'threads цепочки беседы conversation');
  add('Прочее', 'Настройки', 'settings', settingsSheet, [','], 'settings preferences подпись signature');
  add('Прочее', 'Горячие клавиши', 'keyboard', openShortcuts, ['?'], 'keyboard shortcuts help');
  openPalette(cmds, {
    onSearch: (q) => {
      state.query = q;
      loadList();
    },
  });
}

function settingsSheet() {
  openSettings({
    state,
    onChange: (what) => {
      if (what === 'reload') {
        closeReader();
        renderList();
      } else if (state.open) renderReader({ keepScroll: true });
    },
  });
}

// ───────────────────────────────────────────── keyboard

let gPrefix = 0;

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!closeOverlay()) palette();
    return;
  }
  if (overlayOpen()) {
    if (e.key === 'Escape') closeOverlay();
    return;
  }
  if (isTyping(e.target)) return;
  if (e.altKey) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('button, a, summary')) return;

  if (e.key === 'Escape') {
    if (closeMenu()) return;
    if (state.sidebarOpen) {
      state.sidebarOpen = false;
      return renderSidebar();
    }
    if (state.selection.size) {
      state.selection.clear();
      return renderList();
    }
    if (state.open) return closeReader();
    return;
  }

  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.selection = new Set(rows().map((r) => r.key));
    return renderList();
  }
  if (meta) return;

  if (gPrefix && Date.now() - gPrefix < 1200) {
    gPrefix = 0;
    const role = { i: 'inbox', s: 'flagged', t: 'sent', d: 'drafts', a: 'archive', '!': 'junk' }[e.key];
    const f = role && (folderByRole(role) || (role === 'flagged' && folderById('starred')));
    if (f) {
      e.preventDefault();
      goFolder(f.id);
    }
    return;
  }

  const actions = {
    g: () => (gPrefix = Date.now()),
    j: () => step(1),
    ArrowDown: () => step(1),
    k: () => step(-1),
    ArrowUp: () => step(-1),
    J: () => step(1, { open: false }),
    K: () => step(-1, { open: false }),
    Enter: () => openRow(rowByKey(state.cursor) || rows()[0], { focusReader: true }),
    o: () => openRow(rowByKey(state.cursor) || rows()[0]),
    c: () => compose(),
    r: () => state.open && replyTo('reply'),
    a: () => state.open && replyTo('replyAll'),
    f: () => state.open && replyTo('forward', state.open.thread.at(-1)),
    e: archive,
    y: archive,
    '#': trash,
    Delete: trash,
    Backspace: trash,
    '!': spam,
    s: toggleStar,
    u: toggleRead,
    x: () => {
      const key = state.cursor || state.open?.key;
      if (key) toggleSelect(key);
    },
    '/': () => document.getElementById('search')?.focus(),
    '.': summarize,
    ',': settingsSheet,
    '?': openShortcuts,
    R: () => {
      loadList({ quiet: true });
      loadFolders();
      toast('Обновлено', { icon: 'refresh', duration: 1500 });
    },
  };
  const fn = actions[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// ───────────────────────────────────────────── live mail

function listen() {
  const source = new EventSource('/api/events');
  source.addEventListener('new', (e) => {
    const { folder, message } = JSON.parse(e.data);
    contacts.learn([message.from]);
    const viewing = state.folder === folder && !state.query && state.filter !== 'flagged' && state.filter !== 'attachments';
    if (viewing && !state.items.some((m) => m.id === message.id && m.folder === message.folder)) {
      message._fresh = true;
      state.items.unshift(message);
      renderList();
    }
    refreshFoldersSoon();
    const who = displayName(message.from);
    if (settings.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(who, { body: `${message.subject}\n${message.snippet}`, icon: '/icon.svg', tag: `${folder}:${message.id}` });
      n.onclick = () => {
        window.focus();
        if (state.folder !== folder) goFolder(folder);
        setTimeout(() => openRow(rows().find((r) => r.items.some((m) => m.id === message.id))), 600);
        n.close();
      };
    } else if (!document.hidden) {
      toast(`Новое письмо от ${who}`, {
        icon: 'mail',
        action: 'Открыть',
        onAction: () => {
          if (state.folder !== folder) goFolder(folder);
          setTimeout(() => openRow(rows().find((r) => r.items.some((m) => m.id === message.id))), viewing ? 0 : 600);
        },
      });
    }
  });
}

window.addEventListener('focus', () => {
  if (Date.now() - state.lastLoad > 90_000 && !state.loading && !state.selection.size) {
    loadList({ quiet: true });
    loadFolders();
  }
});

// ───────────────────────────────────────────── start

// Mail frames bake the theme in when they render, so redraw them when it changes.
window.addEventListener('aether:look', () => {
  if (state.open && !state.open.loading) renderReader({ keepScroll: true });
});

el.app.addEventListener('click', (e) => {
  if (state.sidebarOpen && !el.sidebar.contains(e.target)) {
    state.sidebarOpen = false;
    renderSidebar();
  }
});

async function start() {
  applyLook();
  renderList();
  renderReader();
  try {
    const info = await api('/api/state');
    state.mode = info.mode;
    state.me = info.account;
    state.ai = info.ai;
  } catch (err) {
    toast(`Сервер не отвечает: ${err.message}`, { error: true, duration: 8000 });
  }
  await loadFolders();
  const wanted = decodeURIComponent(location.hash.slice(1));
  state.folder = folderById(wanted)?.id || folderByRole('inbox')?.id || state.folders[0]?.id || 'INBOX';
  renderSidebar();
  await loadList();
  listen();
  if (state.mode === 'demo' && !sessionStorage.getItem('aether.hello')) {
    try {
      sessionStorage.setItem('aether.hello', '1');
    } catch {
      /* no storage, no greeting memory */
    }
    setTimeout(() => toast(`Это демо-ящик. Нажмите ${modK} — там всё самое интересное`, { icon: 'sparkles', duration: 6000 }), 700);
  }
}

start();
