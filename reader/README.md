# Lectern

Paste anything. Read it properly. Tap any word. Or drop in a book and get the
whole thing in your own language.

Put a text in — a paste, a PDF, a Word file, an EPUB, a web page, a link — and
choose one of three things to do with it:

- **Set in type.** It comes back as an article: a real title, real paragraphs,
  section headings, pull quotes, a glossary.
- **Translate.** The whole thing, however long, into any of thirty languages.
  A novel is a novel: it takes a while and it costs something, and you are told
  both before you start.
- **Facing pages.** The same translation with the author's own line standing
  above each one, which is how you actually learn a language from a book.

Then tap any word in it — in either language — and you get what it means *in
that sentence*, how it is pronounced, and what it is in your own language. Keep
the words you want; export them to a flashcard deck.

Lectern does not summarise, condense or improve anybody's prose. Setting type,
it repairs what a page layout did to the text and gives it back its shape.
Translating, it renders every sentence — nothing skipped for being long or
hard.

---

## Getting it running

```bash
npm install
cp .env.example .env      # then put your key in it
npm run reader
```

Open the address it prints.

**Without a key it still runs.** It falls back to a plain local typesetter that
reads the shape of the text rather than the sense of it, and to two free public
dictionaries for word lookups. It says so when it starts. The difference is
large; a key is worth having.

### On a phone or an iPad

It listens on `0.0.0.0`, so open `http://<your-computer's-LAN-IP>:4244` on the
tablet — the startup message prints the address. **Share → Add to Home Screen**
gives you a fullscreen reader. Tapping a word opens a sheet from the bottom of
the screen, which is where your thumb already is.

---

## What you can put in

| | |
|---|---|
| **Paste** | Anything. Markdown-ish structure (`# heading`, `> quote`, `- item`) is understood if it is there, and not required. |
| **PDF** | Text is pulled out directly, including the headings, which are recognised by the type size the page set them in. A scan with no text layer is sent to the model to be read by eye. |
| **Word** | `.docx` — heading, quote and list styles come through as structure. |
| **EPUB** | Read in spine order, not file order. |
| **Web page** | Paste a link and it is fetched and stripped down to the readable part. |
| **Also** | `.html`, `.rtf`, `.txt`, `.md`, `.csv`, subtitle files. |

Drop a file anywhere on the page, or use the button.

---

## Translating a book

Drop in the `.epub` or the `.pdf`, pick **Translate**, check the direction, and
press the button. That is the whole thing.

What happens next is worth knowing about:

- **It is read through first.** Before a single chapter is translated, the whole
  work is read once and a list of names and terms is settled — every person,
  place, invented word and recurring turn of phrase, with the rendering it will
  keep. That list then goes into every piece. It is the difference between a
  translation and twenty translations stapled together: a character named in
  chapter one is named the same way in chapter twenty.
- **It is cut into pieces and translated in order**, each piece told what the
  one before it decided, so headings, register and forms of address carry across
  the seams.
- **It does not belong to the browser tab.** The work runs on the server. Close
  the page, put the laptop to sleep, come back tomorrow — it is on the shelf,
  and if it is still going you can watch it finish. It is written to disk as it
  goes, so even a server that stops leaves you the chapters it had done.
- **A piece that fails is retried, then skipped.** Nineteen good chapters are
  worth more than none.
- **You are told the size of it first.** Words, pieces, roughly how long, and
  roughly what it will cost. Anything long asks you a second time before it
  starts.

Both directions work, and so do the other twenty-eight languages. The direction
is guessed from the file and can be swapped with one button.

### On doing it properly

The prompt is a translator's brief, not a "translate this" instruction. It
covers the things that separate a competent translation from a machine one:
keeping the register exactly, turning idioms into idioms rather than into words,
recasting syntax the way the receiving language wants it, leaving numbers and
units as the author wrote them — and the typography, which is where carelessness
shows first. Russian direct speech takes an em dash at the start of the line and
quotations take «ёлочки»; English wants quotation marks and its own way of
punctuating an attribution. Each language gets its own habits, every time.

## Reading

- **Tap a word** for a card: pronunciation with IPA and a button to hear it,
  the part of speech, the translation, what it means *here*, an example, and
  the other senses folded away underneath. Tap the star to keep it.
- **Select a phrase** and a "Look up" button appears. Idioms get the idiomatic
  reading.
- **Saved words** live in the panel behind the star, and export as a
  tab-separated file that Anki and everything like it will import.
- **Settings** hold the translation language, the page colour (auto, paper,
  sepia, night), the type size, the line length, and justification.
- **Facing pages** can be folded away with the button in the bar, leaving the
  translation alone; press it again and the original is back. Tapping a word in
  the original looks it up one way round, and a word in the translation the
  other — the card follows you.
- **The shelf** keeps everything that has been run. Reopening is instant and
  costs nothing: the finished work is stored, not redone.

Words and settings stay in your browser. Finished articles and translations are
kept on your own machine, under `.lectern/library/`, because a translated book
is too big for a browser to hold and too expensive to lose.

---

## How it works

```
                         ┌── read the whole work once, settle the names ──┐
                         │                                               ▼
a file ──► extract ──► repair ──► piece 1 ─► piece 2 ─► … ─► piece n ──► an article
                                     └── what it settled ──┘              streaming
                                                                              │
                        a tapped word + the sentence around it ──► a card ────┘
```

A run is a **job**: started, then left to finish on its own, written to disk as
it goes. Any page can attach to a job and is caught up in full before the live
text resumes — which is what makes closing the tab in the middle of a book cost
nothing.

**Extraction** is dependency-free. `pdf.js` is a small PDF reader: it indexes
every object in the file rather than trusting the cross-reference table, inflates
the streams, expands object streams, walks the page tree, decodes glyph codes
back to characters through each font's `/ToUnicode` CMap, then reassembles the
placed glyphs into lines and the lines into paragraphs — using the page's own
vertical rhythm to tell a line break from a paragraph break. Running heads and
folios are dropped by finding what repeats across pages, except where the type
size says it is a title rather than a running head. Two-column pages are split
at the gutter. Files encrypted with an empty user password are decrypted.

**Typesetting** is a model call. The article comes back as one tagged block per
line — `TITLE`, `H2`, `P`, `QUOTE`, `PULL`, `TERM` — which is a format chosen
because it survives being cut in half by a stream. A half-received line is a
paragraph that is still growing, so the page fills in as the words arrive rather
than appearing all at once at the end. Long documents are cut at paragraph
boundaries and set piece by piece, each piece told what came before it.

**Word lookups** are a second, small model call with a JSON schema, cached on
the sentence as well as the word — because "charge" in a cavalry charge is not
"charge" on a bill, and both answers are worth keeping.

### Files

| | |
|---|---|
| `server/pdf.js` | The PDF reader: objects, streams, fonts, glyphs, lines, paragraphs |
| `server/extract.js` | Everything else: docx, epub, html, rtf, and the prose repairs |
| `server/typeset.js` | The three modes, chunked for long works, with the survey pass and the glossary that crosses the seams |
| `server/jobs.js` | The library: runs that outlive the tab, and the shelf they land on |
| `server/lexicon.js` | The word card, and its cache |
| `server/local.js` | What it does with no key: a heuristic typesetter, free dictionaries |
| `server/server.js` | Four endpoints and the static files |
| `public/blocks.js` | The block protocol — parsed on both sides, so it is tested once |
| `public/reader.js` | The page: blocks into elements, and the sentence around a word |
| `public/lookup.js` | The card, the speech, the kept words |
| `public/app.js` | The desk, the shelf, the panels, the wiring |
| `prompts/typeset.md` | What a typesetter is for. Edit this to change the house style. |
| `prompts/translate.md` | The translator's brief. Edit this to change how it reads. |
| `prompts/bilingual.md` | The facing-pages addendum |
| `prompts/survey.md` | The read-through that settles the names before anything is translated |
| `prompts/lexicon.md` | What a dictionary entry should say |

### The model call

`claude-opus-5` throughout, streamed, at low effort — careful work, but not hard
reasoning, and the first token matters more than the last. The prompts are
cached, which matters when twenty pieces of a book share one. Refusal fallbacks
are on, and if your account does not have the beta features the server quietly
retries on the plain endpoint. `LECTERN_FAST=1` runs the same model at up to
~2.5x the output rate, at premium pricing; on a book you very much notice.

The survey pass reads the whole work in a single request — a million characters
is a quarter of the context window — and answers with a few hundred lines. It is
the cheapest part of a book translation and the part that does the most for it.

---

## Tests

```bash
npm test
```

93 tests. The PDF reader is checked against a real PDF committed as a fixture —
justified lines reflowing into prose, accents and quotation marks surviving the
font encoding, headings recognised by type size, running heads and page numbers
dropped while the title they echo is kept. The rest covers the block protocol
(including tags split across stream chunks), the docx/epub/html readers, the
chunking and the framing given to each piece, and the HTTP endpoints end to end.
The model paths are driven by a stub client that scripts the stream — including
refusals, mid-document failures, and the fallback from the beta endpoint.

Translation is covered where it can be without a key: the framing each piece is
given, the terms carried forward from one piece to the next and from the survey
into all of them, the retry, carrying on past a piece that will not come, and
the job library — written to disk, replayed to a page that arrives late, and
recovered after the server stops mid-book.

The page itself was driven in a real browser: a PDF uploaded and set, a facing
-page translation rendered and folded away, a word tapped in each language and
looked up the right way round, the estimate and its second-click confirmation,
the word card, the shelf, the night theme and the phone layout.

**The live model call has not been exercised** — this was built without API
credentials to hand, so the request shape was verified against a scripted
stand-in rather than the real endpoint. It is the one thing to watch on first
run.
