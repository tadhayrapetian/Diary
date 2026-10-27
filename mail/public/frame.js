import { h, escapeHtml } from './lib.js';

/**
 * Mail bodies are hostile by default. Each one renders in a sandboxed iframe with
 * scripts, forms and plugins off, under its own Content-Security-Policy, so remote
 * images (tracking pixels) load only once the reader allows them.
 */

const REMOTE = /(<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\/)|(url\(\s*["']?\s*(https?:)?\/\/)|(\sbackground\s*=\s*["']?\s*https?:)/i;

export const hasRemoteContent = (html) => REMOTE.test(html || '');

const attachmentUrl = (m, index) => `/api/attachment?folder=${encodeURIComponent(m.folder)}&id=${encodeURIComponent(m.id)}&index=${index}`;

function inlineCids(m, html) {
  const byCid = new Map((m.attachments || []).filter((a) => a.cid).map((a) => [a.cid.replace(/^<|>$/g, '').toLowerCase(), a.index]));
  if (!byCid.size) return html;
  return html.replace(/cid:([^"'\s)>]+)/gi, (all, cid) => {
    const index = byCid.get(decodeURIComponent(cid).toLowerCase());
    return index === undefined ? all : attachmentUrl(m, index);
  });
}

/** Plain-text mail, typeset by us: links, paragraphs, and quoted history folded away. */
function plainToHtml(text = '') {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let cut = lines.findIndex((l, i) =>
    /^(On|В|Le|Am)\s.{4,160}(wrote|написал|написала|написал\(а\)|a écrit|schrieb):?\s*$/i.test(l.trim()) ||
    /^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение)/i.test(l.trim()) ||
    (/^\s*>/.test(l) && lines.slice(i).every((x) => /^\s*>/.test(x) || !x.trim())),
  );
  if (cut === 0) cut = -1;
  const fmt = (part) =>
    escapeHtml(part)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1">$1</a>')
      .replace(/(^|[\s(])([\w.+-]+@[\w-]+\.[\w.-]+)/g, '$1<a href="mailto:$2">$2</a>');
  const body = (cut > 0 ? lines.slice(0, cut) : lines).join('\n').replace(/\n+$/, '');
  let html = `<div class="plain">${fmt(body)}</div>`;
  if (cut > 0) {
    const quoted = lines.slice(cut).map((l) => l.replace(/^\s*>\s?/, '')).join('\n');
    html += `<details class="aq"><summary title="Показать цитату">•••</summary><div class="plain quoted">${fmt(quoted)}</div></details>`;
  }
  return html;
}

/** Heuristic: does this HTML carry its own design, or is it just text? */
function isDesigned(html) {
  return /<table|bgcolor|background(-color)?\s*:|<style/i.test(html) || (html.match(/color\s*:/gi) || []).length > 3;
}

function baseCss(themed) {
  const dark = themed && document.documentElement.dataset.scheme === 'dark';
  const ink = dark ? '#e8e8ee' : '#1d1d1f';
  const muted = dark ? '#9898a6' : '#6e6e7a';
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6e5bff';
  return `
  :root{color-scheme:${dark ? 'dark' : 'light'}}
  html,body{margin:0;padding:0;background:transparent}
  body{display:flow-root;font:15px/1.6 -apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${ink};overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
  ${themed ? `a{color:${accent}}` : ''}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  pre,code{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .plain{white-space:pre-wrap}
  .quoted{color:${muted};border-left:3px solid ${dark ? '#3a3a46' : '#e3e3ea'};padding-left:12px;margin-top:8px}
  blockquote{margin:8px 0;padding:0 0 0 12px;border-left:3px solid ${dark ? '#3a3a46' : '#e3e3ea'};color:${muted}}
  details.aq{margin-top:10px}
  details.aq>summary{list-style:none;display:inline-block;cursor:pointer;padding:0 9px;height:20px;line-height:17px;border-radius:7px;background:${dark ? '#2a2a33' : '#efeff3'};color:${muted};font-size:13px;letter-spacing:1px;user-select:none}
  details.aq>summary::-webkit-details-marker{display:none}
  details.aq>summary:hover{background:${dark ? '#34343f' : '#e4e4ea'}}
  details.aq[open]>summary{margin-bottom:6px}`;
}

/** Fold quoted history in HTML mail behind a "•••" toggle that works without script. */
function foldQuotes(doc) {
  const candidates = doc.querySelectorAll('.gmail_quote, blockquote[type="cite"], .yahoo_quoted, #divRplyFwdMsg, #appendonsend, .moz-cite-prefix');
  const top = [...candidates].filter((el) => ![...candidates].some((other) => other !== el && other.contains(el)));
  for (const el of top) {
    if (el.closest('details.aq')) continue;
    // Outlook marks where the history begins; take everything after it.
    const details = doc.createElement('details');
    details.className = 'aq';
    const summary = doc.createElement('summary');
    summary.textContent = '•••';
    summary.title = 'Показать цитату';
    details.append(summary);
    if (el.id === 'appendonsend' || el.id === 'divRplyFwdMsg') {
      let node = el;
      const moving = [];
      while (node) {
        moving.push(node);
        node = node.nextSibling;
      }
      el.before(details);
      details.append(...moving);
    } else {
      el.replaceWith(details);
      details.append(el);
    }
  }
}

/**
 * Build the frame for one message. Returns { node, remote } where remote says
 * whether blocked remote content is present.
 */
export function renderBody(m, { allowRemote = false } = {}) {
  const plain = m.plain || !m.html;
  const source = plain ? plainToHtml(m.text) : inlineCids(m, String(m.html));
  const remote = !plain && hasRemoteContent(source);
  const themed = plain || !isDesigned(source);

  const csp = [
    "default-src 'none'",
    `img-src 'self' data: blob:${allowRemote ? ' https: http:' : ''}`,
    "style-src 'unsafe-inline'",
    `font-src data:${allowRemote ? ' https:' : ''}`,
  ].join('; ');

  const cleaned = source
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${baseCss(themed)}</style></head><body>${cleaned}</body></html>`;

  const frame = h('iframe', {
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    referrerpolicy: 'no-referrer',
    title: m.subject || 'Письмо',
    srcdoc: doc,
  });

  // The frame must share the page's color-scheme or the browser paints it opaque.
  frame.style.colorScheme = themed && document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light';
  const wrap = h('div.frame-wrap', { class: themed ? 'themed' : 'paper' }, frame);

  frame.addEventListener('load', () => {
    const d = frame.contentDocument;
    if (!d) return;
    if (!plain) foldQuotes(d);
    for (const a of d.querySelectorAll('a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    const fit = () => {
      // The body, not the document: the document is never shorter than the frame itself.
      const height = d.body ? Math.max(d.body.scrollHeight, d.body.offsetHeight) : d.documentElement.scrollHeight;
      frame.style.height = `${Math.ceil(height) + 2}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(d.documentElement);
    if (d.body) ro.observe(d.body);
    d.addEventListener('toggle', fit, true);
    for (const img of d.images) img.addEventListener('load', fit);
    // Scaling down wide newsletters instead of letting them scroll sideways.
    const wide = d.documentElement.scrollWidth;
    const room = frame.clientWidth;
    if (!themed && wide > room + 4 && room > 0) {
      const k = room / wide;
      d.documentElement.style.zoom = String(k);
      fit();
    }
  });

  return { node: wrap, remote };
}
