/**
 * The word card, and the list of words you keep.
 *
 * Everything the card shows comes from a model, so every field goes in as text,
 * never as markup. The card opens before the answer arrives — with the word you
 * tapped already in it, and the pronunciation button already working — because
 * a reader who has to wait to find out anything has stopped reading.
 */

const VOICE_TAGS = {
  en: 'en-US', ru: 'ru-RU', es: 'es-ES', fr: 'fr-FR', de: 'de-DE',
  it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', pl: 'pl-PL', uk: 'uk-UA',
  tr: 'tr-TR', ar: 'ar-SA', fa: 'fa-IR', he: 'he-IL', hi: 'hi-IN',
  ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', vi: 'vi-VN', id: 'id-ID',
  sv: 'sv-SE', no: 'nb-NO', da: 'da-DK', fi: 'fi-FI', cs: 'cs-CZ',
  el: 'el-GR', ro: 'ro-RO', hu: 'hu-HU', hy: 'hy-AM', ka: 'ka-GE',
  sr: 'sr-RS', bg: 'bg-BG', kk: 'kk-KZ', az: 'az-AZ', la: 'it-IT',
};

const voiceTag = (code) => VOICE_TAGS[String(code || 'en').slice(0, 2)] || code;

let voices = [];
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices();
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
}

export function canSpeak() {
  return 'speechSynthesis' in window;
}

/** Say it out loud, in the right accent if the device has one. */
export function speak(text, lang, onState) {
  if (!text || !('speechSynthesis' in window)) return false;
  const tag = voiceTag(lang);
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = tag;
    const wanted = tag.toLowerCase();
    const short = wanted.slice(0, 2);
    utterance.voice =
      voices.find((voice) => voice.lang.toLowerCase().replace('_', '-') === wanted) ||
      voices.find((voice) => voice.lang.toLowerCase().startsWith(short)) ||
      null;
    utterance.rate = 0.92;
    utterance.onstart = () => onState?.(true);
    utterance.onend = () => onState?.(false);
    utterance.onerror = () => onState?.(false);
    speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- saved words

const STORE_KEY = 'lectern.words.v1';

export class SavedWords {
  constructor() {
    this.items = [];
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.items = JSON.parse(raw) || [];
    } catch {
      this.items = [];
    }
    this.index = new Set(this.items.map((item) => item.word.toLowerCase()));
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.items.slice(-2000)));
    } catch {
      /* a full or private-mode store is not worth interrupting a reader for */
    }
  }

  has(word) {
    return this.index.has(String(word || '').toLowerCase());
  }

  add(card, context) {
    if (this.has(card.word)) return false;
    this.items.push({
      word: card.word,
      lemma: card.lemma || '',
      translation: card.translation || '',
      meaning: card.meaning || '',
      ipa: card.ipa || '',
      example: card.example || '',
      sentence: context?.sentence || '',
      from: context?.title || '',
      lang: context?.targetLang || '',
      at: Date.now(),
    });
    this.index.add(card.word.toLowerCase());
    this.save();
    return true;
  }

  remove(word) {
    const key = String(word || '').toLowerCase();
    this.items = this.items.filter((item) => item.word.toLowerCase() !== key);
    this.index.delete(key);
    this.save();
  }

  clear() {
    this.items = [];
    this.index.clear();
    this.save();
  }

  all() {
    return [...this.items].reverse();
  }

  /** Tab-separated, which is what every flashcard program will take. */
  toTsv() {
    const escape = (value) => String(value || '').replace(/[\t\r\n]+/g, ' ').trim();
    return this.items
      .map((item) =>
        [item.word, item.translation, item.meaning, item.ipa, item.example, item.sentence]
          .map(escape)
          .join('\t'),
      )
      .join('\n');
  }
}

// ----------------------------------------------------------------- the card

const ICON = {
  speak:
    '<svg viewBox="0 0 20 20"><path d="M4 8v4h3l4 3V5L7 8H4z"/><path d="M14 7.2a4 4 0 0 1 0 5.6"/></svg>',
  star: '<svg viewBox="0 0 20 20"><path d="M10 3.2 12.1 8l5 .4-3.8 3.2 1.2 4.9L10 13.9 5.5 16.5l1.2-4.9L2.9 8.4l5-.4z"/></svg>',
  copy:
    '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>',
};

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class WordCard {
  constructor(options) {
    this.element = options.element;
    this.scrim = options.scrim;
    this.saved = options.saved;
    this.settings = options.settings;
    this.onSavedChange = options.onSavedChange;

    this.cache = new Map();
    this.request = null;
    this.anchor = null;
    this.current = null;

    this.scrim.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.element.hidden) this.close();
    });
    window.addEventListener(
      'scroll',
      () => {
        if (!this.element.hidden) this.position();
      },
      { passive: true },
    );
    window.addEventListener('resize', () => {
      if (!this.element.hidden) this.position();
    });
  }

  close() {
    this.request?.abort();
    this.request = null;
    this.element.hidden = true;
    this.scrim.hidden = true;
    this.anchor?.classList.remove('open');
    this.anchor = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /**
   * @param {Element} anchor the word that was tapped
   * @param {object} query word, sentence, title, sourceLang, targetLang
   */
  async open(anchor, query) {
    this.request?.abort();
    this.anchor?.classList.remove('open');
    this.anchor = anchor;
    anchor?.classList.add('open');
    this.current = query;

    this.element.hidden = false;
    this.scrim.hidden = false;

    const key = `${query.targetLang}|${query.word.toLowerCase()}|${(query.sentence || '')
      .slice(0, 120)
      .toLowerCase()}`;

    const cached = this.cache.get(key);
    if (cached) {
      this.draw(cached, query);
      this.position();
      return;
    }

    this.drawWaiting(query);
    this.position();

    const controller = new AbortController();
    this.request = controller;
    try {
      const response = await fetch('/api/word', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
        signal: controller.signal,
      });
      const card = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || card.error) {
        this.drawFailure(query, card.error || 'that lookup did not come back');
        return;
      }
      this.cache.set(key, card);
      this.draw(card, query);
      this.position();
    } catch (error) {
      if (error.name !== 'AbortError') {
        this.drawFailure(query, 'no answer from the dictionary');
      }
    } finally {
      if (this.request === controller) this.request = null;
    }
  }

  position() {
    if (!this.anchor || window.matchMedia('(max-width: 40rem)').matches) return;
    const rect = this.anchor.getBoundingClientRect();
    const card = this.element;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const margin = 10;

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - margin) {
      const above = rect.top - height - 8;
      top = above > margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  // ------------------------------------------------------------- drawing

  head(query, card) {
    const head = make('div', 'card-head');
    const title = make('h3', 'card-word');
    title.append(document.createTextNode(card?.word || query.word));
    if (card?.lemma && card.lemma.toLowerCase() !== (card.word || '').toLowerCase()) {
      title.append(make('span', 'card-lemma', `  ${card.lemma}`));
    }

    const tools = make('div', 'card-tools');
    const star = make('button', 'card-tool');
    star.type = 'button';
    star.innerHTML = ICON.star;
    star.title = 'Keep this word';
    star.setAttribute('aria-label', 'Keep this word');
    const isSaved = this.saved.has(card?.word || query.word);
    star.classList.toggle('on', isSaved);
    star.addEventListener('click', () => {
      const word = card?.word || query.word;
      if (this.saved.has(word)) this.saved.remove(word);
      else this.saved.add(card || { word }, query);
      star.classList.toggle('on', this.saved.has(word));
      this.onSavedChange?.();
    });

    const copy = make('button', 'card-tool');
    copy.type = 'button';
    copy.innerHTML = ICON.copy;
    copy.title = 'Copy';
    copy.setAttribute('aria-label', 'Copy');
    copy.addEventListener('click', async () => {
      const parts = [card?.word || query.word, card?.translation, card?.meaning].filter(Boolean);
      try {
        await navigator.clipboard.writeText(parts.join(' — '));
        copy.classList.add('on');
        setTimeout(() => copy.classList.remove('on'), 900);
      } catch {
        /* clipboard refused; nothing useful to say about it */
      }
    });

    tools.append(star, copy);
    head.append(title, tools);
    return head;
  }

  sayButton(text, lang, audioUrl) {
    const button = make('button', 'say');
    button.type = 'button';
    button.innerHTML = ICON.speak;
    button.title = 'Hear it';
    button.setAttribute('aria-label', 'Hear it');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (audioUrl) {
        button.classList.add('playing');
        const audio = new Audio(audioUrl);
        audio.onended = () => button.classList.remove('playing');
        audio.onerror = () => {
          button.classList.remove('playing');
          speak(text, lang, (on) => button.classList.toggle('playing', on));
        };
        audio.play().catch(() => {
          button.classList.remove('playing');
          speak(text, lang, (on) => button.classList.toggle('playing', on));
        });
        return;
      }
      speak(text, lang, (on) => button.classList.toggle('playing', on));
    });
    return button;
  }

  drawWaiting(query) {
    this.element.textContent = '';
    this.element.append(this.head(query, null));

    const say = make('div', 'card-say');
    say.append(this.sayButton(query.word, query.sourceLang));
    say.append(make('span', 'card-ipa', 'looking it up'));
    this.element.append(say);

    const wait = make('div', 'card-wait');
    wait.append(make('i'), make('i'), make('i'));
    this.element.append(wait);
  }

  drawFailure(query, message) {
    this.element.textContent = '';
    this.element.append(this.head(query, null));
    const say = make('div', 'card-say');
    say.append(this.sayButton(query.word, query.sourceLang));
    this.element.append(say);
    this.element.append(make('p', 'card-bad', message));
  }

  draw(card, query) {
    const element = this.element;
    element.textContent = '';
    element.append(this.head(query, card));

    const say = make('div', 'card-say');
    say.append(this.sayButton(card.word || query.word, query.sourceLang, card.audio));
    if (card.ipa) say.append(make('span', 'card-ipa', `/${card.ipa}/`));
    if (card.pos) say.append(make('span', 'card-pos', card.pos));
    element.append(say);

    if (card.translation) {
      const row = make('div', 'card-translation');
      row.append(make('b', null, card.translation));
      row.append(this.sayButton(card.translation, query.targetLang));
      element.append(row);
    }

    if (card.meaning) element.append(make('p', 'card-meaning', card.meaning));
    if (card.note) element.append(make('p', 'card-note', card.note));
    if (card.example) element.append(make('p', 'card-example', card.example));

    const extras = [];
    if (Array.isArray(card.senses) && card.senses.length) extras.push('senses');
    if (card.forms) extras.push('forms');
    if (card.etymology) extras.push('etymology');

    if (extras.length) {
      const more = make('details', 'card-more');
      const summary = make('summary', null, 'Other senses and forms');
      more.append(summary);
      for (const sense of card.senses || []) {
        const line = make('p', 'card-sense');
        if (sense.pos) line.append(make('i', null, sense.pos));
        line.append(document.createTextNode(sense.gloss || ''));
        if (sense.translation) {
          line.append(document.createTextNode('  '));
          line.append(make('b', null, sense.translation));
        }
        more.append(line);
      }
      if (card.forms) more.append(make('p', 'card-meta', card.forms));
      if (card.etymology) more.append(make('p', 'card-meta', card.etymology));
      element.append(more);
    }

    if (query.sentence && query.sentence.length > (card.word || '').length + 4) {
      const line = make('p', 'card-sentence');
      const word = card.word || query.word;
      const at = query.sentence.toLowerCase().indexOf(word.toLowerCase());
      if (at >= 0) {
        line.append(document.createTextNode(query.sentence.slice(0, at)));
        line.append(make('mark', null, query.sentence.slice(at, at + word.length)));
        line.append(document.createTextNode(query.sentence.slice(at + word.length)));
      } else {
        line.textContent = query.sentence;
      }
      element.append(line);
    }

    if (card.hint) element.append(make('p', 'card-meta', card.hint));
  }
}
