/**
 * share — one worker that hosts disposable, agent-authored sites at keyed URLs
 * and captures structured responses back to D1.
 *
 * A share is a FOLDER, not a file. It can be a single page or a whole multi-page
 * draft site. The files live in R2 under `sites/<slug>/…` (R2 keys are paths, so
 * it behaves like a little per-share filesystem — no Durable Object needed). D1
 * holds the share metadata and the responses. The worker is permanent; the sites
 * are disposable rows + objects with a TTL.
 *
 * The agent ships the front end (static files it builds however it likes); it
 * NEVER ships worker code. The unguessable slug is the lock on the public routes.
 *
 * Routes:
 *   POST /api/shares                       (auth) create a share, optionally with index html
 *   PUT  /api/shares/:slug/files/:path     (auth) put a file into the site (any depth)
 *   GET  /api/shares/:id/responses         (auth) read responses (the agent polls this)
 *   GET  /:slug                            (public) serve sites/<slug>/index.html
 *   GET  /:slug/:path                      (public) serve sites/<slug>/<path>
 *   POST /:slug/respond                    (public) capture a response to D1
 *   GET  /share.js                         (public) the client contract helper
 *   GET  /healthz                          (public) liveness
 */
import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  ASSETS: R2Bucket
  SHARE_TOKEN: string
}

const app = new Hono<{ Bindings: Bindings }>()

// ---- helpers ---------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000)

function randomToken(len = 10): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

// readable-but-unguessable slug: <kebab-title>-<random>. The words are for the
// human reading a chat list; the random tail is the real lock.
function makeSlug(title: string | undefined): string {
  const base = (title || 'page')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'page'
  return `${base}-${randomToken(10)}`
}

function authed(c: any): boolean {
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  return !!c.env.SHARE_TOKEN && token === c.env.SHARE_TOKEN
}

// Slugs are minted by makeSlug() as [a-z0-9-]. Enforce that charset at every
// boundary where a slug arrives from a URL, so a hostile slug can never reach the
// HTML injection (XSS) or an R2 key. Anything else is treated as not-found.
const okSlug = (s: string) => /^[a-zA-Z0-9-]{1,80}$/.test(s)
const siteKey = (slug: string, path: string) => `sites/${slug}/${path.replace(/^\/+/, '')}`
const looksHtml = (path: string, ct?: string | null) =>
  /\.html?$/i.test(path) || (ct || '').includes('text/html')

type ShareRow = { id: string; expires_at: number | null; meta: string | null }
const getShare = (c: any, slug: string): Promise<ShareRow | null> =>
  c.env.DB.prepare('SELECT id, expires_at, meta FROM shares WHERE slug = ?').bind(slug).first()
const isExpired = (s: ShareRow) => !!s.expires_at && s.expires_at < now()

// Inject, right after <head>: a <base> so relative URLs (sub-pages, css, images)
// resolve UNDER the share's folder, plus the config + helper so any page can call
// share.submit() without knowing its own slug. The <base> must come first so it
// governs every relative reference that follows.
function injectShareRuntime(html: string, slug: string): string {
  const inject =
    `<base href="/${slug}/">` +
    `<script>window.__SHARE__=${JSON.stringify({ slug })};</script>` +
    `<script src="/share.js"></script>`
  if (html.includes('<head>')) return html.replace('<head>', `<head>${inject}`)
  if (html.includes('</head>')) return html.replace('</head>', `${inject}</head>`)
  return inject + html
}

const SHARE_JS = `// share.js — the one contract every artifact uses to report home.
(function () {
  var cfg = window.__SHARE__ || {};
  var key = new URLSearchParams(location.search).get('k') || cfg.key || null;
  function post(payload) {
    return fetch('/' + cfg.slug + '/respond', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ k: key, data: payload }),
    }).then(function (r) { return r.ok; });
  }
  window.share = {
    submit: function (payload) { return post(Object.assign({ kind: 'submit' }, payload)); },
    comment: function (selector, text) { return post({ kind: 'comment', selector: selector, text: text }); },
    custom: function (payload) { return post(payload); },
  };
})();
`

// A default favicon so every share has one without authoring it (and browsers
// stop logging a 404 for /favicon.ico). A share can still override it by
// shipping its own favicon at the requested path. SVG renders crisp at any size.
const DEFAULT_FAVICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="7" fill="#5c8aff"/>` +
  `<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="22" cy="9" r="2.6" fill="#fff" stroke="none"/>` +
  `<circle cx="10" cy="16" r="2.6" fill="#fff" stroke="none"/>` +
  `<circle cx="22" cy="23" r="2.6" fill="#fff" stroke="none"/>` +
  `<path d="M12.3 14.7 19.7 10.3M12.3 17.3 19.7 21.7"/></g></svg>`
const faviconResponse = () =>
  new Response(DEFAULT_FAVICON, {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
  })
const isFaviconPath = (path: string) => /(^|\/)favicon\.(ico|svg)$/i.test(path)

function sysPage(title: string, body: string, status: number) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;text-align:center;color:#1e293b">` +
    `<h1 style="font-size:1.3rem;color:#0f2742">${title}</h1><p style="color:#64748b">${body}</p></div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

// ---- public: helper + liveness ---------------------------------------------

app.get('/healthz', (c) => c.text('ok'))
app.get('/favicon.ico', () => faviconResponse())
app.get('/share.js', () =>
  new Response(SHARE_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8' } }))

// ---- authed: the agent -----------------------------------------------------

// Create a share. Optionally pass `html` to write index.html in one shot (the
// common single-page case). For a multi-file site, create then PUT each file.
app.post('/api/shares', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const b = await c.req.json<{
    html?: string; title?: string; ttlHours?: number; recipients?: string[]
  }>().catch(() => ({} as any))

  const id = crypto.randomUUID()
  const slug = makeSlug(b.title)
  const created = now()
  const expires = b.ttlHours ? created + Math.round(b.ttlHours * 3600) : null

  const keys: Record<string, string> = {}
  const recipientLinks: { name: string; key: string }[] = []
  for (const name of b.recipients ?? []) {
    const k = randomToken(8); keys[k] = name; recipientLinks.push({ name, key: k })
  }
  const meta = recipientLinks.length ? JSON.stringify({ keys }) : null

  await c.env.DB.prepare(
    'INSERT INTO shares (id, slug, title, created_at, expires_at, meta) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, slug, b.title ?? null, created, expires, meta).run()

  if (typeof b.html === 'string' && b.html.length) {
    await c.env.ASSETS.put(siteKey(slug, 'index.html'), b.html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })
  }

  const origin = new URL(c.req.url).origin
  const url = `${origin}/${slug}`
  return c.json({
    id, slug, url, expiresAt: expires,
    uploadFileExample: `PUT ${origin}/api/shares/${slug}/files/<path>`,
    links: recipientLinks.length
      ? recipientLinks.map((r) => ({ name: r.name, url: `${url}?k=${r.key}` }))
      : [{ name: null, url }],
  })
})

// Put a file into the site at any path. index.html, extra pages, css, js, images,
// video — all just files in the share's folder. The agent curls bytes straight
// from disk; they never pass through an MCP arg or the model context.
//   curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @hero.png \
//        -H "content-type: image/png" $BASE/api/shares/<slug>/files/img/hero.png
app.put('/api/shares/:slug/files/:path{.+}', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const slug = c.req.param('slug')
  const path = c.req.param('path')
  if (!okSlug(slug)) return c.json({ error: 'no such share' }, 404)
  const share = await getShare(c, slug)
  if (!share) return c.json({ error: 'no such share' }, 404)
  if (!c.req.raw.body) return c.json({ error: 'empty body' }, 400)

  await c.env.ASSETS.put(siteKey(slug, path), c.req.raw.body, {
    httpMetadata: { contentType: c.req.header('content-type') || 'application/octet-stream' },
  })
  const origin = new URL(c.req.url).origin
  return c.json({ path, url: `${origin}/${slug}/${path.replace(/^\/+/, '')}` })
})

// List the files in a share — for pulling it back down to edit (round-trip).
// (Single page of up to 1000 keys; fine for a draft site.)
app.get('/api/shares/:slug/files', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const slug = c.req.param('slug')
  if (!(await getShare(c, slug))) return c.json({ error: 'no such share' }, 404)
  const prefix = `sites/${slug}/`
  const listed = await c.env.ASSETS.list({ prefix })
  return c.json({ slug, files: listed.objects.map((o: R2Object) => o.key.slice(prefix.length)) })
})

// Read responses (the agent, or its heartbeat, polls this).
app.get('/api/shares/:id/responses', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const id = c.req.param('id')
  const { results } = await c.env.DB.prepare(
    'SELECT responder, data, created_at FROM responses WHERE share_id = ? ORDER BY created_at ASC',
  ).bind(id).all<{ responder: string | null; data: string; created_at: number }>()
  return c.json({
    id, count: results.length,
    responses: results.map((r) => ({ responder: r.responder, data: safeParse(r.data), at: r.created_at })),
  })
})

// ---- public: capture + serve -----------------------------------------------

// Capture a response. Public — gated only by the (unguessable) slug.
app.post('/:slug/respond', async (c) => {
  const slug = c.req.param('slug')
  if (!okSlug(slug)) return c.json({ error: 'not found' }, 404)
  const share = await getShare(c, slug)
  if (!share) return c.json({ error: 'not found' }, 404)
  if (isExpired(share)) return c.json({ error: 'expired' }, 410)

  const body = await c.req.json<{ k?: string; data?: unknown }>().catch(() => ({} as any))
  let responder: string | null = null
  if (body.k && share.meta) {
    try { responder = (JSON.parse(share.meta).keys || {})[body.k] || null } catch { /* ignore */ }
  }
  await c.env.DB.prepare(
    'INSERT INTO responses (id, share_id, responder, data, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), share.id, responder, JSON.stringify(body.data ?? null), now()).run()
  return c.json({ ok: true })
})

// Serve the site index.
app.get('/:slug', (c) => serveFile(c, c.req.param('slug'), 'index.html'))

// Serve any file in the site (extra pages, css, js, images, …).
app.get('/:slug/:path{.+}', (c) => serveFile(c, c.req.param('slug'), c.req.param('path')))

async function serveFile(c: any, slug: string, path: string): Promise<Response> {
  if (!okSlug(slug)) return sysPage('Not found', 'This link is invalid.', 404)
  const share = await getShare(c, slug)
  if (!share) return sysPage('Not found', 'This link is invalid.', 404)
  if (isExpired(share)) return sysPage('Expired', 'This link has expired.', 410)

  const obj = await c.env.ASSETS.get(siteKey(slug, path))
  if (!obj) {
    // A share that didn't ship its own favicon still gets the default one,
    // rather than a 404 the browser logs on every page view.
    if (isFaviconPath(path)) return faviconResponse()
    return sysPage('Not found', 'Nothing here.', 404)
  }

  const ct = obj.httpMetadata?.contentType
  if (looksHtml(path, ct)) {
    const html = injectShareRuntime(await obj.text(), slug)
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  // NOT immutable: a share's files can be re-pushed to the same path, so assets
  // must stay fresh. Short max-age keeps it cache-friendly without going stale.
  headers.set('cache-control', 'public, max-age=60')
  return new Response(obj.body, { headers })
}

function safeParse(s: string): unknown { try { return JSON.parse(s) } catch { return s } }

export default app
