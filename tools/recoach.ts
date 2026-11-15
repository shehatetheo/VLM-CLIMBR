// Re-run the AI coach on the bundled examples, so their notes match the
// current coach brief (server/coach.mjs).
//
// Build: npx rolldown tools/recoach.ts -p node -f esm -o .climbr/recoach.mjs --external '../server/core.mjs'
// Run:   node .climbr/recoach.mjs      (reads the VLM Run key from .env)
import fs from 'node:fs'
import path from 'node:path'
import { analyticsFor, normalizeFeedback } from '../src/lib/coach'
import { buildSession, type SessionParts } from '../src/lib/session'
import type { Session } from '../src/lib/types'
// @ts-expect-error plain JS module
import { coach, sampleFrames } from '../server/core.mjs'

for (const id of ['green-vb', 'oliver']) {
  const dir = path.join('public', 'examples', id)
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : undefined)
  const saved = read('session.json') as Session | undefined
  let s: Session
  if (saved) s = saved
  else {
    const manifest = read('climbr.json'), files = manifest?.files ?? {}
    const parts: SessionParts = { manifest, climb: read(files.climb ?? 'climb.json'), sequence: read(files.sequence ?? 'sequence.json'), holds: read(files.holds ?? 'holds.json'), comparison: read(files.comparison ?? 'comparison.json'), baseUrl: '', kind: 'example' }
    s = buildSession(parts)
  }
  const frames = sampleFrames(path.join(dir, 'climb.mp4'))
  const r = await coach({ analytics: analyticsFor(s), frames })
  const fb = normalizeFeedback(r.feedback, { model: r.model, watchedVideo: r.watchedVideo, frames: r.frames })
  if (saved) fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ ...saved, coach: fb }))
  else fs.writeFileSync(path.join(dir, 'coach.json'), JSON.stringify(fb, null, 1) + '\n')
  console.log(`\n== ${id} (${r.model}) ==\n${fb.headline}\n${fb.summary}\n- ${fb.focus.map((f) => `${f.title}: ${f.detail}`).join('\n- ')}\n> ${fb.next_goal}`)
}
