/**
 * The Telegram Bot API, only the four calls this needs.
 *
 * A bot cannot write to someone who has never written to it, which is the whole
 * reason `link` exists: the student opens t.me/<bot>?start=<code> once, Telegram
 * turns that into `/start <code>`, and the chat id that arrives with it is what
 * every later reminder is addressed to.
 */

// Overridable so the sending path can be exercised against a stub — and so a
// self-hosted Bot API server works if anyone ever wants one.
const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(message, { code, retryAfter } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Text that is safe inside parse_mode: HTML. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function call(token, method, payload = {}, { signal, timeoutMs = 20000 } = {}) {
  const abort = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, abort]) : abort,
  });

  let body;
  try {
    body = await response.json();
  } catch {
    throw new TelegramError(`Telegram ответил ${response.status} без JSON`, { code: response.status });
  }
  if (!body.ok) {
    throw new TelegramError(body.description || `Telegram ответил ${response.status}`, {
      code: body.error_code ?? response.status,
      retryAfter: body.parameters?.retry_after,
    });
  }
  return body.result;
}

export class Telegram {
  constructor(token) {
    if (!token) throw new Error('Нет TELEGRAM_BOT_TOKEN. Получите его у @BotFather и впишите в .env');
    this.token = token;
    this.offset = 0;
  }

  /** The bot's own account — used to print the t.me link and to check the token. */
  me(options) {
    return call(this.token, 'getMe', {}, options);
  }

  /**
   * Send, retrying once when Telegram asks us to slow down.
   *
   * Never throws for the two things that are the student's doing rather than a
   * fault — a blocked bot, a deleted account — because those want a note to the
   * teacher, not a crashed process.
   */
  async send(chatId, text, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const message = await call(
          this.token,
          'sendMessage',
          {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options.payload,
          },
          options,
        );
        return { ok: true, message };
      } catch (error) {
        if (error.retryAfter && attempt === 0) {
          await new Promise((r) => setTimeout(r, Math.min(error.retryAfter, 30) * 1000));
          continue;
        }
        if (error.code === 403 || /chat not found|user is deactivated/i.test(error.message)) {
          return { ok: false, unreachable: true, error };
        }
        return { ok: false, error };
      }
    }
  }

  /**
   * Long-poll for messages. Resolves with [] when the wait times out, which is
   * the normal case and not worth reporting.
   */
  async updates({ seconds = 25, signal } = {}) {
    try {
      const result = await call(
        this.token,
        'getUpdates',
        { offset: this.offset, timeout: seconds, allowed_updates: ['message'] },
        { signal, timeoutMs: (seconds + 15) * 1000 },
      );
      for (const update of result) this.offset = Math.max(this.offset, update.update_id + 1);
      return result;
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return [];
      throw error;
    }
  }
}

/** `/start CODE` → `{ command: 'start', argument: 'CODE' }`. */
export function readCommand(message) {
  const text = (message?.text || '').trim();
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
  if (!m) return null;
  return { command: m[1].toLowerCase(), argument: (m[2] || '').trim() };
}

/** How a person shows up in a log line or a note to the teacher. */
export function describeChat(chat) {
  const name = [chat?.first_name, chat?.last_name].filter(Boolean).join(' ');
  const handle = chat?.username ? `@${chat.username}` : '';
  return [name, handle].filter(Boolean).join(' ') || String(chat?.id ?? 'неизвестно');
}
