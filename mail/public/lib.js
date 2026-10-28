import { icon } from './icons.js';

// ───────────────────────────────────────────── dom

/** h('div.row.unread', {onclick}, child, 'text', [more]) */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const svg = (name, size, extra) => {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, extra);
  return t.content.firstChild;
};

export function iconButton(name, tip, onclick, extra = {}) {
  return h('button.icon-btn', { 'data-tip': tip, 'aria-label': tip, onclick, type: 'button', ...extra }, svg(name, 18));
}

export function escapeHtml(text = '') {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ───────────────────────────────────────────── network

const HEADERS = { 'X-Aether': '1' };

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? { headers: HEADERS } : {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: JSON.stringify(body).length < 60_000,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

/** POST that answers with server-sent events; calls onEvent(name, data). */
export async function streamPost(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Ошибка ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

// ───────────────────────────────────────────── formatting

const DAY = 86_400_000;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function shortDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = startOfDay(now) - startOfDay(d);
  if (diff <= 0) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (diff === DAY) return 'вчера';
  if (diff < 7 * DAY) return d.toLocaleDateString('ru', { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }).replace('.', '');
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short', year: '2-digit' });
}

export function longDate(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const diff = startOfDay(new Date()) - startOfDay(d);
  const rel = diff <= 0 ? 'сегодня' : diff === DAY ? 'вчера' : d.toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return `${rel}, ${time}`;
}

export function dateGroup(iso) {
  const diff = startOfDay(new Date()) - startOfDay(new Date(iso));
  if (diff <= 0) return 'Сегодня';
  if (diff === DAY) return 'Вчера';
  if (diff < 7 * DAY) return 'На этой неделе';
  if (diff < 30 * DAY) return 'В этом месяце';
  return 'Ранее';
}

export function fileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
}

export const displayName = (a) => (a ? a.name || a.address?.split('@')[0] || 'Без имени' : 'Без имени');

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ───────────────────────────────────────────── avatars

function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619);
  return x >>> 0;
}

export function initials(person) {
  const name = displayName(person).replace(/[«»"'()[\]]/g, '').trim();
  const parts = name.split(/[\s._-]+/).filter((p) => /\p{L}|\d/u.test(p));
  const first = parts[0]?.match(/[\p{L}\d]/u)?.[0] || '?';
  const second = parts.length > 1 ? parts[1].match(/[\p{L}\d]/u)?.[0] || '' : '';
  return (first + second).toUpperCase();
}

export function avatar(person, size = '') {
  const seed = hash((person?.address || person?.name || '?').toLowerCase());
  const h1 = seed % 360;
  const h2 = (h1 + 40 + (seed >> 9) % 60) % 360;
  return h(`div.avatar${size ? `.${size}` : ''}`, {
    style: { background: `linear-gradient(135deg, hsl(${h1} 75% 62%), hsl(${h2} 80% 52%))` },
    title: person?.address || '',
  }, initials(person));
}

const FILE_COLORS = { pdf: '#e5484d', doc: '#3e63dd', docx: '#3e63dd', xls: '#30a46c', xlsx: '#30a46c', csv: '#30a46c', ppt: '#f76b15', pptx: '#f76b15', zip: '#8e4ec6', rar: '#8e4ec6', txt: '#6f6e77' };

export function fileBadge(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase().slice(0, 4);
  return { ext: ext.toUpperCase() || 'FILE', color: FILE_COLORS[ext] || '#6e5bff' };
}

// ───────────────────────────────────────────── persistence

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full storage — settings just won't stick */
  }
}

export const DEFAULT_SETTINGS = {
  theme: 'auto',
  accent: 252,
  density: 'comfortable',
  undoSeconds: 5,
  signature: '',
  notify: false,
  remoteImages: 'ask',
  trusted: [],
  conversations: true,
  skin: 'aether', // aether | outlook2003 | outlook2007
};

export const SKINS = [
  { value: 'aether', label: 'Aether' },
  { value: 'outlook2003', label: 'Outlook 2003' },
  { value: 'outlook2007', label: 'Outlook 2007' },
];
export const isClassic = () => settings.skin !== 'aether';

export const settings = { ...DEFAULT_SETTINGS, ...read('aether.settings', {}) };

export function saveSettings(patch) {
  Object.assign(settings, patch);
  write('aether.settings', settings);
  applyLook();
}

export function applyLook() {
  const root = document.documentElement;
  // The classic skins are as they were in 2003: there was no dark mode.
  const dark = !isClassic() && (settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
  root.dataset.scheme = dark ? 'dark' : 'light';
  root.dataset.skin = settings.skin;
  root.dataset.density = settings.density;
  root.style.setProperty('--accent-h', settings.accent);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0d12' : '#f4f3f0');
  window.dispatchEvent(new Event('aether:look'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook);

/** Everyone you have exchanged mail with, ranked for autocomplete. */
export const contacts = {
  map: new Map(Object.entries(read('aether.contacts', {}))),
  learn(people, weight = 1) {
    let changed = false;
    for (const p of people) {
      if (!p?.address || /no-?reply|notifications?@|mailer-daemon/i.test(p.address)) continue;
      const key = p.address.toLowerCase();
      const prev = this.map.get(key) || { name: '', address: key, score: 0 };
      this.map.set(key, { name: p.name || prev.name, address: key, score: prev.score + weight });
      changed = true;
    }
    if (changed) {
      clearTimeout(this.t);
      this.t = setTimeout(() => write('aether.contacts', Object.fromEntries([...this.map].sort((a, b) => b[1].score - a[1].score).slice(0, 800))), 800);
    }
  },
  search(q, exclude = new Set()) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return [...this.map.values()]
      .filter((c) => !exclude.has(c.address) && (c.address.includes(needle) || c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(needle)) || c.name.toLowerCase().includes(needle)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  },
};

export const drafts = {
  all: () => read('aether.drafts', {}),
  save(d) {
    const all = this.all();
    all[d.key] = { ...d, savedAt: new Date().toISOString() };
    write('aether.drafts', all);
  },
  remove(key) {
    const all = this.all();
    delete all[key];
    write('aether.drafts', all);
  },
};

// ───────────────────────────────────────────── toasts

const toastRoot = () => document.getElementById('toasts');

/**
 * toast('Текст', { action: 'Отменить', onAction, duration, error, icon })
 * Returns { close } so callers can dismiss it early.
 */
export function toast(text, opts = {}) {
  const duration = opts.duration ?? (opts.action ? 5000 : 3200);
  const el = h('div.toast', { class: opts.error ? 'error' : '' }, svg(opts.icon || (opts.error ? 'spam' : 'check'), 18), h('span', text));
  let done = false;
  const close = (byAction = false) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
    if (!byAction) opts.onExpire?.();
  };
  if (opts.action) {
    el.append(h('button', { onclick: () => { close(true); opts.onAction?.(); } }, opts.action));
  }
  if (opts.progress) el.append(h('i.bar', { style: { animationDuration: `${duration}ms` } }));
  const root = toastRoot();
  while (root.children.length > 2) root.firstChild.remove();
  root.append(el);
  const timer = setTimeout(() => close(false), duration);
  return { close: () => close(true), expire: () => close(false) };
}

// ───────────────────────────────────────────── misc

export function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
export const modK = mod === '⌘' ? '⌘K' : 'Ctrl+K';
