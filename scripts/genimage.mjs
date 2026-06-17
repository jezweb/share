#!/usr/bin/env node
// share/genimage — generate an image with OpenRouter and save it to disk, ready
// to push into a share. Self-contained (the brainstrust pattern, for images):
// one OpenRouter call, a DESIGNATED key, no other skill needed.
//
//   OPENROUTER_API_KEY=sk-or-... \
//     node genimage.mjs "a calm sage-green abstract hero, premium, no text" img/calm.png
//
// Optional 3rd arg: model id (default google/gemini-3.1-flash-image-preview).
//
// PICK THE MODEL BY THE JOB:
//   - Decorative / abstract (heroes, backgrounds, mood) → a cheap fast one is fine:
//       black-forest-labs/flux.2-klein-4b  (best cost-to-quality)
//   - TEXT IN THE IMAGE, or accuracy matters (a real label, a UI mock, a diagram,
//     a logo with words) → use a strong model, the cheap ones mangle text:
//       google/gemini-3-pro-image-preview   (industry-leading text rendering)
//       openai/gpt-5-image                  (strong instruction following)
//   - Balanced default → google/gemini-3.1-flash-image-preview (pro-level, fast).
// See https://openrouter.ai/collections/image-models for the full list.
//
// The key is a DESIGNATED image-gen / multi-model key in the host's secret store,
// NEVER a client's or a project's. If you don't have one, render the image from
// HTML instead (charts/mockups/palettes screenshot cleanly and need no key).
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [prompt, out, model = 'google/gemini-3.1-flash-image-preview'] = process.argv.slice(2)
if (!prompt || !out) {
  console.error('usage: genimage.mjs "<prompt>" <out.png> [model]')
  process.exit(1)
}
const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error('set OPENROUTER_API_KEY — a designated image-gen key, never a client\'s')
  process.exit(1)
}

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    modalities: ['image', 'text'],
  }),
})
if (!res.ok) {
  console.error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
  process.exit(1)
}
const data = await res.json()
const url = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
if (!url || !url.startsWith('data:')) {
  console.error('no image in response (model may not support image output)')
  process.exit(1)
}
mkdirSync(dirname(out) || '.', { recursive: true })
writeFileSync(out, Buffer.from(url.split(',', 2)[1], 'base64'))
console.log(out)
