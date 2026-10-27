import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import {
  addressList,
  decodePart,
  findTextPart,
  hasAttachments,
  htmlToText,
  normalizeSubject,
  snippetFrom,
  stripSubject,
  textToHtml,
} from './util.js';

const ROLE_BY_FLAG = {
  '\\Inbox': 'inbox',
  '\\Flagged': 'flagged',
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
};

const ROLE_ORDER = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];

const ROLE_NAMES = {
  inbox: 'Входящие',
  flagged: 'Избранное',
  drafts: 'Черновики',
  sent: 'Отправленные',
  archive: 'Архив',
  all: 'Вся почта',
  junk: 'Спам',
  trash: 'Корзина',
};

const FLAG_NAMES = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered' };

const toIso = (value) => {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });

/**
 * A real account over IMAP (reading) and SMTP (sending). One connection does the
 * work; a second sits idle on the inbox and reports new mail as it lands.
 */
export class ImapStore extends EventEmitter {
  constructor({ imap, smtp, from }) {
    super();
    this.kind = 'imap';
    this.imapConfig = imap;
    this.from = from;
    this.isGmail = /(^|\.)(gmail|googlemail)\.com$/i.test(imap.host);
    this.transport = nodemailer.createTransport(smtp);
    this.client = null;
    this.connecting = null;
    this.roles = null;
    this.parsed = new Map(); // small LRU of parsed messages, for attachments and threads
  }

  // ------------------------------------------------------------ connections

  #newClient(extra = {}) {
    return new ImapFlow({ ...this.imapConfig, logger: false, emitLogs: false, ...extra });
  }

  async #conn() {
    if (this.client?.usable) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.#newClient();
        client.on('error', (err) => console.error('[mail] imap:', err.message));
        client.on('close', () => {
          if (this.client === client) this.client = null;
        });
        await client.connect();
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async #withMailbox(path, fn) {
    const client = await this.#conn();
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }

  /** Keep a second connection idling on INBOX so new mail is pushed, not polled. */
  async watch() {
    let delay = 2000;
    const start = async () => {
      const watcher = this.#newClient({ autoIdleDelay: 200 }); // it has nothing else to do but listen
      watcher.on('error', (err) => console.error('[mail] watcher:', err.message));
      watcher.on('close', () => {
        setTimeout(start, delay).unref();
        delay = Math.min(delay * 2, 60_000);
      });
      try {
        await watcher.connect();
        const inbox = await this.#rolePath('inbox');
        await watcher.mailboxOpen(inbox, { readOnly: true });
        delay = 2000;
        watcher.on('exists', async ({ count, prevCount }) => {
          if (count <= prevCount) return;
          try {
            const items = await this.#summaries(watcher, `${prevCount + 1}:${count}`, inbox, false);
            for (const message of items) this.emit('new', { folder: inbox, message });
          } catch (err) {
            console.error('[mail] new mail fetch failed:', err.message);
          }
        });
      } catch (err) {
        console.error('[mail] watcher could not start:', err.message);
        watcher.close();
      }
    };
    start();
  }

  // ------------------------------------------------------------ folders

  async #rolePath(role) {
    if (!this.roles) await this.folders();
    return this.roles[role] || (role === 'inbox' ? 'INBOX' : null);
  }

  async info() {
    return { name: this.from.name || this.from.address, address: this.from.address };
  }

  async folders() {
    const client = await this.#conn();
    const list = await client.list({ statusQuery: { messages: true, unseen: true } });
    const roles = {};
    const out = [];
    for (const f of list) {
      if (f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')) continue;
      const role = ROLE_BY_FLAG[f.specialUse] || (f.path.toUpperCase() === 'INBOX' ? 'inbox' : null);
      if (role && !roles[role]) roles[role] = f.path;
      out.push({
        id: f.path,
        name: role ? ROLE_NAMES[role] : f.name,
        role,
        total: f.status?.messages ?? 0,
        unread: f.status?.unseen ?? 0,
      });
    }
    this.roles = roles;
    const rank = (f) => (f.role ? ROLE_ORDER.indexOf(f.role) : ROLE_ORDER.length);
    return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ru'));
  }

  // ------------------------------------------------------------ listing

  /** Envelopes for a range, plus a decoded preview line for each. */
  async #summaries(client, range, folder, byUid) {
    const rows = [];
    for await (const msg of client.fetch(
      range,
      { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, threadId: true },
      { uid: byUid },
    )) {
      rows.push(msg);
    }

    // Previews: one partial fetch per distinct body-part address, not one per message.
    const byPart = new Map();
    for (const msg of rows) {
      const part = findTextPart(msg.bodyStructure);
      if (!part) continue;
      msg._text = part;
      const key = part.part || '1';
      if (!byPart.has(key)) byPart.set(key, []);
      byPart.get(key).push(msg.uid);
    }
    const previews = new Map();
    for (const [key, uids] of byPart) {
      try {
        for await (const msg of client.fetch(uids.join(','), { uid: true, bodyParts: [{ key, start: 0, maxLength: 3000 }] }, { uid: true })) {
          const raw = msg.bodyParts?.get(key) || [...(msg.bodyParts?.values() || [])][0];
          previews.set(msg.uid, { raw, binary: msg.binaryParts?.has(key) });
        }
      } catch (err) {
        console.error('[mail] preview fetch failed:', err.message);
      }
    }

    return rows.map((msg) => {
      const env = msg.envelope || {};
      let snippet = '';
      const p = previews.get(msg.uid);
      if (p?.raw && msg._text) {
        const decoded = decodePart(p.raw, {
          encoding: msg._text.encoding,
          charset: msg._text.parameters?.charset,
          binary: p.binary,
        });
        snippet = snippetFrom(/html/i.test(msg._text.type) ? htmlToText(decoded) : decoded);
      }
      return {
        id: String(msg.uid),
        folder,
        threadId: msg.threadId || normalizeSubject(env.subject),
        from: addressList(env.from)[0] || { name: '', address: '' },
        to: addressList(env.to),
        cc: addressList(env.cc),
        subject: env.subject || '',
        snippet,
        date: toIso(env.date || msg.internalDate),
        seen: msg.flags?.has('\\Seen') ?? false,
        flagged: msg.flags?.has('\\Flagged') ?? false,
        answered: msg.flags?.has('\\Answered') ?? false,
        hasAttachments: hasAttachments(msg.bodyStructure),
      };
    });
  }

  #criteria(q, filter) {
    const c = {};
    if (q) {
      if (this.isGmail) c.gmailraw = q; // Gmail's own search syntax works as-is
      else c.or = [{ subject: q }, { from: q }, { to: q }, { body: q }];
    }
    if (filter === 'unread') c.seen = false;
    if (filter === 'flagged') c.flagged = true;
    if (filter === 'attachments') {
      if (this.isGmail) c.gmailraw = `${c.gmailraw || ''} has:attachment`.trim();
      else c.header = { 'content-type': 'multipart/mixed' };
    }
    return Object.keys(c).length ? c : null;
  }

  async list({ folder = 'INBOX', q = '', filter = 'all', offset = 0, limit = 50 }) {
    if (q && this.isGmail) folder = (await this.#rolePath('all')) || folder;
    return this.#withMailbox(folder, async (client) => {
      const criteria = this.#criteria(q, filter);
      if (!criteria) {
        const exists = client.mailbox.exists;
        const end = exists - offset;
        if (end < 1) return { items: [], next: null, total: exists };
        const start = Math.max(1, end - limit + 1);
        const items = await this.#summaries(client, `${start}:${end}`, folder, false);
        items.sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
        return { items, next: start > 1 ? offset + limit : null, total: exists };
      }
      const uids = ((await client.search(criteria, { uid: true })) || []).sort((a, b) => b - a);
      const slice = uids.slice(offset, offset + limit);
      const items = slice.length ? await this.#summaries(client, slice.join(','), folder, true) : [];
      items.sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
      return { items, next: offset + limit < uids.length ? offset + limit : null, total: uids.length };
    });
  }

  // ------------------------------------------------------------ reading

  async #parsed(folder, id) {
    const key = `${folder}\u0000${id}`;
    if (this.parsed.has(key)) {
      const hit = this.parsed.get(key);
      this.parsed.delete(key);
      this.parsed.set(key, hit);
      return hit;
    }
    const entry = await this.#withMailbox(folder, async (client) => {
      const meta = await client.fetchOne(String(id), { uid: true, flags: true, threadId: true }, { uid: true });
      if (!meta) throw notFound('message');
      const { content } = await client.download(String(id), undefined, { uid: true });
      const mail = await simpleParser(content, { skipImageLinks: true, skipTextToHtml: false });
      return { meta, mail };
    });
    this.parsed.set(key, entry);
    while (this.parsed.size > 40) this.parsed.delete(this.parsed.keys().next().value);
    return entry;
  }

  #full(folder, id, { meta, mail }) {
    const text = mail.text || htmlToText(mail.html || '');
    const attachments = (mail.attachments || []).map((a, index) => ({
      index,
      filename: a.filename || `attachment-${index + 1}`,
      contentType: a.contentType,
      size: a.size,
      cid: a.cid || null,
      inline: Boolean(a.cid && a.related),
    }));
    return {
      id: String(id),
      folder,
      threadId: meta.threadId || normalizeSubject(mail.subject),
      from: addressList(mail.from)[0] || { name: '', address: '' },
      to: addressList(mail.to),
      cc: addressList(mail.cc),
      replyTo: addressList(mail.replyTo),
      subject: mail.subject || '',
      snippet: snippetFrom(text),
      date: toIso(mail.date),
      seen: meta.flags?.has('\\Seen') ?? false,
      flagged: meta.flags?.has('\\Flagged') ?? false,
      answered: meta.flags?.has('\\Answered') ?? false,
      hasAttachments: attachments.some((a) => !a.inline),
      html: mail.html || mail.textAsHtml || textToHtml(text),
      text,
      plain: !mail.html,
      messageId: mail.messageId || null,
      inReplyTo: mail.inReplyTo || null,
      references: [].concat(mail.references || []),
      attachments,
    };
  }

  async get(folder, id) {
    return this.#full(folder, id, await this.#parsed(folder, id));
  }

  async thread(folder, id) {
    const root = await this.get(folder, id);
    const base = normalizeSubject(root.subject);
    if (!base) return [root];
    // Search with the original casing: not every server folds case outside ASCII.
    const needle = stripSubject(root.subject).slice(0, 80);

    const places = [...new Set([folder, await this.#rolePath('sent')].filter(Boolean))];
    const found = [];
    for (const place of places) {
      try {
        const uids = await this.#withMailbox(place, async (client) =>
          ((await client.search({ subject: needle }, { uid: true })) || []).sort((a, b) => b - a).slice(0, 12),
        );
        for (const uid of uids) found.push({ folder: place, id: String(uid) });
      } catch (err) {
        console.error('[mail] thread search failed in', place, err.message);
      }
    }

    const seen = new Set();
    const out = [];
    for (const ref of found) {
      try {
        const m = ref.folder === folder && ref.id === String(id) ? root : await this.get(ref.folder, ref.id);
        if (normalizeSubject(m.subject) !== base) continue;
        const key = m.messageId || `${m.folder}:${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      } catch {
        /* a message that vanished between search and fetch is simply skipped */
      }
    }
    if (!out.some((m) => m.folder === folder && m.id === String(id))) out.push(root);
    return out.sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id)).slice(-15);
  }

  async attachment(folder, id, index) {
    const { mail } = await this.#parsed(folder, id);
    const a = mail.attachments?.[Number(index)];
    if (!a) throw notFound('attachment');
    return { filename: a.filename || `attachment-${Number(index) + 1}`, contentType: a.contentType, content: a.content };
  }

  // ------------------------------------------------------------ changing

  async flags(folder, ids, { add = [], remove = [] }) {
    const range = ids.join(',');
    const plus = add.map((f) => FLAG_NAMES[f]).filter(Boolean);
    const minus = remove.map((f) => FLAG_NAMES[f]).filter(Boolean);
    await this.#withMailbox(folder, async (client) => {
      if (plus.length) await client.messageFlagsAdd(range, plus, { uid: true });
      if (minus.length) await client.messageFlagsRemove(range, minus, { uid: true });
    });
    for (const key of this.parsed.keys()) if (key.startsWith(`${folder}\u0000`)) this.parsed.delete(key);
  }

  async move(folder, ids, to) {
    let target = (await this.#rolePath(to)) || (this.roles && Object.values(this.roles).includes(to) ? to : null);
    if (!target && to === 'archive') {
      const client = await this.#conn();
      target = 'Archive';
      try {
        await client.mailboxCreate(target);
      } catch {
        /* it may exist without the \Archive flag */
      }
      this.roles.archive = target;
    }
    if (!target) target = to; // a plain folder path
    if (target === folder) return;
    await this.#withMailbox(folder, (client) => client.messageMove(ids.join(','), target, { uid: true }));
  }

  async destroy(folder, ids) {
    await this.#withMailbox(folder, (client) => client.messageDelete(ids.join(','), { uid: true }));
  }

  async send(mail) {
    const message = {
      from: this.from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      inReplyTo: mail.inReplyTo || undefined,
      references: mail.references?.length ? mail.references : undefined,
      attachments: (mail.attachments || []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    };
    const raw = await new MailComposer(message).compile().build();
    const recipients = [...mail.to, ...(mail.cc || []), ...(mail.bcc || [])].map((a) => a.address);
    const info = await this.transport.sendMail({ envelope: { from: this.from.address, to: recipients }, raw });

    // Gmail files sent mail itself; everyone else needs the copy appended.
    if (!this.isGmail) {
      const sent = await this.#rolePath('sent');
      if (sent) {
        const client = await this.#conn();
        await client.append(sent, raw, ['\\Seen']).catch((err) => console.error('[mail] could not file sent copy:', err.message));
      }
    }
    if (mail.replyTo?.folder && mail.replyTo?.id) {
      await this.flags(mail.replyTo.folder, [mail.replyTo.id], { add: ['answered'] }).catch(() => {});
    }
    return { id: info.messageId };
  }
}
