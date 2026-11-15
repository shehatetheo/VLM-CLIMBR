// Saved climbs and the community feed, on Supabase.
//
// Everything here is optional: with no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// the app runs in "this device only" mode and these functions report that.
// No sign-up: each device signs in anonymously and gets a real user id, which
// can be upgraded to a full account later without losing its climbs.
//   TODO(sign-up): supabase.auth.updateUser({ email }) or linkIdentity(...) on
//   the anonymous user keeps the same auth.uid(), so every row stays theirs.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUsername } from './names'
import { coachInsights, coachScore, bestMove } from './score'
import { climbStatus, type ClimbStatus } from './status'
import { getPrefs, setPrefs } from './store'
import type { Session } from './types'

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const cloudEnabled = Boolean(URL_ && KEY)

let client: SupabaseClient | null = null
export function supa(): SupabaseClient {
  if (!cloudEnabled) throw new Error('Saving online is not set up yet.')
  client ??= createClient(URL_!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'climbr:auth' } })
  return client
}

export interface Me { id: string; username: string }
let me: Promise<Me | null> | null = null
/** The signed-in device user, created silently on first use. Null when the
 *  cloud is off or anonymous sign-ins are not enabled on the project. */
export function ensureUser(): Promise<Me | null> {
  if (!cloudEnabled) return Promise.resolve(null)
  me ??= (async () => {
    const sb = supa()
    let { data: { session } } = await sb.auth.getSession()
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously()
      if (error || !data.session) { console.warn('[cloud] anonymous sign-in failed:', error?.message); return null }
      session = data.session
    }
    const id = session.user.id
    const { data: row } = await sb.from('profiles').select('username').eq('id', id).maybeSingle()
    let username = row?.username as string | undefined
    if (!username) {
      // A few tries in case the random name is taken.
      for (let i = 0; i < 4 && !username; i++) {
        const candidate = getPrefs().username && i === 0 ? getPrefs().username! : randomUsername()
        const { error } = await sb.from('profiles').upsert({ id, username: candidate, theme: getPrefs().theme ?? 'lime' })
        if (!error) username = candidate
      }
    }
    if (!username) return null
    setPrefs({ username })
    return { id, username }
  })().catch((e) => { console.warn('[cloud]', e); return null })
  return me
}

export interface CloudClimb {
  id: string
  username: string
  title: string
  route_color: string
  hold_count: number
  duration: number
  status: ClimbStatus
  coach_score: number
  sub_scores: { key: string; label: string; value: number }[]
  highlight: { title: string; body: string; time: number | null } | null
  visibility: 'private' | 'public'
  is_approved: boolean
  is_example: boolean
  created_at: string
  video_path: string
  thumbnail_path: string | null
  mine: boolean
  propped: boolean
  saved: boolean
  /** Your own climbs carry an exact count; everyone else's a soft range ("a few", "10+"). */
  props: string | null
  thumbUrl?: string | null
  videoUrl?: string | null
}

const SIGN_SECONDS = 60 * 60
async function sign(bucket: string, paths: (string | null)[]) {
  const wanted = paths.filter((p): p is string => Boolean(p))
  if (!wanted.length) return new Map<string, string>()
  const { data } = await supa().storage.from(bucket).createSignedUrls(wanted, SIGN_SECONDS)
  return new Map((data ?? []).filter((d) => d.signedUrl && d.path).map((d) => [d.path!, d.signedUrl]))
}
async function withUrls(rows: CloudClimb[], video = true): Promise<CloudClimb[]> {
  const [thumbs, videos] = await Promise.all([sign('climb-thumbnails', rows.map((r) => r.thumbnail_path)), video ? sign('climb-videos', rows.map((r) => r.video_path)) : Promise.resolve(new Map<string, string>())])
  return rows.map((r) => ({ ...r, thumbUrl: r.thumbnail_path ? thumbs.get(r.thumbnail_path) ?? null : null, videoUrl: videos.get(r.video_path) ?? null }))
}

/** POST one object with upload progress (supabase-js has no progress callback). */
function upload(bucket: string, path: string, blob: Blob, token: string, onProgress?: (p: number) => void) {
  return new Promise<void>((res, rej) => {
    const x = new XMLHttpRequest()
    x.open('POST', `${URL_}/storage/v1/object/${bucket}/${path}`)
    x.setRequestHeader('Authorization', `Bearer ${token}`)
    x.setRequestHeader('apikey', KEY!)
    x.setRequestHeader('x-upsert', 'true')
    x.setRequestHeader('Content-Type', blob.type || 'application/octet-stream')
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    x.onload = () => (x.status < 300 ? res() : rej(new Error(`Upload failed (${x.status})`)))
    x.onerror = () => rej(new Error('Upload failed. Check your connection.'))
    x.send(blob)
  })
}

/** The analysis as stored: everything the replay needs, minus this device's
 *  object URLs. Overlays are drawn live from it; nothing is burned into the video. */
function analysisOf(s: Session) {
  const { wall: _wall, coach, ...rest } = s
  return { ...rest, coach: coach ?? null, video: s.video ? { ...s.video, src: '', webm: undefined, poster: undefined, mediaId: undefined } : undefined }
}

/** Save one analyzed climb: the server's H.264 copy (no camera metadata, no
 *  location), a thumbnail, and the analysis. Returns the cloud id. */
export async function saveClimb(s: Session, onProgress?: (p: number) => void): Promise<string> {
  const user = await ensureUser()
  if (!user) throw new Error('Saving online is not available right now. Your climb is still saved on this device.')
  if (!s.video?.src) throw new Error('This climb has no video to save.')
  const sb = supa()
  const { data: { session } } = await sb.auth.getSession()
  const token = session!.access_token
  const id = crypto.randomUUID()
  const video = await (await fetch(s.video.src)).blob()
  const videoPath = `${user.id}/${id}.mp4`
  await upload('climb-videos', videoPath, video, token, (p) => onProgress?.(p * 0.92))
  let thumbPath: string | null = null
  if (s.video.poster) {
    try {
      const poster = await (await fetch(s.video.poster)).blob()
      thumbPath = `${user.id}/${id}.jpg`
      await upload('climb-thumbnails', thumbPath, poster, token)
    } catch { thumbPath = null }
  }
  const score = coachScore(s), status = climbStatus(s), best = bestMove(s)
  const { error } = await sb.from('climbs').insert({
    id, user_id: user.id, title: s.title, video_path: videoPath, thumbnail_path: thumbPath,
    duration: s.video.duration ?? s.duration, route_color: s.route.color, hold_count: s.holdsDetected,
    status: status.status, coach_score: score.total, sub_scores: score.parts.map(({ key, label, value }) => ({ key, label, value })),
    analysis: { ...analysisOf(s), insights: coachInsights(s).slice(0, 8), status },
    highlight: best ? { title: best.title, body: best.body, time: best.time ?? null } : null,
    visibility: 'private',
  })
  if (error) {
    await sb.storage.from('climb-videos').remove([videoPath])
    if (thumbPath) await sb.storage.from('climb-thumbnails').remove([thumbPath])
    throw new Error(/daily_limit/.test(error.message) ? 'You have saved a lot of climbs today. Try again tomorrow.' : 'We could not save this climb online. It is still on this device.')
  }
  onProgress?.(1)
  return id
}

export async function listMyClimbs(): Promise<CloudClimb[]> {
  if (!(await ensureUser())) return []
  const { data, error } = await supa().rpc('my_climbs')
  if (error) throw new Error('We could not load your climbs.')
  return withUrls((data ?? []) as CloudClimb[], false)
}

/** Share or unshare a climb. Returns whether it is approved, so the app can
 *  say "in the feed" or "in review" (approval is automatic unless the
 *  database's auto_approve setting is switched off). */
export async function setVisibility(id: string, visibility: 'private' | 'public'): Promise<boolean> {
  const { data, error } = await supa().from('climbs').update({ visibility }).eq('id', id).select('is_approved').single()
  if (error) throw new Error('We could not change that. Try again.')
  return Boolean(data?.is_approved)
}
export const sharedMessage = (approved: boolean) => (approved ? 'Shared. It is in the feed now.' : 'Sent for review. It shows up in the feed once it is approved.')

export async function deleteClimb(c: Pick<CloudClimb, 'id' | 'video_path' | 'thumbnail_path'>) {
  const sb = supa()
  const { error } = await sb.from('climbs').delete().eq('id', c.id)
  if (error) throw new Error('We could not delete that climb. Try again.')
  await sb.storage.from('climb-videos').remove([c.video_path])
  if (c.thumbnail_path) await sb.storage.from('climb-thumbnails').remove([c.thumbnail_path])
}

/** One page of the feed, newest first. `cursor` is the created_at of the last item seen. */
export async function fetchFeed(opts: { cursor?: string | null; color?: string | null; saved?: boolean; limit?: number } = {}): Promise<{ items: CloudClimb[]; next: string | null }> {
  await ensureUser()
  const limit = opts.limit ?? 6
  const { data, error } = await supa().rpc(opts.saved ? 'saved_feed' : 'feed', { p_cursor: opts.cursor ?? null, p_limit: limit, ...(opts.saved ? {} : { p_color: opts.color ?? null }) })
  if (error) throw new Error('We could not load the feed.')
  const items = await withUrls((data ?? []) as CloudClimb[])
  return { items, next: items.length === limit ? items[items.length - 1].created_at : null }
}

/** A cloud climb as a Session the replay can open. */
export async function loadCloudSession(id: string): Promise<Session | null> {
  await ensureUser()
  const { data, error } = await supa().rpc('get_climb', { p_id: id })
  const row = (Array.isArray(data) ? data[0] : data) as (CloudClimb & { analysis: Session }) | null
  if (error || !row?.analysis) return null
  const [c] = await withUrls([row])
  const s = row.analysis
  return { ...s, id: `c-${id}`, coach: s.coach ?? undefined, video: s.video && c.videoUrl ? { ...s.video, src: c.videoUrl, poster: c.thumbUrl ?? undefined } : undefined }
}

export async function toggleProps(id: string, on: boolean) {
  const user = await ensureUser()
  if (!user) throw new Error('Props are not available right now.')
  const q = supa().from('props')
  const { error } = on ? await q.upsert({ user_id: user.id, climb_id: id }) : await q.delete().eq('user_id', user.id).eq('climb_id', id)
  if (error) throw new Error('That did not go through. Try again.')
}
export async function toggleSave(id: string, on: boolean) {
  const user = await ensureUser()
  if (!user) throw new Error('Saving is not available right now.')
  const q = supa().from('saves')
  const { error } = on ? await q.upsert({ user_id: user.id, climb_id: id }) : await q.delete().eq('user_id', user.id).eq('climb_id', id)
  if (error) throw new Error('That did not go through. Try again.')
}
export type ReportReason = 'not_climbing' | 'inappropriate' | 'other'
export async function reportClimb(id: string, reason: ReportReason) {
  if (!(await ensureUser())) throw new Error('Reporting is not available right now.')
  const { error } = await supa().rpc('report_climb', { p_climb: id, p_reason: reason })
  if (error) throw new Error('We could not send that report. Try again.')
}
export async function renameMe(username: string) {
  const user = await ensureUser()
  if (!user) return
  const { error } = await supa().from('profiles').update({ username }).eq('id', user.id)
  if (error) throw new Error('That name is taken. Try another.')
  me = Promise.resolve({ ...user, username })
}
