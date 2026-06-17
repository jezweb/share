---
name: share
description: Publish a small, purpose-built web page for a person (or several) beyond the terminal you run in, share it as one unguessable link, and read their structured answer back over HTTP. You build whatever page fits the moment (free-form HTML), and drop in robust ready-made components for the interactive bits — pick-one, rating, image markup, a form — so you never hand-roll fragile event code. Use when chat-plus-screenshots is the wrong shape: two options to tap between, a quote to approve or edit, a mockup to mark up, a living "what needs your call" board, or just a thing to show someone. The page is built for the moment and thrown away after.
---

# share — put a page in front of someone, hear back

Chat plus screenshots makes the person do the work: find the message, relate the
images to the question, type prose. `share` lets you build the exact surface for
the moment, hand over one link, and get a clean structured answer back into your
own workflow. The page is a disposable view; the truth still lives in your real
tools.

## The model (read this first)

**You build whatever page you want. The components handle the interactive bits.**

- The page is **free-form HTML you author** — design it however fits. Your style,
  your layout, your copy.
- For the parts that *capture an answer* (pick one, rate, mark up an image, fill a
  form), **drop in a ready-made component** instead of writing event handlers. The
  fiddly interaction logic lives once, tested, in `share-ui.js` — so you don't
  re-derive (and re-break) it on every page.
- Answers come back to **you** as structured JSON, read over **HTTP by the slug
  you already hold**.

**The boundary that matters:** an agent needs only `SHARE_BASE` + `SHARE_TOKEN` +
HTTP. You never touch D1, wrangler, or the Cloudflare account — those are the
worker's private storage. Reading answers is an authed URL, not a database query.

**Bytes never go through your context or an MCP arg.** Control plane (create a
share, read responses) is tiny JSON. Data plane (images, video) goes disk → HTTP
→ R2 via a plain `curl`; you only ever hold the short URL back.

## Config

- `SHARE_BASE` — e.g. `https://share.jezweb.com`
- `SHARE_TOKEN` — the bearer secret for the authed `/api/*` calls (never in a page)

## A share is a folder, not a file

A single page or a whole multi-page site (pages, CSS, JS, images, video) under one
slug. Two scales:

- **One page** — pass the HTML inline on create.
- **A site** — create, then `push.sh` a local folder (it uploads every file).

For any page that wants an answer back, include the runtime and the components:

```html
<script src="/share.js"></script>      <!-- the report-home contract -->
<script src="/share-ui.js"></script>   <!-- the drop-in components (optional) -->
```

**Redact**: a page is a publish surface. No PII, client names, account numbers or
tokens in the HTML or images. Crop for confidentiality, use dummy data, match the
link's audience to the data.

## The components (drop-in, no interaction code)

Author your page, then drop any of these in. Each reports through `share.submit()`
automatically. You style your own page; the components bring their own behaviour.

| Component | Markup | Reports |
|---|---|---|
| **annotate** — pin an image, add / **edit** / **delete** notes | `<div data-share-annotate data-src="img/mock.png"></div>` | `{kind:'annotate', pins:[{n,x,y,text}]}` (full current set each change) |
| **choice** — pick one of N | `<div data-share-choice><button data-value="a">A</button><button data-value="b">B</button></div>` | `{kind:'choice', value:'a'}` |
| **rating** — 1..N stars | `<div data-share-rating data-max="5"></div>` | `{kind:'rating', value:4, max:5}` |
| **form** — collect any inputs you designed, submit once | `<div data-share-form>…inputs with name=…<button data-share-submit data-done="Sent ✓">Send</button></div>` | `{kind:'form', values:{…}}` |

Need something the components don't cover? Write raw HTML and call the contract
directly: `share.submit({choice:'B'})`, `share.comment('#hero','too busy')`,
`share.custom({…})`. The components are there for the common, fiddly cases — not a
cage.

## Images — three sources, one rule

Whatever the source, **upload images as bytes** (`push.sh` walks a folder, or
`curl PUT` a file): disk → HTTP → R2, never base64 into a tool call.

- **Real screenshots / photos** — capture with playwright, or fixer / walkabout.
- **Rendered graphics (keyless)** — charts, mockups, palettes: write HTML,
  screenshot to PNG. Deterministic, free, accurate text.
- **Generated images** — `scripts/genimage.mjs` (one OpenRouter call; set
  `OPENROUTER_API_KEY` to a **designated** key, never a client's). Pick the model
  by the job: a cheap fast one (`black-forest-labs/flux.2-klein-4b`) for
  *decorative* images, but it mangles text — when there's **text in the image or
  accuracy matters**, use `google/gemini-3-pro-image-preview` (text) or
  `openai/gpt-5-image` (instruction-following). Default
  `google/gemini-3.1-flash-image-preview`.

## 1 — Single page

```bash
curl -s -X POST -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: application/json" \
  -d '{"title":"rbac-decision","html":"<!doctype html>…","ttlHours":72}' \
  "$SHARE_BASE/api/shares"
# -> { id, slug, url, responsesUrl, … }
```

## 2 — A whole site (multi-file)

Build the folder on your own disk, then push it:

```bash
SHARE_BASE=… SHARE_TOKEN=… ./scripts/push.sh ./site "Quote draft"
#   -> prints the share URL, and (on stderr) the responses URL + read-back command
# re-push after edits to the SAME share:  SHARE_SLUG=<slug> ./scripts/push.sh ./site
```

The slug is **readable prefix + unguessable token** — the words help the person
spot it in a chat list, the random tail is the lock. Share the URL however you
like.

### Get pinged when they answer (per-share webhook)

Set a notify webhook **on the share you're creating** — each share can ping a
different place. Google Chat gets a formatted message; any other URL gets the raw
JSON.

```bash
# on create:  "notify": "https://chat.googleapis.com/v1/spaces/…"
# or with push.sh:  SHARE_NOTIFY="https://…" ./scripts/push.sh ./site
```

### Attributed sign-offs (per-person keys)

For a sign-off where you need to record *who* approved, pass
`"recipients":["Marianne","Jeff"]` on create — you get one link per person
(`…?k=<token>`) and each response records the responder.

## 3 — Read the answer back (by slug, over HTTP)

```bash
SHARE_BASE=… SHARE_TOKEN=… ./scripts/responses.sh <slug-or-share-url>
# or:  curl -s -H "Authorization: Bearer $SHARE_TOKEN" "$SHARE_BASE/api/shares/<slug>/responses"
# -> { slug, count, opened, views, viewedAt, responses:[ {responder, data, at} ] }
```

`opened`/`views`/`viewedAt` tell you whether they've even looked — so you nudge
only when it makes sense.

**Don't design around waiting.** The answer sits there forever, retrievable by
slug. For a long-running fleet agent, record the slug and let your **next
heartbeat** read the responses and act. For a short "pick A or B while I'm here",
poll a few times.

## 4 — Live boards & lifecycle

- **Live refresh** — for a board you keep updating, the page can `share.poll(path,
  ms, cb)` to re-render when you re-push a data file (public, no token, no leak).
  Instant multi-viewer sync is the Durable-Object/websocket tier (later).
- **Burndown** — a share is disposable. It auto-deletes at its TTL (hourly cron),
  or retire it now: `curl -X DELETE -H "Authorization: Bearer $SHARE_TOKEN"
  "$SHARE_BASE/api/shares/<slug>"`.

## When to reach for it / when not

Reach for it: options to choose between, a quote/draft to approve or edit, a
mockup to mark up, a living status board, a demo to show. Don't: a one-line yes/no
a chat message answers fine (that's `decisions` over chat), or anything needing
real authentication/login (the unguessable link is a capability, not a login —
keep genuinely sensitive flows out of it).
