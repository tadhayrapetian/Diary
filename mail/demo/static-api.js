// The server's /api, answered inside the page from the demo mailbox, so the whole
// client runs as a single file with no server behind it (see scripts/build-demo.mjs).
import { DemoStore } from '../server/demo.js';
import { parseRecipients, textToHtml, htmlToText } from '../server/text.js';

const store = new DemoStore();
const events = new EventTarget();
store.on('new', (payload) => events.dispatchEvent(new MessageEvent('new', { data: JSON.stringify(payload) })));

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(String(b64 || '')), (c) => c.charCodeAt(0));

const urls = new Map();
function attachmentUrl(folder, id, index) {
  const key = `${id}:${index}`;
  if (!urls.has(key)) {
    const a = store.messages.find((m) => m.id === String(id))?.attachments[Number(index)];
    if (!a) return '';
    urls.set(key, `data:${a.contentType};base64,${toBase64(a.content)}`);
  }
  return urls.get(key);
}

const json = (status, data) => new Response(JSON.stringify(data ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
const ids = (body) => (Array.isArray(body.ids) ? body.ids.map(String) : []);

const routes = {
  'GET /api/state': async () => ({ mode: 'demo', account: await store.info() }),
  'GET /api/folders': () => store.folders(),
  'GET /api/messages': (q) =>
    store.list({
      folder: q.get('folder') || 'inbox',
      q: (q.get('q') || '').trim(),
      filter: q.get('filter') || 'all',
      offset: Number(q.get('offset')) || 0,
      limit: Number(q.get('limit')) || 50,
    }),
  'GET /api/message': (q) => store.get(q.get('folder'), q.get('id')),
  'GET /api/thread': (q) => store.thread(q.get('folder'), q.get('id')),
  'POST /api/flags': async (_q, b) => (await store.flags(b.folder, ids(b), { add: b.add || [], remove: b.remove || [] }), { ok: true }),
  'POST /api/move': async (_q, b) => (await store.move(b.folder, ids(b), String(b.to)), { ok: true }),
  'POST /api/destroy': async (_q, b) => (await store.destroy(b.folder, ids(b)), { ok: true }),
  'POST /api/send': async (_q, b) => {
    const to = parseRecipients(b.to);
    if (!to.length) throw Object.assign(new Error('Добавьте хотя бы одного получателя'), { status: 400 });
    const html = String(b.html || '') || textToHtml(String(b.text || ''));
    await store.send({
      to,
      cc: parseRecipients(b.cc),
      bcc: parseRecipients(b.bcc),
      subject: String(b.subject || ''),
      html,
      text: htmlToText(html),
      inReplyTo: b.inReplyTo || null,
      references: b.references || [],
      attachments: (b.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: fromBase64(a.data) })),
    });
    return { ok: true };
  },
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const at = url.pathname.indexOf('/api/');
  if (at < 0) return realFetch(input, init);
  const path = url.pathname.slice(at);
  const method = (init.method || 'GET').toUpperCase();
  try {
    if (method === 'GET' && path === '/api/attachment') {
      const file = await store.attachment(null, url.searchParams.get('id'), url.searchParams.get('index'));
      return new Response(new Blob([file.content], { type: file.contentType }));
    }
    const route = routes[`${method} ${path}`];
    if (!route) return json(404, { error: 'not found' });
    const body = init.body ? JSON.parse(init.body) : {};
    return json(200, await route(url.searchParams, body));
  } catch (error) {
    return json(error.status || 500, { error: error.message || 'Что-то пошло не так' });
  }
};

// Pages hosted this way get no confirm() dialog; the composer's "send without a subject?" just goes ahead.
window.confirm = () => true;

window.AETHER_STATIC = { events, attachmentUrl };
