// Moderation, server side. The admin page (/#/admin) sends the password with
// each request; it is compared here, against ADMIN_PASSWORD, and never in the
// browser. The database then demands its own secret (ADMIN_RPC_SECRET, stored
// there only as a bcrypt hash), so the browser never holds a key that can
// approve anything.
import crypto from 'node:crypto'
import { env } from './core.mjs'

const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

/** → { status, json } */
export async function admin(password, body) {
  const url = env('SUPABASE_URL') || env('VITE_SUPABASE_URL'), key = env('SUPABASE_ANON_KEY') || env('VITE_SUPABASE_ANON_KEY')
  const pw = env('ADMIN_PASSWORD'), secret = env('ADMIN_RPC_SECRET')
  if (!url || !key || !pw || !secret) return { status: 503, json: { error: 'Moderation is not set up yet. Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ADMIN_PASSWORD and ADMIN_RPC_SECRET.' } }
  if (!password || !same(password, pw)) {
    await new Promise((r) => setTimeout(r, 600)) // slow down guessing
    return { status: 401, json: { error: 'Wrong password.' } }
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const rpc = async (name, args) => {
    const r = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify({ p_secret: secret, ...args }) })
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error(j?.message ?? `Database said ${r.status}`)
    return j
  }
  try {
    if (body?.action === 'list') {
      const rows = await rpc('admin_pending', {})
      const items = await Promise.all((rows ?? []).map(async (c) => {
        const s = await fetch(`${url}/storage/v1/object/sign/climb-videos/${c.video_path}`, { method: 'POST', headers, body: JSON.stringify({ expiresIn: 3600 }) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        const { video_path: _path, ...rest } = c
        return { ...rest, videoUrl: s?.signedURL ? `${url}/storage/v1${s.signedURL}` : null }
      }))
      return { status: 200, json: { items } }
    }
    if (body?.action === 'review' && typeof body.id === 'string') {
      await rpc('admin_review', { p_id: body.id, p_approve: Boolean(body.approve) })
      return { status: 200, json: { ok: true } }
    }
    return { status: 400, json: { error: 'Unknown action.' } }
  } catch (e) {
    return { status: 502, json: { error: e.message } }
  }
}
