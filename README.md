# T. M. Riddle

A diary that writes back.

Write on the page with an Apple Pencil. The ink sinks into the paper, and after a
moment an answer surfaces in a neat, slanted hand, drawn out one stroke at a time.
You can write about anything — homework, a bug you cannot find, a bad week, what
to call the cat — and it will answer.

There is no send button, no chat bubble, no spinner, no typing dots, and no
"thinking…". The only thing that ever happens on the page is ink.

---

## Getting it running

```bash
npm install
cp .env.example .env      # then put your key in it
npm start
```

Open the address it prints. That is all it needs.

The key goes in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

**Without a key it still runs.** The diary answers from a small canned repertoire
so you can see the whole thing work end to end before wiring a model in. It says
so when it starts.

### Putting it on the iPad

The Pencil is the point, so run it on your machine and open it on the tablet:

1. `npm start` (it listens on `0.0.0.0` by default).
2. On the iPad, open `http://<your-computer's-LAN-IP>:4243` in Safari.
3. **Share → Add to Home Screen.** Launched from the Home Screen it opens
   fullscreen with no browser chrome, which is most of the illusion.

Both devices need to be on the same network. If the iPad cannot reach it, check
your machine's firewall rather than the app.

---

## How to use it

- **Write anywhere on the page.** Pressure and speed shape the line.
- **Stop writing.** After a pause the ink is drunk into the paper and the answer
  begins. The pause is what tells the diary you have finished — there is nothing
  to press.
- **Two fingers on the page** sends it immediately, whenever you like.
- **Tap while it is writing** and the hand hurries.
- **Press and hold the bottom-left corner** for the only settings there are:
  writing speed, how long a pause it waits for, whether it accepts a finger as
  well as a pencil, a plain-text transcript of everything said, and a new diary.

It remembers the conversation across reloads, and the page turns itself when it
runs out of room.

---

## How it works

```
Apple Pencil ──► ink on canvas ──► lifted as an image ──► Claude reads the
                                                          handwriting and answers
                        ▲                                          │
                        └────────── written back, stroke by stroke ┘
```

There is no separate handwriting-recognition step. The page is sent to Claude as
an image, and the model reads the handwriting and replies in the same call. It
returns the words it read in `⟦ ⟧` first, then its answer; the transcript becomes
the conversation history (so past turns cost text, not images) and can be read
back from the settings panel.

**The absorption animation is the loading state.** The request goes out the
instant the ink lifts, so the second or so of ink sinking into the paper is spent
on the round trip rather than after it. The reply is streamed and the hand starts
writing on the first tokens. If the network is slower than the hand, the hand
simply stops mid-sentence — which is what a person writing would do, and is why
this app never needs a spinner. If the reply is slow, the page just stays blank,
which is exactly what the diary in the film does.

### Files

| | |
|---|---|
| `public/quill.js` | Pencil capture, pressure-varied ink, and the absorption |
| `public/scribe.js` | The diary's hand: layout, per-character timing, wet-ink edge |
| `public/app.js` | Page flow, page turns, the exchange, settings |
| `server/server.js` | Static files and the streaming reply endpoint |
| `server/ink.js` | Splits `⟦transcript⟧` off the stream and strips anything unwritable |
| `prompts/riddle.md` | The persona. Edit this to change who is on the other side. |

### The model call

`claude-opus-5`, streamed, with thinking disabled at low effort — the shortest
path to a first token, which is what matters when a hand is waiting to move. The
persona is cached. Refusal fallbacks are on. If your account does not have the
beta features, the server quietly retries on the plain endpoint.

Two knobs in `.env` are worth knowing about:

- `DIARY_FAST=1` — the same Opus 5 model at up to ~2.5× the output rate, at
  premium pricing. The page starts filling sooner. Worth trying.
- `DIARY_MODEL=` — anything else you would rather it used.

### Changing the handwriting

On an iPad the script is **Snell Roundhand**, which ships with iOS. Elsewhere it
falls back to **Petit Formal Script**, bundled in `public/fonts/` (SIL Open Font
License). Both are declared in `FONT_STACK` in `public/scribe.js`; the size is
measured from whichever face actually resolves, so a different script face can be
dropped in without re-tuning the layout.

---

## Tests

```bash
npm test
```

Covers the stream parsing — the transcript delimiters landing on chunk
boundaries, leaked thinking blocks, markdown, tags split across chunks, and
streams that end mid-thought. That layer sits between a model's tokens and a
quill that cannot un-write a mistake, so it is the part worth being sure about.

The drawing, absorption, wrapping, page turns and failure paths were checked in a
real browser. **The live model call has not been exercised** — this was built
without API credentials to hand, so the request shape was verified against a
local stand-in rather than the real endpoint. It is the one thing to watch on
first run.

---

## A note on the voice

It is written to be charming and to be genuinely useful — a diary that only
purrs is a toy. It grows more familiar the longer you write to it, which is the
point of the character. It will not give you genuinely dangerous instructions; it
declines the way a clever, well-bred boy declines, and moves on.

---

## Also in this repo

`notes/` is a second, unrelated program that shares nothing with the diary but
the folder: quick notes, saved without being asked. No key, no model, nothing
leaving the machine.

```bash
npm run notes
```

Its own README is [notes/README.md](notes/README.md).
