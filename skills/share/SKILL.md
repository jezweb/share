---
name: share
description: Publish a small, purpose-built web page for a person (or several) beyond the terminal you run in, share it as one unguessable link, and read their structured answer back. Use when chat-plus-screenshots is the wrong shape — when you want two options side by side to tap between, a quote or draft to approve or edit, a mockup to mark up, a living "what needs your call" board, or just a thing to show someone. Sibling of decisions (the asking method) and fixer/walkabout (the captures you'd embed). The page is built for the moment and thrown away after.
---

# share — put a page in front of someone, hear back

Chat plus screenshots makes the person do the work: find the message, relate the
images to the question, type prose. `share` lets you build the exact surface for the
moment, hand over one link, and get a clean structured answer back into your own
workflow. The page is a disposable view; the truth still lives in your real tools.

## The model: control plane small, data plane sidecars

This is the rule that keeps it cheap. **Bytes never go through your context or an
MCP arg.**

- **Control plane** (tiny JSON): create a share, read the responses. Goes through
  this skill / the API. Small.
- **Data plane** (images, video, any big file): goes **disk → HTTP → R2** via a
  plain `curl`. The bytes never touch the model. You only ever hold the short URL
  that comes back, and you drop that URL into the page's HTML.

So you never base64 an image into a tool call. You `curl` it up and reference it.

## Config

`init` (once per environment) deploys the worker to Cloudflare and sets two values
the skill reads:

- `SHARE_BASE` — e.g. `https://share.jezweb.com`
- `SHARE_TOKEN` — the bearer secret for the authed `/api/*` calls (a Worker secret;
  never goes in a page)

## A share is a folder, not a file

It can be a single page or a **whole multi-page draft site** (pages, CSS, JS,
images, video). The files live in one place keyed by the slug; you build whatever
the environment supports. Two scales:

- **One page** — pass the HTML inline on create; done in a single call.
- **A site** — create the share, then upload each file to its path.

Two contract points for any page that wants an answer back:
- include the helper: `<script src="/share.js"></script>`
- call it when the person acts: `share.submit({ choice: 'B' })`,
  `share.comment('#hero', 'too busy')`, or `share.custom({ ... })`.
A pure "just look at this" page calls nothing; `share.comment` is an optional
leave-a-note affordance.

**Redact**: a page is a publish surface. No PII, client names, account numbers or
tokens in the HTML or the images. Crop for confidentiality, use seeded/dummy data
where you can, match the link's audience to the data.

## 1 — Single page (the common case)

POST the finished HTML; you get one unguessable link back.

```bash
curl -s -X POST -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: application/json" \
  -d '{"title":"jrc-rbac-decision","html":"<!doctype html>…","ttlHours":72}' \
  "$SHARE_BASE/api/shares"
# -> { "id":"…","slug":"jrc-rbac-decision-7Kp9mXe2","url":"https://share.jezweb.com/jrc-rbac-decision-7Kp9mXe2" }
```

## 1b — A whole site (multi-file)

Create the share (no html, or with an index), then PUT each file to its path. The
bytes go disk → HTTP → R2 and **never pass through an MCP arg or your context** —
you only hold the URLs back. This is how images and video get there too: sidecar,
never base64.

```bash
SLUG=$(curl -s -X POST -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: application/json" \
  -d '{"title":"quote-draft","ttlHours":168}' "$SHARE_BASE/api/shares" | jq -r .slug)

curl -X PUT -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: text/html" \
  --data-binary @index.html  "$SHARE_BASE/api/shares/$SLUG/files/index.html"
curl -X PUT -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: text/css" \
  --data-binary @style.css   "$SHARE_BASE/api/shares/$SLUG/files/style.css"
curl -X PUT -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: image/png" \
  --data-binary @img/hero.png "$SHARE_BASE/api/shares/$SLUG/files/img/hero.png"
# the person opens $SHARE_BASE/$SLUG ; sub-pages live at /$SLUG/<path>
```

The slug is **readable prefix + unguessable token**: the words help the person spot
it in a chat list, the random tail is the actual lock. Share that URL however you
like (drop it in chat, email it).

### Access tiers

- **One link by default** — possession is access, like a Google-Docs link-share.
  Fine for "just look at this", a draft, an internal board.
- **Per-person keys when attribution matters** — for a sign-off where you need to
  record *who* approved (a quote, anything irreversible/regulated). Pass
  `"recipients":["Marianne","Jeff"]` on create; you get one link per person
  (`…?k=<token>`), and each response records the responder. This mirrors the
  `decisions` CONFIRM gate: a low-stakes call is a tap, a sign-off needs a name.

## 4 — Read the answer back

Poll the responses endpoint:

```bash
curl -s -H "Authorization: Bearer $SHARE_TOKEN" "$SHARE_BASE/api/shares/<id>/responses"
# -> { "count": 1, "responses": [ { "responder": "Marianne", "data": {…}, "at": … } ] }
```

**Don't design around waiting.** The answer sits there, retrievable by id, forever.
For a long-running fleet agent the cleanest pattern is to record the share id and
let your **next heartbeat / scheduled run** read the responses and act — the loop
you already run *is* the bridge back. For a short "pick A or B while I'm here", poll
a few times over a minute or two. (Faster live-session pickup via an `asyncRewake`
watcher hook or Claude Code channels is a later nicety, not required.)

## When to reach for it / when not

Reach for it: options to choose between, a quote/draft to approve or edit, a mockup
to mark up, a living status board several people act on, a demo or diagram to show.
Don't: a one-line yes/no that a chat message answers fine (that's `decisions` over
chat), or anything needing real authentication/login (the unguessable link is a
capability, not a login — keep genuinely sensitive flows out of it).
