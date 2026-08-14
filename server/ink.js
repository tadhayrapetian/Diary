/**
 * Turning a model's token stream into something a quill can draw.
 *
 * Two jobs, both incremental so the nib can start moving on the first tokens
 * rather than waiting for the whole reply:
 *
 *   Splitter  — peels the ⟦transcript⟧ prefix off the front of the stream and
 *               emits the rest as writable ink. Falls back gracefully to
 *               "it's all ink" if the model skips the protocol.
 *   Sanitizer — strips anything the page cannot render: stray XML-ish tags,
 *               markdown punctuation, runaway whitespace.
 */

const OPEN = '⟦'; // ⟦
const CLOSE = '⟧'; // ⟧

/** Characters that only ever mean markup in handwritten prose. */
const MARKUP_CHARS = /[*_`#|~]/g;

/**
 * Tags whose *contents* must never reach the page, not just the tags
 * themselves. Disabled thinking occasionally leaks a block of reasoning; the
 * page should swallow it whole rather than write it out in a careful hand.
 */
const SUPPRESSED = new Set([
  'thinking',
  'antml:thinking',
  'antthinking',
  'thought',
  'thoughts',
  'scratchpad',
  'reasoning',
  'internal',
]);

/** Give up suppressing if the closing tag never turns up. */
const SUPPRESS_LIMIT = 4000;

/** Longest run after a '<' we will hold back waiting to see if it is a tag. */
const TAG_LOOKAHEAD = 64;

export class InkSanitizer {
  constructor() {
    this.buffer = '';
    this.suppressing = '';
    this.dropped = 0;
    this.openSpace = false; // last thing emitted ended on a space
  }

  /** Feed a chunk, get back the part that is safe to draw right now. */
  push(chunk) {
    this.buffer += chunk;
    let out = '';
    let i = 0;

    while (i < this.buffer.length) {
      if (this.suppressing) {
        const closer = `</${this.suppressing}>`;
        const at = this.buffer.indexOf(closer, i);
        if (at === -1) {
          // Keep only enough tail to catch a closer split across chunks.
          const keep = Math.max(i, this.buffer.length - closer.length + 1);
          this.dropped += keep - i;
          i = keep;
          if (this.dropped > SUPPRESS_LIMIT) {
            // The closer is never coming. Throw away the whole runaway block
            // rather than dribbling the tail of it onto the page.
            i = this.buffer.length;
            this.#resume();
          }
          break;
        }
        i = at + closer.length;
        this.#resume();
        continue;
      }

      const open = this.buffer.indexOf('<', i);
      if (open === -1) {
        out += this.buffer.slice(i);
        i = this.buffer.length;
        break;
      }

      out += this.buffer.slice(i, open);

      const close = this.buffer.indexOf('>', open);
      if (close === -1) {
        const rest = this.buffer.slice(open);
        if (rest.length > TAG_LOOKAHEAD) {
          // Too long to be a tag — it was a plain "less than" after all.
          out += rest;
          i = this.buffer.length;
        } else {
          i = open; // hold it and wait for the rest
        }
        break;
      }

      const inner = this.buffer.slice(open + 1, close);
      const closing = inner.trimStart().startsWith('/');
      const name = (inner.match(/^\/?\s*([a-zA-Z][\w:.-]*)/) || [])[1];
      if (!closing && name && SUPPRESSED.has(name.toLowerCase())) {
        this.suppressing = name;
        this.dropped = 0;
      }
      i = close + 1; // the tag itself is never written either way
    }

    this.buffer = this.buffer.slice(i);
    return this.#finish(out);
  }

  /** No more chunks coming; release whatever is still held back. */
  flush() {
    const rest = this.suppressing ? '' : this.buffer;
    this.buffer = '';
    this.suppressing = '';
    return rest ? this.#finish(rest) : '';
  }

  #resume() {
    this.suppressing = '';
    this.dropped = 0;
  }

  #finish(text) {
    let out = text
      .replace(MARKUP_CHARS, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n');

    // Removing a tag can leave a space on either side of the gap, and the two
    // halves arrive in separate chunks — so collapse across the seam too.
    if (this.openSpace) out = out.replace(/^[ \t]+/, '');
    if (out) this.openSpace = /[ \t]$/.test(out);

    return out;
  }
}

export class ReplySplitter {
  /**
   * @param {{onTranscript: (text: string) => void, onInk: (text: string) => void}} sinks
   */
  constructor({ onTranscript, onInk }) {
    this.onTranscript = onTranscript;
    this.onInk = onInk;
    this.mode = 'seek';
    this.buffer = '';
    this.transcript = '';
    this.sanitizer = new InkSanitizer();
    this.leading = true;
  }

  push(chunk) {
    if (this.mode === 'ink') {
      this.#ink(chunk);
      return;
    }

    this.buffer += chunk;

    if (this.mode === 'seek') {
      const lead = this.buffer.trimStart();
      if (!lead) return; // nothing but whitespace so far
      if (lead[0] === OPEN) {
        this.mode = 'transcript';
        this.buffer = lead.slice(1);
      } else {
        // Protocol not honoured. Treat everything as ink rather than losing the
        // reply — the reader would rather have a page that writes.
        this.mode = 'ink';
        const carried = this.buffer;
        this.buffer = '';
        this.#ink(carried);
        return;
      }
    }

    if (this.mode === 'transcript') {
      const end = this.buffer.indexOf(CLOSE);
      if (end === -1) {
        // Guard against a model that opens the bracket and never closes it.
        if (this.buffer.length > 4000) {
          this.mode = 'ink';
          const carried = this.buffer;
          this.buffer = '';
          this.#ink(carried);
        }
        return;
      }
      this.transcript = this.buffer.slice(0, end).trim();
      const rest = this.buffer.slice(end + 1);
      this.buffer = '';
      this.mode = 'ink';
      this.onTranscript(this.transcript);
      this.#ink(rest);
    }
  }

  end() {
    if (this.mode === 'seek' || this.mode === 'transcript') {
      // Stream ended before the protocol resolved; salvage what we have.
      const carried = this.buffer;
      this.buffer = '';
      this.mode = 'ink';
      if (carried) this.#ink(carried);
    }
    const tail = this.sanitizer.flush();
    if (tail) this.#emit(tail);
  }

  #ink(chunk) {
    const safe = this.sanitizer.push(chunk);
    if (safe) this.#emit(safe);
  }

  #emit(text) {
    let out = text;
    if (this.leading) {
      out = out.replace(/^\s+/, '');
      if (!out) return;
      this.leading = false;
    }
    this.onInk(out);
  }
}
