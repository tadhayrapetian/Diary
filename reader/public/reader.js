/**
 * The page itself: protocol text in, an article you can read out.
 *
 * The stream arrives block by block and each block becomes an element as soon
 * as its first words land, so the article sets itself in front of you rather
 * than appearing all at once when the last word arrives.
 */

import {
  createBlockStream,
  blockToHtml,
  HEADER_TYPES,
  readingMinutes,
} from './blocks.js';

const BLOCK_SELECTOR =
  '.a-p,.a-h2,.a-h3,.a-li,.a-quote,.a-pull,.a-note,.a-deck,.a-title,.a-summary,.a-kicker';

const SENTENCE_END = /[.!?…。！？]["'’”»)\]]?\s/g;

/** The sentence a word sits in — the thing that decides what it means. */
export function sentenceAround(element) {
  const block = element.closest(BLOCK_SELECTOR) || element.parentElement;
  if (!block) return '';
  const text = block.textContent || '';
  if (text.length < 220) return text.trim();

  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(element, 0);
  const at = range.toString().length;

  let start = 0;
  let end = text.length;
  SENTENCE_END.lastIndex = 0;
  let match;
  while ((match = SENTENCE_END.exec(text))) {
    const boundary = match.index + match[0].length;
    if (boundary <= at) start = boundary;
    else {
      end = boundary;
      break;
    }
  }
  const sentence = text.slice(start, end).trim();
  return sentence.length > 400 ? sentence.slice(0, 400) : sentence;
}

export class Reader {
  constructor(options) {
    this.article = options.article;
    this.glossary = options.glossary;
    this.glossaryList = options.glossaryList;
    this.toc = options.toc;
    this.onWord = options.onWord;
    this.onHeadings = options.onHeadings;
    this.onMeta = options.onMeta;

    this.article.addEventListener('click', (event) => {
      const word = event.target.closest('w-');
      if (word && this.article.contains(word)) this.onWord?.(word);
    });

    this.reset();
  }

  reset() {
    this.article.textContent = '';
    this.glossaryList.textContent = '';
    this.glossary.hidden = true;
    this.toc.textContent = '';
    this.toc.hidden = true;

    this.protocol = '';
    this.nodes = [];
    this.kinds = [];
    this.list = null;
    this.listIndex = -1;
    this.headings = [];
    this.terms = [];
    this.ruled = false;
    this.hasLead = false;
    this.title = '';
    this.words = 0;

    this.stream = createBlockStream((block, index, done) =>
      this.place(block, index, done),
    );
  }

  /** Render a whole article at once — a piece taken back off the shelf. */
  render(protocol) {
    this.reset();
    this.stream.push(protocol);
    this.stream.end();
  }

  push(text) {
    this.protocol += text;
    this.stream.push(text);
  }

  end() {
    this.stream.end();
    return this.finish();
  }

  place(block, index, done) {
    if (block.type === 'term') {
      if (done) this.addTerm(block);
      return;
    }

    // The first paragraph carries the drop cap.
    const lead = block.type === 'p' && !this.hasLead;
    if (lead && done) this.hasLead = true;

    // A rule separates the article's name from its body.
    if (!this.ruled && !HEADER_TYPES.has(block.type) && this.nodes.length) {
      const rule = document.createElement('hr');
      rule.className = 'a-head-rule';
      this.article.append(rule);
      this.ruled = true;
    }

    const id = block.type === 'h2' || block.type === 'h3' ? `s${index}` : '';
    const html = blockToHtml(block, { lead, id });
    if (!html) return;

    const existing = this.nodes[index];
    if (existing && this.kinds[index] === block.type) {
      // Same block, more words: swap the contents, keep the element.
      const fresh = this.build(html, block, index);
      existing.innerHTML = fresh.innerHTML;
    } else {
      if (existing) existing.remove();
      const node = this.build(html, block, index);
      this.attach(node, block, index);
      this.nodes[index] = node;
      this.kinds[index] = block.type;
    }

    if (done) {
      this.words += (block.text?.match(/[\p{L}\p{N}]+/gu) || []).length;
      if (block.type === 'title' && block.text) {
        this.title = block.text;
        this.onMeta?.({ title: block.text });
      }
      if (block.type === 'h2' || block.type === 'h3') {
        this.headings = this.headings.filter((h) => h.id !== `s${index}`);
        this.headings.push({ id: `s${index}`, text: block.text, deep: block.type === 'h3' });
        this.drawToc();
      }
    }
  }

  build(html, block, index) {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const node = holder.firstElementChild;
    node.dataset.block = String(index);
    return node;
  }

  attach(node, block, index) {
    const isItem = block.type === 'li' || block.type === 'nli';
    if (isItem) {
      const continues = this.list && this.listIndex === index - 1 &&
        this.list.tagName === (block.type === 'nli' ? 'OL' : 'UL');
      if (!continues) {
        this.list = document.createElement(block.type === 'nli' ? 'ol' : 'ul');
        this.list.className = 'a-list';
        this.article.append(this.list);
      }
      this.list.append(node);
      this.listIndex = index;
      return;
    }
    this.list = null;
    this.article.append(node);
  }

  addTerm(block) {
    if (!block.word) return;
    if (this.terms.some((term) => term.word === block.word)) return;
    this.terms.push(block);

    const dt = document.createElement('dt');
    dt.textContent = block.word;
    dt.tabIndex = 0;
    dt.addEventListener('click', () => this.onWord?.(dt, block.word));
    const dd = document.createElement('dd');
    dd.textContent = block.gloss;
    this.glossaryList.append(dt, dd);
    this.glossary.hidden = false;
  }

  drawToc() {
    this.toc.textContent = '';
    if (this.headings.length < 3) return;
    for (const heading of this.headings) {
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.text;
      if (heading.deep) link.className = 'deep';
      this.toc.append(link);
    }
    this.onHeadings?.(this.headings.length);
  }

  finish() {
    // A block still open when the stream stopped is closed where it stands.
    this.list = null;
    return {
      title: this.title,
      words: this.words,
      minutes: readingMinutes(this.words),
      terms: this.terms,
    };
  }

  /** Re-mark saved words after the list changes. */
  markSaved(has) {
    for (const word of this.article.querySelectorAll('w-')) {
      word.classList.toggle('saved', has(word.textContent));
    }
  }
}
