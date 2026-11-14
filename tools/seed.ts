// Seed the example climbs into the database, so the feed's examples come from
// Supabase instead of the bundled files.
//
// Build: npx rolldown tools/seed.ts -p node -f esm -o .climbr/seed.mjs
// Run:   VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… ADMIN_RPC_SECRET=… node .climbr/seed.mjs
//
// It signs in as a fresh anonymous user (the "official CLIMBR account"), uploads
// each example's clip and poster, saves the analysis, then asks the database,
// with the moderation secret, to mark the climb as an approved example.
// Running it again replaces the examples.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { buildSession, type SessionParts } from '../src/lib/session'
import { bestMove, coachInsights, coachScore } from '../src/lib/score'
import { climbStatus } from '../src/lib/status'

const url = process.env.VITE_SUPABASE_URL, key = process.env.VITE_SUPABASE_ANON_KEY, secret = process.env.ADMIN_RPC_SECRET
if (!url || !key || !secret) { console.error('Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and ADMIN_RPC_SECRET.'); process.exit(1) }
const sb = createClient(url, key, { auth: { persistSession: false } })
const EXAMPLES = ['green-vb']

const { data: auth, error: authError } = await sb.auth.signInAnonymously()
if (authError || !auth.user) { console.error('Anonymous sign-in failed. Enable it under Authentication → Sign In / Providers.', authError?.message); process.exit(1) }
const uid = auth.user.id
await sb.from('profiles').upsert({ id: uid, username: `Climbr${Math.floor(1000 + Math.random() * 9000)}` })
{ const { error } = await sb.rpc('admin_clear_examples', { p_secret: secret }); if (error) { console.error('The moderation secret was refused:', error.message); process.exit(1) } }

for (const id of EXAMPLES) {
  const dir = path.join('public', 'examples', id)
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : undefined)
  const manifest = read('climbr.json'), files = manifest?.files ?? {}
  const coach = read('coach.json')
  const parts: SessionParts = { manifest: coach ? { ...manifest, coach } : manifest, climb: read(files.climb ?? 'climb.json'), sequence: read(files.sequence ?? 'sequence.json'), holds: read(files.holds ?? 'holds.json'), comparison: read(files.comparison ?? 'comparison.json'), baseUrl: '', kind: 'example' }
  const s = buildSession(parts)
  const climbId = crypto.randomUUID()
  const videoPath = `${uid}/${climbId}.mp4`, thumbPath = `${uid}/${climbId}.jpg`
  for (const [bucket, p, file, type] of [['climb-videos', videoPath, 'climb.mp4', 'video/mp4'], ['climb-thumbnails', thumbPath, 'poster.jpg', 'image/jpeg']] as const) {
    const { error } = await sb.storage.from(bucket).upload(p, fs.readFileSync(path.join(dir, file)), { contentType: type, upsert: true })
    if (error) { console.error(`Upload of ${file} failed:`, error.message); process.exit(1) }
  }
  const score = coachScore(s), status = climbStatus(s), best = bestMove(s)
  const { wall: _wall, ...rest } = s
  const { error } = await sb.from('climbs').insert({
    id: climbId, user_id: uid, title: s.title, video_path: videoPath, thumbnail_path: thumbPath, duration: s.video?.duration ?? s.duration,
    route_color: s.route.color, hold_count: s.holdsDetected, status: status.status, coach_score: score.total,
    sub_scores: score.parts.map(({ key, label, value }) => ({ key, label, value })),
    analysis: { ...rest, video: s.video ? { ...s.video, src: '', poster: undefined } : undefined, insights: coachInsights(s).slice(0, 8), status },
    highlight: best ? { title: best.title, body: best.body, time: best.time ?? null } : null,
  })
  if (error) { console.error('Saving the climb failed:', error.message); process.exit(1) }
  const marked = await sb.rpc('admin_mark_example', { p_secret: secret, p_id: climbId })
  if (marked.error) { console.error('Marking the example failed:', marked.error.message); process.exit(1) }
  console.log(`seeded ${id} → ${climbId} (score ${score.total}, ${status.status})`)
}
