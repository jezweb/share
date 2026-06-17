#!/usr/bin/env node
// share MCP server — clean publish / responses tools over the share HTTP API, so
// an agent uses share first-class without curl. Zero dependencies (stdio JSON-RPC,
// the brainstrust/genimage pattern): no npm install, ships with the plugin.
//
// Reads two env values (the only thing an agent ever needs — no D1, no wrangler):
//   SHARE_BASE   e.g. https://share.jezweb.com
//   SHARE_TOKEN  the bearer secret for /api/* calls
//
// The data-plane rule still holds: publishing a folder reads file bytes from DISK
// and PUTs them straight to R2 — the bytes never pass through a tool argument or
// the model context. Pass `dir`, not base64.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, relative } from 'node:path'

const BASE = process.env.SHARE_BASE
const TOKEN = process.env.SHARE_TOKEN
const NAME = 'share', VERSION = '0.1.0'

// ---- HTTP helpers ----------------------------------------------------------
function need() {
  if (!BASE || !TOKEN) throw new Error('SHARE_BASE and SHARE_TOKEN must be set in the environment')
}
async function api(method, path, body) {
  need()
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  try { return JSON.parse(text) } catch { return text }
}

// content-type by extension, overridden by magic bytes for raster images
function sniff(file) {
  const fd = openSync(file, 'r'); const buf = Buffer.alloc(12)
  try { readSync(fd, buf, 0, 12, 0) } finally { closeSync(fd) }
  const hex = buf.toString('hex')
  if (hex.startsWith('89504e47')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (hex.startsWith('47494638')) return 'image/gif'
  if (hex.slice(16) === '57454250') return 'image/webp'
  return ''
}
const EXT = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  mjs: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
}
function mime(file) {
  const ext = (file.split('.').pop() || '').toLowerCase()
  let m = EXT[ext] || 'application/octet-stream'
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(m)) { const r = sniff(file); if (r) m = r }
  return m
}
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full)); else out.push(full)
  }
  return out
}

// ---- tools -----------------------------------------------------------------
const TOOLS = [
  {
    name: 'share_publish',
    description:
      'Publish a share and get back a link + its responses URL. Pass `html` for a single page, OR `dir` (a local folder path) for a multi-file site — folder bytes go disk->HTTP->R2, never through this call. Optional: title, ttlHours, notify (a per-share webhook URL fired on each response), recipients (per-person attributed links).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        html: { type: 'string', description: 'inline HTML for a single-page share' },
        dir: { type: 'string', description: 'local folder to publish as a multi-file site' },
        ttlHours: { type: 'number' },
        notify: { type: 'string', description: 'per-share webhook URL pinged when an answer lands' },
        recipients: { type: 'array', items: { type: 'string' }, description: 'names → one attributed link each' },
      },
    },
  },
  {
    name: 'share_responses',
    description: 'Read a share\'s structured answers back by slug. Returns count, opened/views/viewedAt, and each response.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    name: 'share_files',
    description: 'List the files in a share (for a round-trip edit).',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    name: 'share_retire',
    description: 'Retire (burn down) a share now — deletes its files + responses. Idempotent.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
]

async function publish(a) {
  const created = await api('POST', '/api/shares', {
    title: a.title, html: a.html, ttlHours: a.ttlHours, notify: a.notify, recipients: a.recipients,
  })
  let uploaded = 0
  if (a.dir) {
    for (const file of walk(a.dir)) {
      const rel = relative(a.dir, file).split('\\').join('/')
      const res = await fetch(`${BASE}/api/shares/${created.slug}/files/${rel}`, {
        method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': mime(file) },
        body: readFileSync(file),
      })
      if (res.ok) uploaded++
    }
  }
  return { ...created, ...(a.dir ? { uploaded } : {}) }
}

async function callTool(name, args) {
  const a = args || {}
  if (name === 'share_publish') return publish(a)
  if (name === 'share_responses') return api('GET', `/api/shares/${a.slug}/responses`)
  if (name === 'share_files') return api('GET', `/api/shares/${a.slug}/files`)
  if (name === 'share_retire') return api('DELETE', `/api/shares/${a.slug}`)
  throw new Error('unknown tool: ' + name)
}

// ---- JSON-RPC stdio loop ---------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32000, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    })
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
  } else if (method === 'tools/call') {
    try {
      const out = await callTool(params?.name, params?.arguments)
      reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: 'error: ' + (e?.message || String(e)) }], isError: true })
    }
  } else if (method === 'ping') {
    reply(id, {})
  } else if (id !== undefined && method && !method.startsWith('notifications/')) {
    fail(id, 'method not found: ' + method)
  }
  // notifications (no id) need no response
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})
