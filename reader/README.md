# Lectern

Paste anything. Read it properly. Tap any word.

Put a text in — a paste, a PDF, a Word file, an EPUB, a web page, a link — and
it comes back set as an article: a real title, real paragraphs, section
headings, pull quotes, a glossary. Then tap any word in it and you get what it
means *in that sentence*, how it is pronounced, and what it is in your own
language. Keep the words you want; export them to a flashcard deck.

The words are the author's. Lectern is a typesetter, not an editor — it does not
summarise, condense or rewrite. It repairs what a page layout did to the prose
and gives it back its shape.

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
- **The shelf** on the desk keeps what you have already read. Reopening is
  instant and costs nothing — the set article is stored, not re-set.

Everything you keep — words, settings, shelf — stays in your browser. Nothing
is stored on the server.

---

## How it works

```
a file ──► extract ──► repair ──► typeset ──► an article, streaming
                                                     │
   a tapped word + the sentence around it ──► a card ┘
```

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
| `server/typeset.js` | The typesetting stream, chunked for long documents |
| `server/lexicon.js` | The word card, and its cache |
| `server/local.js` | What it does with no key: a heuristic typesetter, free dictionaries |
| `server/server.js` | Four endpoints and the static files |
| `public/blocks.js` | The block protocol — parsed on both sides, so it is tested once |
| `public/reader.js` | The page: blocks into elements, and the sentence around a word |
| `public/lookup.js` | The card, the speech, the kept words |
| `public/app.js` | The desk, the shelf, the panels, the wiring |
| `prompts/typeset.md` | What a typesetter is for. Edit this to change the house style. |
| `prompts/lexicon.md` | What a dictionary entry should say |

### The model call

`claude-opus-5` for both, streamed for the article, at low effort — this is
careful work but not hard reasoning, and the first token matters more than the
last. The prompts are cached. Refusal fallbacks are on, and if your account does
not have the beta features the server quietly retries on the plain endpoint.
`LECTERN_FAST=1` runs the same model at up to ~2.5x the output rate, at premium
pricing; on a long article you notice.

---

## Tests

```bash
npm test
```

72 tests. The PDF reader is checked against a real PDF committed as a fixture —
justified lines reflowing into prose, accents and quotation marks surviving the
font encoding, headings recognised by type size, running heads and page numbers
dropped while the title they echo is kept. The rest covers the block protocol
(including tags split across stream chunks), the docx/epub/html readers, the
chunking and the framing given to each piece, and the HTTP endpoints end to end.
The model paths are driven by a stub client that scripts the stream — including
refusals, mid-document failures, and the fallback from the beta endpoint.

The page itself was driven in a real browser: a PDF uploaded and set, the word
card opened and a word kept, the shelf written and reopened, the night theme,
and the phone layout.

**The live model call has not been exercised** — this was built without API
credentials to hand, so the request shape was verified against a scripted
stand-in rather than the real endpoint. It is the one thing to watch on first
run.
