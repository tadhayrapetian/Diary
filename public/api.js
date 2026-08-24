// Разговор с сервером и настройки, которые живут в браузере.

const json = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `ошибка ${response.status}`);
  return data;
};

export const api = {
  library: () => fetch('/api/library').then(json),
  book: (id) => fetch(`/api/books/${id}`).then(json),
  chapter: (id, index) => fetch(`/api/books/${id}/chapter/${index}`).then(json),
  note: (id, note) => fetch(`/api/books/${id}/note/${encodeURIComponent(note)}`).then(json),
  find: (id, query) => fetch(`/api/books/${id}/search?q=${encodeURIComponent(query)}`).then(json),
  remove: (id) => fetch(`/api/books/${id}`, { method: 'DELETE' }).then(json),
  patch: (id, patch) => fetch(`/api/books/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(json),
  upload: (file) => fetch('/api/books', {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  }).then(json),
  putCover: (id, blob) => fetch(`/api/books/${id}/cover`, { method: 'PUT', body: blob }).then(json),
  // Уходя со страницы, обычный fetch отменяют вместе с ней. Маячок доезжает.
  saveProgress: (id, progress) => {
    const body = JSON.stringify(progress);
    if (navigator.sendBeacon?.(`/api/books/${id}/progress`, new Blob([body], { type: 'application/json' }))) return true;
    fetch(`/api/books/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
    return false;
  },
  lookup: (payload) => fetch('/api/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json),
};

// Настройки чтения — на устройстве: на телефоне свой кегль, на планшете свой.
const DEFAULTS = {
  theme: 'paper',
  fontScale: 100,
  fontFamily: 'serif',
  lineHeight: 162,
  margins: 8,
  // На узкой колонке выключка по ширине рвёт строки на куски, на широкой —
  // наоборот, держит страницу. Поэтому умолчание зависит от экрана.
  justify: window.innerWidth >= 640,
  scroll: false,
  sort: 'recent',
};

const KEY = 'polka.settings';

const load = () => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
};

export const settings = {
  values: load(),
  get(name) { return this.values[name]; },
  set(name, value) {
    this.values[name] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch { /* приватный режим — переживём */ }
    return value;
  },
};

// Место, на котором остановились: сервер знает, но локально быстрее и работает,
// даже если книга открыта в двух окнах.
export const lastPlace = {
  get(id) {
    try {
      return JSON.parse(localStorage.getItem(`polka.place.${id}`) || 'null');
    } catch {
      return null;
    }
  },
  set(id, place) {
    try {
      localStorage.setItem(`polka.place.${id}`, JSON.stringify(place));
    } catch { /* ничего страшного */ }
  },
};
