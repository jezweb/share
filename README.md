# share

Give an agent a way to put a small, purpose-built web page in front of a person
(or a few people) **beyond the terminal it runs in**, share it as one unguessable
link, and read their structured answer back into its own workflow. The page is
built for the moment and thrown away after.

```
agent builds a page  →  share.jezweb.com/jrc-rbac-decision-7Kp9mXe2  →  person taps  →  answer back
```

## Why

When an agent wants to show a person something or ask them to decide, chat is a poor
surface: the human has to find the message, relate the screenshots to the question,
and type prose. `share` lets the agent build the exact surface for the moment, hand
over a link, and get a clean structured answer back.

It's a **view, not a store**. The durable truth still lives in your real tools (a
board, GitHub, a spreadsheet). `share` renders a fresh, tailored, throwaway page
over that state, so you avoid committing to a PM/kanban system you'd have to keep in
sync. The page is disposable precisely because the truth lives elsewhere.

## What it's good for

Pick a direction (two options side by side) · approve a quote · review and edit a
draft · mark up a mockup · a living "what needs your call" board · just show a
diagram or demo. Sibling of [`decisions`](https://github.com/jezweb/decisions) (the
asking method) and [`fixer`](https://github.com/jezweb/fixer) / `walkabout` (the
before/after and demo captures you'd embed) — `share` is the surface they've been
faking by screenshotting into chat.

## How it works

One always-on Cloudflare Worker, deployed once, that:

- **serves** agent-authored static pages at keyed URLs (`/:slug`),
- **stores** each page as a row in D1 (the worker is permanent; pages are disposable, with a TTL),
- **captures** structured responses (`POST /:slug/respond`) to D1,
- **holds big files** (images, video) in R2, served at `/a/<key>`,
- exposes a small authed API for the agent: create a share, read its responses.

The boundary that keeps it safe: **the agent ships the front end (static HTML/CSS/JS),
never worker code.** All creativity lives client-side where it can't touch infra; the
only auth surface on the public routes is the unguessable slug.

### Bytes never touch the model

Control plane (create share, read responses) is tiny JSON over the API. Data plane
(images, video) **sidecars**: the agent `curl`s the file from disk straight to R2 and
only ever holds the short URL back. No base64 in tool calls, no context flooding.

```bash
# single page: publish HTML inline, get one link back
curl -X POST -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: application/json" \
  -d '{"title":"jrc-rbac-decision","html":"<!doctype html>…","ttlHours":72}' "$SHARE_BASE/api/shares"

# a whole site: build it locally, then push the tree (one command)
SHARE_BASE=… SHARE_TOKEN=… scripts/push.sh ./site "Quote draft"

# an image, by hand if you prefer: bytes go disk → R2, never through the model
curl -X PUT -H "Authorization: Bearer $SHARE_TOKEN" --data-binary @hero.png \
  -H "content-type: image/png" "$SHARE_BASE/api/shares/<slug>/files/img/hero.png"

# read the answer (or let your next heartbeat run do it)
curl -H "Authorization: Bearer $SHARE_TOKEN" "$SHARE_BASE/api/shares/<id>/responses"
```

### A share is a folder — one page or a whole site

R2 is the per-share file store (keys are paths: `sites/<slug>/index.html`,
`…/img/hero.png`), so a share can be a single decision page or an entire multi-page
draft website. **Local disk is the workshop, R2 is the shelf:** build the site with
your normal tools (write, edit, grep, preview), then `scripts/push.sh` the tree up.
To iterate on a published one, `scripts/pull.sh <slug> ./site`, edit, push again.
R2 is not a mounted filesystem — you don't grep it in place; you grep your local
copy and re-publish.

### The contract: `share.js`

Every page includes `<script src="/share.js"></script>` and reports back through one
helper: `share.submit({choice:'B'})`, `share.comment('#hero','too busy')`, or
`share.custom({...})`. Build whatever UI you like; that one call is the only contract.

### Access

One unguessable link by default (possession is access). For an attributed sign-off
(a quote, anything that needs a record of *who*), pass `recipients` on create and get
one keyed link per person; each response records the responder.

### Getting the answer back

The answer is retrievable by id, forever. Don't design around the session waiting:
record the id and let the next heartbeat / scheduled run read the responses and act.
For a short live moment, poll for a minute or two. Faster live-session pickup (an
`asyncRewake` watcher hook, or Claude Code channels once out of preview) is a later
nicety, not required.

## Repo layout

```
share/
  worker/                  the one always-on worker (Hono + D1 + R2)
    src/index.ts           host + capture + files + responses API
    schema.sql             D1 tables (share metadata + responses)
    wrangler.toml          route = share.jezweb.com, D1 + R2 bindings
  scripts/push.sh          publish a local dir as a share (build local, push the tree)
  scripts/pull.sh          download a share to edit + re-push (the round-trip)
  templates/ab-choice.html a self-contained example using share.submit
  skills/share/SKILL.md    when + how an agent uses it
  .claude-plugin/          plugin + marketplace manifests
```

## Status

**v0.1 — foundation.** Worker (host + capture + R2 assets + authed API), the
`share.js` contract, one template, the plugin skill. Not yet deployed.

Next: deploy to `share.jezweb.com` (D1 + R2 + `SHARE_TOKEN` secret), an MCP server so
the agent gets clean `publish` / `responses` tools instead of curl, more templates
(palette, matrix, annotate, board), and the first real dogfood.

## Deploy (when ready)

```bash
cd worker
npm install
wrangler d1 create share                 # paste the id into wrangler.toml
wrangler r2 bucket create share-assets
npm run db:init:remote
wrangler secret put SHARE_TOKEN
wrangler deploy                           # provisions share.jezweb.com
```

## Licence

MIT © 2026 Jezweb Pty Ltd
