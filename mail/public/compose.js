import {
  h, svg, iconButton, avatar, escapeHtml, contacts, drafts, settings, toast,
  fileSize, fileToBase64, longDate, mod,
} from './lib.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseTyped(text) {
  const t = text.trim().replace(/[,;]$/, '').trim();
  if (!t) return null;
  const m = /^(.*?)<([^>]+)>$/.exec(t);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim().toLowerCase() };
  return { name: '', address: t.toLowerCase() };
}

/** A To/Cc/Bcc field: people as pills, with autocomplete from everyone you write to. */
class RecipientField {
  constructor(label, initial = [], onChange) {
    this.people = [];
    this.onChange = onChange;
    this.input = h('input', {
      type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': label,
      onkeydown: (e) => this.#key(e), oninput: () => this.#suggest(), onblur: () => setTimeout(() => this.#commit(true), 120),
      onpaste: (e) => {
        const text = e.clipboardData.getData('text');
        if (/[,;\n]/.test(text)) {
          e.preventDefault();
          text.split(/[,;\n]/).forEach((piece) => this.add(parseTyped(piece)));
        }
      },
    });
    this.pills = h('div.recips', { onclick: () => this.input.focus() }, this.input);
    this.box = h('div.suggest', { hidden: true });
    this.labelEl = h('label', label);
    this.el = h('div.field', this.labelEl, this.pills, this.box);
    initial.forEach((p) => this.add(p, true));
  }

  add(person, quiet = false) {
    if (!person?.address) return;
    if (this.people.some((p) => p.address === person.address)) return;
    this.people.push(person);
    const pill = h('span.pill', { class: EMAIL.test(person.address) ? '' : 'bad', title: person.address },
      avatar(person), h('span', person.name || person.address),
      h('button', { type: 'button', 'aria-label': 'Убрать', onclick: (e) => { e.stopPropagation(); this.remove(person); } }, svg('x', 12)));
    pill._person = person;
    this.pills.insertBefore(pill, this.input);
    if (!quiet) this.onChange?.();
  }

  remove(person) {
    this.people = this.people.filter((p) => p !== person);
    [...this.pills.children].find((c) => c._person === person)?.remove();
    this.onChange?.();
  }

  #commit(onBlur = false) {
    const value = this.input.value;
    if (!value.trim()) return false;
    if (onBlur || /[,;\s]$/.test(value) || EMAIL.test(value.trim()) || /<.+>/.test(value)) {
      this.add(parseTyped(value));
      this.input.value = '';
      this.#close();
      return true;
    }
    return false;
  }

  #suggest() {
    const v = this.input.value;
    if (/[,;]$/.test(v)) {
      this.#commit();
      return;
    }
    const found = contacts.search(v, new Set(this.people.map((p) => p.address)));
    this.choices = found;
    this.cursor = 0;
    this.box.replaceChildren(...found.map((c, i) =>
      h('button', { type: 'button', class: i === 0 ? 'on' : '', onmousedown: (e) => { e.preventDefault(); this.#pick(c); } },
        avatar(c, 'sm'), h('div', h('b', c.name || c.address), c.name ? h('small', c.address) : null))));
    this.box.hidden = !found.length;
  }

  #pick(c) {
    this.add({ name: c.name, address: c.address });
    this.input.value = '';
    this.#close();
    this.input.focus();
  }

  #close() {
    this.box.hidden = true;
    this.choices = [];
  }

  #key(e) {
    const open = !this.box.hidden && this.choices?.length;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      this.cursor = (this.cursor + (e.key === 'ArrowDown' ? 1 : -1) + this.choices.length) % this.choices.length;
      [...this.box.children].forEach((b, i) => b.classList.toggle('on', i === this.cursor));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && open) {
      e.preventDefault();
      this.#pick(this.choices[this.cursor]);
      return;
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && this.input.value.trim())) {
      if (this.input.value.trim()) {
        e.preventDefault();
        this.add(parseTyped(this.input.value));
        this.input.value = '';
        this.#close();
      }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      this.#close();
      return;
    }
    if (e.key === 'Backspace' && !this.input.value && this.people.length) {
      this.remove(this.people[this.people.length - 1]);
    }
  }

  values() {
    this.#commit(true);
    return this.people;
  }

  focus() {
    this.input.focus();
  }
}

// ───────────────────────────────────────────── building replies

const reSubject = (s = '') => (/^\s*(re|ответ)\s*:/i.test(s) ? s : `Re: ${s}`);
const fwdSubject = (s = '') => (/^\s*(fwd?|пересл)\s*:/i.test(s) ? s : `Fwd: ${s}`);

function quoteBlock(m) {
  const who = m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address;
  const text = escapeHtml(m.text || '').replace(/\n/g, '<br>');
  return `<div class="attrib"><br>${escapeHtml(longDate(m.date))}, ${escapeHtml(who)} пишет:</div><blockquote type="cite">${text}</blockquote>`;
}

function forwardBlock(m) {
  const row = (k, v) => (v ? `<b>${k}:</b> ${escapeHtml(v)}<br>` : '');
  const list = (xs) => (xs || []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
  return `<div class="fwd"><br>---------- Пересланное сообщение ----------<br>${row('От', list([m.from]))}${row('Дата', longDate(m.date))}${row('Тема', m.subject)}${row('Кому', list(m.to))}${row('Копия', list(m.cc))}<br>${escapeHtml(m.text || '').replace(/\n/g, '<br>')}</div>`;
}

const signatureBlock = () => (settings.signature.trim() ? `<div class="sig"><br>--&nbsp;<br>${escapeHtml(settings.signature).replace(/\n/g, '<br>')}</div>` : '');

export function replyRecipients(m, me, all) {
  const mine = (a) => a.address?.toLowerCase() === me.address?.toLowerCase();
  const fromMe = mine(m.from);
  const to = fromMe ? m.to : (m.replyTo?.length ? m.replyTo : [m.from]);
  if (!all) return { to, cc: [] };
  const seen = new Set(to.map((a) => a.address));
  const cc = [...(fromMe ? [] : m.to), ...(m.cc || [])].filter((a) => !mine(a) && !seen.has(a.address) && seen.add(a.address));
  return { to, cc };
}

// ───────────────────────────────────────────── the composer

let open = [];

export class Composer {
  /**
   * opts: { mode: 'new'|'reply'|'replyAll'|'forward', source, me, prefill, draft, onSend }
   */
  constructor(opts) {
    this.opts = opts;
    this.key = opts.draft?.key || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.attachments = [];
    this.build();
    open.push(this);
    if (open.length > 2) open[0].close({ keepDraft: true });
    document.body.append(this.el);
    (this.to.people.length ? this.editor : this.to).focus();
  }

  static openFor(key) {
    return open.find((c) => c.key === key);
  }

  build() {
    const { mode = 'new', source, me, prefill = {}, draft } = this.opts;
    let to = prefill.to || [];
    let cc = prefill.cc || [];
    let subject = prefill.subject || '';
    let html = prefill.html || '';

    if (source && (mode === 'reply' || mode === 'replyAll')) {
      ({ to, cc } = replyRecipients(source, me, mode === 'replyAll'));
      subject = reSubject(source.subject);
      html = `<div><br></div>${signatureBlock()}${quoteBlock(source)}`;
    } else if (source && mode === 'forward') {
      subject = fwdSubject(source.subject);
      html = `<div><br></div>${signatureBlock()}${forwardBlock(source)}`;
      this.#forwardAttachments(source);
    } else if (!html) {
      html = `<div><br></div>${signatureBlock()}`;
    }
    if (draft) {
      ({ to, cc, subject, html } = draft);
      this.attachments = draft.attachments || [];
    }

    const changed = () => this.#dirty();
    this.to = new RecipientField('Кому', to, changed);
    this.cc = new RecipientField('Копия', cc, changed);
    this.bcc = new RecipientField('Скрытая', draft?.bcc || [], changed);
    this.cc.el.hidden = !cc.length;
    this.bcc.el.hidden = !draft?.bcc?.length;
    this.to.el.append(h('div.toggles',
      h('button', { type: 'button', hidden: !this.cc.el.hidden, onclick: (e) => { this.cc.el.hidden = false; e.currentTarget.hidden = true; this.cc.focus(); } }, 'Копия'),
      h('button', { type: 'button', hidden: !this.bcc.el.hidden, onclick: (e) => { this.bcc.el.hidden = false; e.currentTarget.hidden = true; this.bcc.focus(); } }, 'Скрытая')));

    this.subject = h('input.subject-input', { type: 'text', placeholder: 'Тема', value: subject, 'aria-label': 'Тема', oninput: () => { this.#title(); changed(); } });
    this.editor = h('div.editor', {
      contentEditable: 'true', 'data-placeholder': 'Напишите что-нибудь хорошее…', spellcheck: true, role: 'textbox', 'aria-multiline': 'true',
      html,
      oninput: changed,
      onpaste: (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) {
          e.preventDefault();
          this.addFiles(files);
          return;
        }
        const text = e.clipboardData?.getData('text/plain');
        if (text != null) {
          e.preventDefault();
          document.execCommand('insertText', false, text);
        }
      },
    });

    this.titleEl = h('b');
    this.savedEl = h('span.saved');
    this.attsEl = h('div.c-atts');
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { this.addFiles([...this.fileInput.files]); this.fileInput.value = ''; } });

    const fmt = (cmd, icon, tip) => iconButton(icon, tip, (e) => { e.preventDefault(); this.editor.focus(); document.execCommand(cmd); }, { onmousedown: (e) => e.preventDefault() });

    this.el = h('div.composer', { role: 'dialog', 'aria-label': 'Новое письмо',
      onkeydown: (e) => this.#keys(e),
      ondragover: (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.el.classList.add('dragging'); } },
      ondragleave: (e) => { if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('dragging'); },
      ondrop: (e) => { e.preventDefault(); this.el.classList.remove('dragging'); this.addFiles([...e.dataTransfer.files]); },
    },
      h('div.c-head', { ondblclick: () => this.toggleMax() },
        this.titleEl, this.savedEl,
        iconButton('minus', 'Свернуть', () => this.toggleMin()),
        iconButton('expand', 'Развернуть', () => this.toggleMax()),
        iconButton('x', 'Закрыть', () => this.close({ keepDraft: true }))),
      h('div.c-fields', this.to.el, this.cc.el, this.bcc.el, h('div.field', h('label', 'Тема'), this.subject)),
      h('div.c-body', { onclick: (e) => { if (e.target === e.currentTarget) this.editor.focus(); } }, this.editor),
      this.attsEl,
      h('div.c-foot',
        h('button.send-btn', { type: 'button', onclick: () => this.send() }, svg('send', 16), 'Отправить', h('kbd', `${mod}↵`)),
        iconButton('clip', 'Прикрепить файл', () => this.fileInput.click()),
        h('div.fmt', fmt('bold', 'bold', 'Жирный'), fmt('italic', 'italic', 'Курсив'), fmt('underline', 'underline', 'Подчёркнутый'), fmt('insertUnorderedList', 'list', 'Список'),
          iconButton('link', 'Ссылка', (e) => { e.preventDefault(); this.#link(); }, { onmousedown: (e) => e.preventDefault() })),
        h('div.grow'),
        iconButton('trash', 'Удалить черновик', () => this.discard()),
        this.fileInput));
    this.#title();
    this.#renderAtts();
  }

  #title() {
    const s = this.subject.value.trim();
    this.titleEl.textContent = s || ({ reply: 'Ответ', replyAll: 'Ответ всем', forward: 'Пересылка' }[this.opts.mode] || 'Новое письмо');
  }

  #keys(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      this.send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close({ keepDraft: true });
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.fileInput.click();
    }
    e.stopPropagation(); // the mailbox's own shortcuts stay out of the way while writing
  }

  #link() {
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const url = prompt('Адрес ссылки', 'https://');
    if (!url || url === 'https://') return;
    if (!/^(https?:|mailto:)/i.test(url)) return toast('Ссылка должна начинаться с https:// или mailto:', { error: true });
    this.editor.focus();
    if (range) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (range && !range.collapsed) document.execCommand('createLink', false, url);
    else document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>&nbsp;`);
  }

  #dirty() {
    clearTimeout(this.saveTimer);
    this.savedEl.textContent = '';
    this.saveTimer = setTimeout(() => this.saveDraft(), 900);
  }

  isEmpty() {
    if (this.leadText().trim() || this.attachments.length) return false;
    // A reply's recipients and subject are filled in for you; they alone are not a draft.
    if (this.opts.source) return true;
    return !this.to.people.length && !this.subject.value.trim();
  }

  saveDraft() {
    if (this.sending || this.isEmpty()) return;
    drafts.save({
      key: this.key,
      mode: this.opts.mode,
      to: this.to.people,
      cc: this.cc.people,
      bcc: this.bcc.people,
      subject: this.subject.value,
      html: this.editor.innerHTML,
      inReplyTo: this.opts.source?.messageId || this.opts.draft?.inReplyTo || null,
      references: this.#references(),
      replyTo: this.#replyRef(),
      attachments: this.attachments.filter((a) => a.data && a.size < 1.5 * 1024 * 1024), // keep local storage sane
    });
    this.savedEl.textContent = 'Сохранено';
    this.opts.onDraft?.();
  }

  #references() {
    const s = this.opts.source;
    if (s && this.opts.mode !== 'forward') return [...(s.references || []), s.messageId].filter(Boolean);
    return this.opts.draft?.references || [];
  }

  #replyRef() {
    const s = this.opts.source;
    if (s && this.opts.mode !== 'forward') return { folder: s.folder, id: s.id };
    return this.opts.draft?.replyTo || null;
  }

  // ─────────── attachments

  async addFiles(files) {
    for (const file of files) {
      const att = { filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, data: null, loading: true };
      this.attachments.push(att);
      this.#renderAtts();
      try {
        att.data = await fileToBase64(file);
      } catch {
        toast(`Не удалось прочитать «${file.name}»`, { error: true });
        this.attachments = this.attachments.filter((a) => a !== att);
      }
      att.loading = false;
      this.#renderAtts();
    }
    const total = this.attachments.reduce((n, a) => n + a.size, 0);
    if (total > 25 * 1024 * 1024) toast('Вложения больше 25 МБ — многие почтовые серверы такое не примут', { error: true, duration: 5000 });
    this.#dirty();
  }

  async #forwardAttachments(m) {
    for (const a of (m.attachments || []).filter((x) => !x.inline)) {
      const att = { filename: a.filename, contentType: a.contentType, size: a.size, data: null, loading: true };
      this.attachments.push(att);
      this.#renderAtts();
      try {
        const res = await fetch(`/api/attachment?folder=${encodeURIComponent(m.folder)}&id=${encodeURIComponent(m.id)}&index=${a.index}&download=1`);
        att.data = await fileToBase64(await res.blob());
      } catch {
        this.attachments = this.attachments.filter((x) => x !== att);
      }
      att.loading = false;
      if (this.attsEl) this.#renderAtts();
    }
  }

  #renderAtts() {
    if (!this.attsEl) return;
    this.attsEl.replaceChildren(...this.attachments.map((a) =>
      h('span.c-att', { title: a.filename }, a.loading ? svg('refresh', 14, 'spin') : svg('clip', 14), h('span', a.filename), h('small', fileSize(a.size)),
        iconButton('x', 'Убрать', () => { this.attachments = this.attachments.filter((x) => x !== a); this.#renderAtts(); this.#dirty(); }, { style: { width: '26px', height: '26px' } }))));
  }

  /** Nodes before the signature / quote are what the person is writing. */
  #leadNodes() {
    const out = [];
    for (const n of this.editor.childNodes) {
      if (n.nodeType === 1 && (n.matches('.sig, .attrib, blockquote, .fwd'))) break;
      out.push(n);
    }
    return out;
  }

  leadText() {
    return this.#leadNodes().map((n) => n.textContent).join('\n').replace(/ /g, ' ');
  }

  // ─────────── window

  toggleMin() {
    this.el.classList.remove('max');
    this.el.classList.toggle('min');
  }

  toggleMax() {
    this.el.classList.remove('min');
    this.el.classList.toggle('max');
  }

  restore() {
    if (!this.el.isConnected) {
      document.body.append(this.el);
      open.push(this);
    }
    this.el.hidden = false;
    this.el.classList.remove('min');
    this.sending = false;
    this.editor.focus();
  }

  close({ keepDraft = false } = {}) {
    clearTimeout(this.saveTimer);
    if (keepDraft && !this.isEmpty()) {
      this.saveDraft();
      toast('Черновик сохранён', { icon: 'draft' });
    } else {
      drafts.remove(this.key);
      this.opts.onDraft?.();
    }
    open = open.filter((c) => c !== this);
    this.el.remove();
  }

  discard() {
    const wasEmpty = this.isEmpty();
    const snapshot = this.isEmpty() ? null : this;
    this.close({ keepDraft: false });
    if (!wasEmpty) {
      toast('Черновик удалён', { icon: 'trash', action: 'Вернуть', onAction: () => { snapshot.restore(); snapshot.saveDraft(); } });
    }
  }

  // ─────────── sending

  collect() {
    return {
      to: this.to.values(),
      cc: this.cc.values(),
      bcc: this.bcc.values(),
      subject: this.subject.value.trim(),
      html: this.editor.innerHTML,
      inReplyTo: this.opts.source && this.opts.mode !== 'forward' ? this.opts.source.messageId : this.opts.draft?.inReplyTo || null,
      references: this.#references(),
      replyTo: this.#replyRef(),
      attachments: this.attachments.filter((a) => a.data).map(({ filename, contentType, data }) => ({ filename, contentType, data })),
    };
  }

  send() {
    const mail = this.collect();
    const bad = [...mail.to, ...mail.cc, ...mail.bcc].find((p) => !EMAIL.test(p.address));
    if (!mail.to.length && !mail.cc.length && !mail.bcc.length) {
      toast('Кому отправить? Добавьте получателя', { error: true });
      return this.to.focus();
    }
    if (bad) return toast(`Похоже, адрес «${bad.address}» с ошибкой`, { error: true });
    if (this.attachments.some((a) => a.loading)) return toast('Подождите, вложения ещё загружаются', { icon: 'clip' });
    if (!mail.subject && !confirm('Отправить письмо без темы?')) return;
    const mentionsAttachment = /(прикреп|влож|attach|во вложении)/i.test(this.leadText());
    if (mentionsAttachment && !mail.attachments.length && !confirm('В письме упоминается вложение, но файлов нет. Всё равно отправить?')) return;

    if (!mail.to.length && mail.cc.length) {
      mail.to = mail.cc;
      mail.cc = [];
    }
    contacts.learn([...mail.to, ...mail.cc, ...mail.bcc], 3);
    this.sending = true;
    clearTimeout(this.saveTimer);
    this.saveDraft = () => {}; // nothing to save once it is on its way
    open = open.filter((c) => c !== this);
    this.el.remove();
    this.opts.onSend(mail, this);
  }

  /** Bring the window back after an undo or a failed send, as it was. */
  reopen() {
    this.saveDraft = Composer.prototype.saveDraft;
    this.restore();
  }

  forget() {
    drafts.remove(this.key);
    this.opts.onDraft?.();
  }
}

export const composers = () => open;
