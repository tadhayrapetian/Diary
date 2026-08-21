/**
 * Reading Apple Calendar over CalDAV.
 *
 * iCloud speaks plain RFC 4791 to anything that can send HTTP, so no Mac and no
 * Apple SDK is involved: an Apple ID and an app-specific password from
 * appleid.apple.com are the whole of it. The dance is always the same —
 *
 *   who am I        → current-user-principal
 *   where are my    → calendar-home-set
 *   which calendars → PROPFIND the home
 *   what is on them → REPORT with a time range
 *
 * — and iCloud answers the first hop with a redirect to the shard your account
 * actually lives on, which is why redirects are followed by hand here: fetch
 * would turn PROPFIND into GET on a 301.
 */

const ORIGIN = 'https://caldav.icloud.com';
const AGENT = 'lesson-reminders/1.0';

const NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;

export class CaldavError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'CaldavError';
    this.status = status;
  }
}

// ------------------------------------------------------------- tiny XML reader

/** Contents of every `<…:tag>` in the document, prefix-agnostic. */
function tags(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

/** First match, or ''. */
function tag(xml, name) {
  return tags(xml, name)[0] ?? '';
}

/** True if a self-closing or paired `<…:tag>` is present. */
function hasTag(xml, name) {
  return new RegExp(`<(?:[\\w.-]+:)?${name}[\\s/>]`, 'i').test(xml);
}

function unescapeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function escapeXml(text) {
  return String(text).replace(/[<>&"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot' }[c]};`);
}

// ------------------------------------------------------------------ transport

async function dav(url, { method, depth = '0', body, auth, signal }, hop = 0) {
  if (hop > 5) throw new CaldavError('Слишком много перенаправлений от iCloud');
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    signal,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/xml; charset=utf-8',
      'User-Agent': AGENT,
      Accept: 'application/xml, text/xml',
      ...(method === 'PROPFIND' ? { Depth: depth } : {}),
      ...(method === 'REPORT' ? { Depth: depth } : {}),
    },
    body,
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new CaldavError(`iCloud ответил ${response.status} без адреса`);
    return dav(new URL(location, url).toString(), { method, depth, body, auth, signal }, hop + 1);
  }

  if (response.status === 401) {
    throw new CaldavError(
      'iCloud не принял логин. Нужен Apple ID и пароль для программы ' +
        '(appleid.apple.com → «Вход и безопасность» → «Пароли приложений»), не обычный пароль.',
      { status: 401 },
    );
  }
  if (response.status >= 400) {
    throw new CaldavError(`iCloud ответил ${response.status} на ${method} ${url}`, {
      status: response.status,
    });
  }
  return { url: response.url || url, text: await response.text() };
}

/** Absolute URL for an href that may be a path, keeping the shard host. */
function resolve(href, base) {
  return new URL(unescapeXml(href.trim()), base).toString();
}

// ------------------------------------------------------------------ discovery

async function principalUrl(auth, signal) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind ${NS}><D:prop><D:current-user-principal/></D:prop></D:propfind>`;
  const { url, text } = await dav(`${ORIGIN}/`, { method: 'PROPFIND', body, auth, signal });
  const href = tag(tag(text, 'current-user-principal'), 'href');
  if (!href) throw new CaldavError('iCloud не сказал, где находится ваш аккаунт');
  return resolve(href, url);
}

async function homeUrl(principal, auth, signal) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind ${NS}><D:prop><C:calendar-home-set/></D:prop></D:propfind>`;
  const { url, text } = await dav(principal, { method: 'PROPFIND', body, auth, signal });
  const href = tag(tag(text, 'calendar-home-set'), 'href');
  if (!href) throw new CaldavError('iCloud не сказал, где лежат календари');
  return resolve(href, url);
}

/**
 * Every calendar on the account that can hold events.
 * @returns {{name: string, url: string, colour: string}[]}
 */
export async function listCalendars({ appleId, password, signal }) {
  const auth = Buffer.from(`${appleId}:${password}`).toString('base64');
  const principal = await principalUrl(auth, signal);
  const home = await homeUrl(principal, auth, signal);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind ${NS}>
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>`;
  const { url, text } = await dav(home, { method: 'PROPFIND', depth: '1', body, auth, signal });

  const out = [];
  for (const entry of tags(text, 'response')) {
    if (!hasTag(entry, 'calendar')) continue;
    const components = tag(entry, 'supported-calendar-component-set');
    if (components && !/name="VEVENT"/i.test(components)) continue;
    const href = tag(entry, 'href');
    const name = unescapeXml(tag(entry, 'displayname')).trim();
    if (!href || !name) continue;
    out.push({ name, url: resolve(href, url) });
  }
  return out;
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * The calendars named in `only` (or all of them), each as raw iCalendar text
 * covering [from, to]. Recurring events come back as the rule, not the list —
 * `ics.js` does the expanding.
 */
export async function fetchCalendars({ appleId, password, only = [], from, to, signal }) {
  const auth = Buffer.from(`${appleId}:${password}`).toString('base64');
  const all = await listCalendars({ appleId, password, signal });

  const wanted = only.length
    ? all.filter((c) => only.some((name) => c.name.toLowerCase() === name.trim().toLowerCase()))
    : all;

  if (only.length && wanted.length < only.length) {
    const missing = only.filter(
      (name) => !all.some((c) => c.name.toLowerCase() === name.trim().toLowerCase()),
    );
    if (missing.length) {
      throw new CaldavError(
        `В iCloud нет календаря: ${missing.join(', ')}. Есть: ${all.map((c) => c.name).join(', ') || '—'}`,
      );
    }
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query ${NS}>
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${escapeXml(stamp(from))}" end="${escapeXml(stamp(to))}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const out = [];
  for (const calendar of wanted) {
    const { text } = await dav(calendar.url, { method: 'REPORT', depth: '1', body, auth, signal });
    const pieces = tags(text, 'calendar-data').map(unescapeXml);
    out.push({ name: calendar.name, text: pieces.join('\n') });
  }
  return out;
}
