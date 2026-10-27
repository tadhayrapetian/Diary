import { h, svg, iconButton, settings, saveSettings, toast, mod, escapeHtml } from './lib.js';

let current = null;

function overlay(content, { onClose, label } = {}) {
  closeOverlay();
  const scrim = h('div.scrim', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': label || '',
    onmousedown: (e) => { if (e.target === scrim) closeOverlay(); },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeOverlay();
      }
      e.stopPropagation();
    },
  }, content);
  current = { scrim, onClose, focus: document.activeElement };
  scrim.tabIndex = -1;
  document.body.append(scrim);
  scrim.focus();
  return scrim;
}

export function closeOverlay() {
  if (!current) return false;
  const { scrim, onClose, focus } = current;
  current = null;
  scrim.remove();
  onClose?.();
  if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
  return true;
}

export const overlayOpen = () => Boolean(current);

// ───────────────────────────────────────────── command palette

function score(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 60 - i;
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at += 1;
  }
  return 10;
}

function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, i))}<mark>${escapeHtml(text.slice(i, i + q.length))}</mark>${escapeHtml(text.slice(i + q.length))}`;
}

/** commands: [{ section, title, icon, keys: ['g','i'], keywords, run }] */
export function openPalette(commands, { onSearch } = {}) {
  let cursor = 0;
  let shown = [];
  const list = h('div.palette-list');
  const input = h('input', {
    type: 'text', placeholder: 'Команда, папка или поиск по почте…', autocomplete: 'off', spellcheck: false,
    oninput: () => { cursor = 0; render(); },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(shown[cursor]);
      }
    },
  });

  const run = (cmd) => {
    if (!cmd) return;
    closeOverlay();
    cmd.run();
  };

  const paint = () => {
    [...list.querySelectorAll('.palette-item')].forEach((el, i) => {
      el.classList.toggle('on', i === cursor);
      if (i === cursor) el.scrollIntoView({ block: 'nearest' });
    });
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = commands
      .map((c) => ({ c, s: Math.max(score(c.title, q), c.keywords ? score(c.keywords, q) * 0.8 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .map((x) => x.c);
    if (q && onSearch) {
      shown.push({ section: 'Поиск', title: `Искать «${input.value.trim()}» в почте`, icon: 'search', run: () => onSearch(input.value.trim()) });
    }
    const nodes = [];
    let section = null;
    shown.forEach((c, i) => {
      if (c.section !== section && !q) {
        section = c.section;
        nodes.push(h('div.palette-section', section));
      }
      nodes.push(h('button.palette-item', { type: 'button', class: i === cursor ? 'on' : '', onclick: () => run(c), onmousemove: () => { if (cursor !== i) { cursor = i; paint(); } } },
        svg(c.icon || 'command', 18), h('span', { html: highlight(c.title, q) }),
        c.keys ? h('span', ...c.keys.map((k) => h('kbd', k))) : null));
    });
    list.replaceChildren(...(nodes.length ? nodes : [h('div.palette-empty', 'Ничего не нашлось')]));
  };

  overlay(h('div.sheet', h('div.palette-input', svg('command', 20), input, h('kbd', 'esc')), list), { label: 'Палитра команд' });
  render();
  input.focus();
}

// ───────────────────────────────────────────── settings

const ACCENTS = [
  { h: 252, name: 'Фиалка' },
  { h: 214, name: 'Океан' },
  { h: 172, name: 'Мята' },
  { h: 145, name: 'Лес' },
  { h: 32, name: 'Янтарь' },
  { h: 350, name: 'Роза' },
  { h: 290, name: 'Орхидея' },
];

function seg(options, value, onPick) {
  const el = h('div.seg', { role: 'radiogroup' });
  const draw = (v) =>
    el.replaceChildren(...options.map((o) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(o.value === v), class: o.value === v ? 'on' : '', onclick: () => { draw(o.value); onPick(o.value); } },
        o.icon ? svg(o.icon, 15) : null, o.label)));
  draw(value);
  return el;
}

function toggle(value, onFlip) {
  const el = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(value), class: value ? 'on' : '' });
  el.addEventListener('click', () => {
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next);
    el.setAttribute('aria-checked', String(next));
    onFlip(next, el);
  });
  return el;
}

const row = (title, hint, control, stack = false) =>
  h('div.setting', { class: stack ? 'stack' : '' }, h('div.lbl', h('b', title), hint ? h('small', hint) : null), control);

export function openSettings({ onChange, state }) {
  const swatches = h('div.swatches');
  const drawSwatches = () =>
    swatches.replaceChildren(...ACCENTS.map((a) =>
      h('button.swatch', { type: 'button', title: a.name, 'aria-label': a.name, class: settings.accent === a.h ? 'on' : '',
        style: { background: `linear-gradient(135deg, hsl(${a.h} 85% 66%), hsl(${a.h + 30} 85% 56%))`, color: `hsl(${a.h} 85% 60%)` },
        onclick: () => { saveSettings({ accent: a.h }); drawSwatches(); onChange?.(); } })));
  drawSwatches();

  const sig = h('textarea.sig-input', { placeholder: 'Например:\nАлекс\n+7 900 000-00-00', value: settings.signature });
  sig.addEventListener('input', () => saveSettings({ signature: sig.value }));

  const body = h('div.settings',
    row('Тема', null, seg([{ value: 'light', label: 'Светлая', icon: 'sun' }, { value: 'dark', label: 'Тёмная', icon: 'moon' }, { value: 'auto', label: 'Авто', icon: 'monitor' }], settings.theme, (v) => { saveSettings({ theme: v }); onChange?.(); })),
    row('Акцент', null, swatches),
    row('Плотность списка', null, seg([{ value: 'comfortable', label: 'Просторно' }, { value: 'compact', label: 'Компактно' }], settings.density, (v) => saveSettings({ density: v }))),
    row('Цепочки писем', 'Собирать ответы в одну беседу', toggle(settings.conversations, (v) => { saveSettings({ conversations: v }); onChange?.('reload'); })),
    row('Отмена отправки', 'Сколько секунд можно передумать', seg([0, 5, 10, 20].map((n) => ({ value: n, label: n ? `${n} с` : 'Нет' })), settings.undoSeconds, (v) => saveSettings({ undoSeconds: v }))),
    row('Картинки из интернета', 'Внешние картинки часто следят за прочтением', seg([{ value: 'ask', label: 'Спрашивать' }, { value: 'always', label: 'Показывать' }], settings.remoteImages, (v) => saveSettings({ remoteImages: v }))),
    row('Уведомления', 'Показывать новые письма, когда вкладка в фоне', toggle(settings.notify, async (v, el) => {
      if (v && 'Notification' in window && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') {
          el.classList.remove('on');
          toast('Браузер не разрешил уведомления', { error: true });
          return;
        }
      }
      saveSettings({ notify: v });
    })),
    row('Подпись', 'Добавляется в новые письма и ответы', sig, true),
    state?.mode === 'demo' ? h('div.setting', h('div.lbl', h('b', 'Демо-режим'), h('small', 'Письма ненастоящие. Чтобы подключить свою почту, заполните .env (см. README) и перезапустите сервер.'))) : null);

  overlay(h('div.sheet', h('div.sheet-head', h('h2', 'Настройки'), iconButton('x', 'Закрыть', closeOverlay)), body), { label: 'Настройки' });
}

// ───────────────────────────────────────────── shortcuts

const KEYS = [
  ['Следующее / предыдущее', ['j'], ['k']],
  ['Открыть письмо', ['↵']],
  ['Назад к списку', ['esc']],
  ['Написать', ['c']],
  ['Ответить', ['r']],
  ['Ответить всем', ['a']],
  ['Переслать', ['f']],
  ['Архивировать', ['e']],
  ['Удалить', ['#']],
  ['В спам', ['!']],
  ['Избранное', ['s']],
  ['Прочитано / нет', ['u']],
  ['Выбрать', ['x']],
  ['Выбрать всё', [mod, 'a']],
  ['Поиск', ['/']],
  ['Кратко от Claude', ['.']],
  ['Палитра команд', [mod, 'k']],
  ['Входящие', ['g', 'i']],
  ['Избранное (папка)', ['g', 's']],
  ['Отправленные', ['g', 't']],
  ['Черновики', ['g', 'd']],
  ['Обновить', ['shift', 'r']],
  ['Настройки', [',']],
  ['Эта справка', ['?']],
];

export function openShortcuts() {
  const keys = h('div.keys', ...KEYS.map(([label, ...combos]) =>
    h('div', h('span', label), h('span', ...combos.flatMap((combo, i) => [i ? h('span', { style: { color: 'var(--ink-4)' } }, '/') : null, ...combo.map((k) => h('kbd', k))])))));
  overlay(h('div.sheet', h('div.sheet-head', h('h2', 'Горячие клавиши'), iconButton('x', 'Закрыть', closeOverlay)), keys), { label: 'Горячие клавиши' });
}

// ───────────────────────────────────────────── menus

let menuEl = null;

export function closeMenu() {
  if (!menuEl) return false;
  menuEl.remove();
  menuEl = null;
  return true;
}

/** items: [{ icon, label, run } | '-'] at an element or at {x, y} */
export function showMenu(at, items) {
  closeMenu();
  const el = h('div.menu', { role: 'menu', onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } } },
    ...items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); it.run(); } }, svg(it.icon || 'folder', 16), it.label))));
  document.body.append(el);
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let x = at instanceof Element ? r.right - w : r.left;
  let y = r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  if (y + hgt > innerHeight - 8) y = Math.max(8, r.top - hgt - 6);
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  menuEl = el;
  el.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!el.contains(e.target)) {
      closeMenu();
      document.removeEventListener('mousedown', off);
    }
  }), 0);
}
