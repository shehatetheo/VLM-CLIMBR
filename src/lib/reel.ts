// The performance reel: one picture that tells the whole climb, in the format
// of the vision-demos renders. While the clip plays: the clip with its overlays,
// beside the wall with every hold and the climber's skeleton on it, beside the
// numbers. Then a finale on the wall alone: each hold relights in the colour of
// the limb that used it, numbered in order, the torso's path draws itself, and
// the climb is summed up.
//
// It is drawn on a 2D canvas, so the app can play it live at any size and
// record it to a video file (videoexport.ts) from the same code.

import { coachInsights, coachScore, verdict, type CoachScore } from './score'
import { climbStatus, type StatusRead } from './status'
import { holdFill } from './colors'
import { invertAffine } from './geometry'
import { applyM, invert, motionAt, IDENTITY, type Affine } from './motion'
import { LIMB_JOINT, overlayAt } from './overlay'
import { DRAW_MIN_CONFIDENCE, poseAt } from './skeleton'
import type { Timeline } from './timeline'
import { GOLD, LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type LimbKey, type Session, type Vec2 } from './types'

export type ReelFormat = 'landscape' | 'portrait'
export const REEL_SIZE: Record<ReelFormat, [number, number]> = { landscape: [1920, 1080], portrait: [1080, 1920] }

const FONT = "'Selawik', 'Open Sans Variable', 'Segoe UI', system-ui, sans-serif"

// The reel wears the app's look: the current color's deep page, its glow and
// art, and its glossy primary for the capsules. Always the dark page, so the
// clip and the wall read well in any app mode.
interface Look { theme: 'lime' | 'sunset' | 'dusk'; bg: [string, string, string]; glow: string; art: string; a: string; b: string; edge: string; ink: string }
const LOOKS: Record<Look['theme'], Look> = {
  lime: { theme: 'lime', bg: ['#1f4214', '#0b1808', '#040803'], glow: 'rgba(155,227,106,0.30)', art: '#9be36a', a: '#8fd957', b: '#4fa62a', edge: '#2f7d18', ink: '#0f3608' },
  sunset: { theme: 'sunset', bg: ['#4d260a', '#1b0e05', '#080402'], glow: 'rgba(255,160,60,0.30)', art: '#ffab3d', a: '#ffb347', b: '#f07a00', edge: '#a34f00', ink: '#2b1400' },
  dusk: { theme: 'dusk', bg: ['#312a64', '#16132e', '#08071a'], glow: 'rgba(185,165,255,0.28)', art: '#c9bdf5', a: '#f1eefb', b: '#b4abd8', edge: '#6f6699', ink: '#1a1533' },
}
const currentLook = (): Look => LOOKS[(typeof document !== 'undefined' ? document.documentElement.dataset.theme : 'lime') as Look['theme']] ?? LOOKS.lime

/** What the reel needs from the page before it can draw: the logo in the
 *  current color, and Selawik loaded so the canvas can use it. */
export async function loadReelArt(): Promise<{ logo: HTMLImageElement | null }> {
  const { theme } = currentLook()
  const src = theme === 'lime' ? '/brand/logo-660.webp' : `/brand/logo-${theme}-660.webp`
  const logo = await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src })
  try { await Promise.all(['300', '600', '700'].map((w) => document.fonts.load(`${w} 40px Selawik`))) } catch { /* the system font stands in */ }
  return { logo }
}

// COCO-17 bones, coloured by the limb they belong to.
const LIMB_BONES: [number, number, LimbKey | null][] = [
  [5, 7, 'left_hand'], [7, 9, 'left_hand'], [6, 8, 'right_hand'], [8, 10, 'right_hand'],
  [11, 13, 'left_foot'], [13, 15, 'left_foot'], [12, 14, 'right_foot'], [14, 16, 'right_foot'],
  [5, 6, null], [5, 11, null], [6, 12, null], [11, 12, null],
]

export interface Reel {
  s: Session
  tl: Timeline
  clip: number // seconds of video
  finale: { relight: number; step: number; summary: number; send: number; total: number }
  total: number
  wall: CanvasImageSource | null
  order: { id: number; time: number; color: string }[] // holds in the order they were first used
  torso: [number, number, number][] // [climb seconds, x, y] on the canvas
  meters: { climbed: number; travelled: number } | null
  score: CoachScore
  line: string // the one thing to fix first, in a sentence
  status: StatusRead
  look: Look
  logo: HTMLImageElement | null
  /** The wall, tiny: drawn large, it is the out-of-focus fill behind the scan. */
  wallSoft: HTMLCanvasElement | null
  /** The clip already has the skeleton drawn into it: do not draw it again. */
  bareClip: boolean
}

export function prepareReel(s: Session, tl: Timeline, clip: number, wall: CanvasImageSource | null, art: { logo?: HTMLImageElement | null; bareClip?: boolean } = {}): Reel {
  const order = [...tl.firstUse.entries()].sort((a, b) => a[1].time - b[1].time).map(([id, f]) => ({ id, time: f.time, color: holdFill(s, id) }))
  const torso = (s.torso ?? []).filter((p) => p[0] >= 0 && p[0] <= tl.climbEnd)
  const step = order.length > 14 ? 0.22 : 0.32
  const status = climbStatus(s)
  const summary = 0.9 + order.length * step + 0.4
  // A send gets its moment: the burst, the sticker, the score counting up.
  const finale = { relight: 0.9, step, summary, send: status.status === 'sent' ? summary + 0.25 : Infinity, total: summary + (status.status === 'sent' ? 5.2 : 3.2) }
  let meters: Reel['meters'] = null
  if (s.scale && order.length) {
    const aspect = s.canvas.width / s.canvas.height
    const ys = torso.map((p) => p[2])
    let travelled = 0
    for (let i = 1; i < torso.length; i++) travelled += Math.hypot((torso[i][1] - torso[i - 1][1]) * aspect, torso[i][2] - torso[i - 1][2])
    // How far the body rose, and how far it moved in all: from the torso's path.
    if (ys.length > 1) meters = { climbed: (Math.max(...ys) - Math.min(...ys)) * s.scale.metersPerUnit, travelled: travelled * s.scale.metersPerUnit }
  }
  const insights = coachInsights(s)
  const line = insights.find((i) => i.kind === 'fix')?.short ?? insights.find((i) => i.kind === 'good')?.title ?? verdict(s, insights)
  const { plate, soft } = dressWall(wall)
  return { s, tl, clip, finale, total: clip + finale.total, wall: plate, wallSoft: soft, order, torso, meters, score: coachScore(s), line, status, look: currentLook(), logo: art.logo ?? null, bareClip: art.bareClip ?? false }
}

/** The wall plate, dressed for the reel: its edges feathered so it melts into
 *  the fill behind it, and a tiny copy that, drawn large, is that fill. */
function dressWall(wall: CanvasImageSource | null): { plate: CanvasImageSource | null; soft: HTMLCanvasElement | null } {
  if (!wall || typeof document === 'undefined') return { plate: wall, soft: null }
  const iw = (wall as HTMLImageElement).naturalWidth || (wall as HTMLCanvasElement).width, ih = (wall as HTMLImageElement).naturalHeight || (wall as HTMLCanvasElement).height
  if (!iw || !ih) return { plate: wall, soft: null }
  const soft = document.createElement('canvas')
  soft.width = 28
  soft.height = Math.max(2, Math.round((28 * ih) / iw))
  const sc = soft.getContext('2d')!
  sc.imageSmoothingQuality = 'high'
  sc.drawImage(wall, 0, 0, soft.width, soft.height)
  const plate = document.createElement('canvas')
  plate.width = iw
  plate.height = ih
  const pc = plate.getContext('2d')!
  pc.drawImage(wall, 0, 0)
  pc.globalCompositeOperation = 'destination-in'
  const fx = iw * 0.07, fy = ih * 0.05
  const gx = pc.createLinearGradient(0, 0, iw, 0)
  gx.addColorStop(0, 'rgba(0,0,0,0)'); gx.addColorStop(fx / iw, '#000'); gx.addColorStop(1 - fx / iw, '#000'); gx.addColorStop(1, 'rgba(0,0,0,0)')
  pc.fillStyle = gx
  pc.fillRect(0, 0, iw, ih)
  const gy = pc.createLinearGradient(0, 0, 0, ih)
  gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(fy / ih, '#000'); gy.addColorStop(1 - fy / ih, '#000'); gy.addColorStop(1, 'rgba(0,0,0,0)')
  pc.fillStyle = gy
  pc.fillRect(0, 0, iw, ih)
  return { plate, soft }
}

interface Rect { x: number; y: number; w: number; h: number }
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const mix = (a: Rect, b: Rect, k: number): Rect => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) })
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
/** The rect that fills `r` at this aspect, overflowing on one axis. */
function cover(r: Rect, aspect: number): Rect {
  const w = Math.max(r.w, r.h * aspect), h = w / aspect
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }
}
/** How much of the picture each side loses when it fills `r` (0.05 = 5%). */
const coverCrop = (r: Rect, aspect: number) => { const c = cover(r, aspect); return Math.max(c.w - r.w, c.h - r.h) / 2 / Math.max(c.w, c.h) }
const fit = (box: Rect, aspect: number): Rect => {
  const w = Math.min(box.w, box.h * aspect), h = w / aspect
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/** Where everything goes, for a canvas of W×H. `u` is one layout unit. */
function layout(R: Reel, W: number, H: number, clipAspect: number) {
  const portrait = H > W
  const u = Math.min(W, H) / 1080
  const pad = 36 * u, gap = 22 * u
  const header: Rect = { x: pad, y: pad, w: W - 2 * pad, h: 92 * u }
  const body: Rect = { x: pad, y: header.y + header.h + gap, w: W - 2 * pad, h: H - pad - (header.y + header.h + gap) }
  const mapAspect = R.s.canvas.width / R.s.canvas.height
  let clip: Rect, map: Rect, stats: Rect
  if (portrait) {
    // The pictures on top, side by side; the numbers underneath.
    const top: Rect = { ...body, h: body.h - Math.max(body.h * 0.33, 540 * u) - gap }
    if (clipAspect > 1) {
      clip = { x: top.x, y: top.y, w: top.w, h: Math.min(top.h * 0.55, top.w / clipAspect) }
      map = { x: top.x, y: clip.y + clip.h + gap, w: top.w, h: top.h - clip.h - gap }
    } else {
      // A tall clip gets the wider column and fills it (drawReel crops its
      // sides a touch), so the clip and the wall end on the same line.
      const cw = Math.min(top.w * 0.6, top.h * clipAspect)
      clip = { x: top.x, y: top.y, w: cw, h: top.h }
      map = { x: top.x + cw + gap, y: top.y, w: top.w - cw - gap, h: top.h }
    }
    stats = { x: body.x, y: top.y + top.h + gap, w: body.w, h: body.h - top.h - gap }
  } else if (clipAspect > 1.15) {
    // A wide clip: clip over the numbers on the left, the wall on the right.
    const lw = Math.min(body.w * 0.56, Math.max(body.w * 0.4, body.w - gap - body.h * mapAspect))
    const ch = Math.min(lw / clipAspect, body.h * 0.66)
    clip = { x: body.x, y: body.y, w: lw, h: ch }
    stats = { x: body.x, y: body.y + ch + gap, w: lw, h: body.h - ch - gap }
    map = { x: body.x + lw + gap, y: body.y, w: body.w - lw - gap, h: body.h }
  } else {
    // Clip, wall, numbers, left to right. A wide wall takes the numbers below it instead.
    const cw = Math.min(body.h * clipAspect, body.w * 0.42)
    clip = { x: body.x, y: body.y, w: cw, h: body.h }
    const rest: Rect = { x: body.x + cw + gap, y: body.y, w: body.w - cw - gap, h: body.h }
    const mw = body.h * mapAspect
    if (rest.w - mw - gap >= 430 * u) {
      const sw = Math.min(rest.w - mw - gap, 620 * u)
      map = { x: rest.x, y: rest.y, w: rest.w - sw - gap, h: rest.h }
      stats = { x: rest.x + rest.w - sw, y: rest.y, w: sw, h: rest.h }
    } else {
      const sh = 250 * u
      map = { x: rest.x, y: rest.y, w: rest.w, h: rest.h - sh - gap }
      stats = { x: rest.x, y: rest.y + rest.h - sh, w: rest.w, h: sh }
    }
  }
  return { portrait, u, pad, gap, header, body, clip, map, stats }
}

/**
 * Draw the reel at reel time `r` (seconds: the clip, then the finale).
 * `frame` is the clip's current picture; it must already be at clip time min(r, clip).
 */
export function drawReel(ctx: CanvasRenderingContext2D, R: Reel, frame: CanvasImageSource | null, frameAspect: number, r: number, W: number, H: number) {
  const { s, tl } = R
  const L = layout(R, W, H, frameAspect)
  const { u } = L
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const offset = s.video?.offset ?? 0
  const inFinale = r >= R.clip
  const f = Math.max(0, r - R.clip) // seconds into the finale
  const vt = Math.min(r, R.clip)
  const t = inFinale ? Math.max(tl.climbEnd, vt - offset) : vt - offset // the climb clock
  const k = inFinale ? ease(clamp01(f / 0.8)) : 0 // 0 → split screen, 1 → the wall alone

  ctx.save()
  const look = R.look
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, look.bg[0])
  bg.addColorStop(0.5, look.bg[1])
  bg.addColorStop(1, look.bg[2])
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W * 0.5, 0, 0, W * 0.5, 0, Math.max(W, H) * 0.75)
  glow.addColorStop(0, look.glow)
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)
  drawBackdropArt(ctx, W, H, u, look, r)

  drawHeader(ctx, R, L.header, u, t, inFinale, route)

  // ── the clip, with what the models saw drawn on it ──
  if (k < 1) {
    ctx.save()
    ctx.globalAlpha = 1 - k
    const fill = L.portrait && frameAspect <= 1 && coverCrop(L.clip, frameAspect) <= 0.12
    const panel = fill ? L.clip : fit(L.clip, frameAspect)
    const box = fill ? cover(L.clip, frameAspect) : panel
    roundClip(ctx, panel, 18 * u)
    ctx.fillStyle = '#000'
    ctx.fillRect(panel.x, panel.y, panel.w, panel.h)
    if (frame) ctx.drawImage(frame, box.x, box.y, box.w, box.h)
    drawClipOverlay(ctx, R, box, t, u * (box.h / (L.portrait ? 900 : 880)), route)
    ctx.restore()
    chromeFrame(ctx, panel, 18 * u, u, 1 - k)
    // The moment of the top-out: the frame rings gold.
    const since = t - tl.climbEnd
    if (s.toppedOut && since >= 0 && since < 1.2) {
      ctx.save()
      for (let i = 0; i < 2; i++) {
        const q = clamp01((since - i * 0.18) / 1)
        if (q <= 0 || q >= 1) continue
        ctx.globalAlpha = (1 - q) * (1 - k)
        ctx.lineWidth = (14 - 10 * q) * u
        ctx.strokeStyle = GOLD
        ctx.shadowColor = GOLD
        ctx.shadowBlur = 30 * u
        const grow = 26 * u * q
        roundRect(ctx, panel.x - grow, panel.y - grow, panel.w + 2 * grow, panel.h + 2 * grow, 18 * u + grow)
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  // ── the wall ──
  // In the finale the wall takes the clip's room too; the numbers stay put.
  const statsEnd: Rect = L.stats
  const beside = !L.portrait && statsEnd.x > L.map.x + L.map.w - 1 // numbers in their own column
  const under = !L.portrait && !beside && statsEnd.x < L.map.x // numbers under the clip
  const full: Rect = L.portrait
    ? { ...L.body, h: statsEnd.y - L.gap - L.body.y }
    : beside ? { ...L.body, w: statsEnd.x - L.gap - L.body.x }
      : under ? { x: L.body.x, y: L.body.y, w: L.body.w, h: L.body.h } : { ...L.body, h: statsEnd.y - L.gap - L.body.y }
  const mapEnd: Rect = under ? { x: statsEnd.x + statsEnd.w + L.gap, y: L.body.y, w: L.body.w - statsEnd.w - L.gap, h: L.body.h } : full
  const mapRect = mix(L.map, mapEnd, k)
  drawWall(ctx, R, mapRect, u, t, vt, inFinale ? f : -1, route)

  // ── the numbers ──
  // Under a wide clip, the numbers grow into the clip's place as it fades.
  const statsRect = mix(L.stats, under ? { ...L.stats, y: L.body.y, h: L.body.h } : statsEnd, k)
  const coached = drawStats(ctx, R, statsRect, u, t, inFinale ? f : -1, route, L.portrait)
  if (inFinale && f >= R.finale.send) drawSendBurst(ctx, mapRect, f - R.finale.send, u, look, route)
  // Where the numbers had no room for the coach's line, it captions the wall.
  if (inFinale && !coached) {
    const a = clamp01((f - R.finale.summary) / 0.6)
    if (a > 0) {
      ctx.save()
      ctx.globalAlpha = a
      const h = 100 * u, strip: Rect = { x: mapRect.x + 14 * u, y: mapRect.y + mapRect.h - h - 14 * u, w: mapRect.w - 28 * u, h }
      roundRect(ctx, strip.x, strip.y, strip.w, strip.h, 20 * u)
      ctx.fillStyle = 'rgba(8,10,12,0.78)'
      ctx.fill()
      glass(ctx, strip, 20 * u, u)
      kicker(ctx, `coach score · ${R.score.total} · ${R.score.label}`, strip.x + 22 * u, strip.y + 36 * u, u)
      ctx.fillStyle = '#fff'
      ctx.font = `600 ${26 * u}px ${FONT}`
      ctx.fillText(ellipsis(ctx, R.line, strip.w - 44 * u), strip.x + 22 * u, strip.y + 72 * u)
      ctx.restore()
    }
  }
  ctx.restore()
}

function drawHeader(ctx: CanvasRenderingContext2D, R: Reel, box: Rect, u: number, t: number, finale: boolean, route: string) {
  const { s, tl, look } = R
  void route
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  // the logo, in the current color, as the app shows it
  let tx = box.x
  if (R.logo) {
    const h = box.h * 0.96, w = h * (R.logo.naturalWidth / Math.max(1, R.logo.naturalHeight))
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = 10 * u
    ctx.shadowOffsetY = 3 * u
    ctx.drawImage(R.logo, box.x, box.y + (box.h - h) / 2, w, h)
    ctx.restore()
    tx = box.x + w + 22 * u
  }
  const right = 300 * u
  ctx.fillStyle = '#fff'
  ctx.font = `300 ${42 * u}px ${FONT}`
  ctx.fillText(ellipsis(ctx, s.title.toLowerCase(), box.x + box.w - right - tx), tx, box.y + box.h * 0.55)
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = `600 ${19 * u}px ${FONT}`
  ctx.fillText(ellipsis(ctx, `${s.climber} · ${s.route.color} route${s.route.grade ? ` · ${s.route.grade}` : ''}`, box.x + box.w - right - tx), tx, box.y + box.h * 0.9)

  const done = s.toppedOut && t >= tl.climbEnd
  const clock = Math.max(0, Math.min(t, tl.climbEnd))
  ctx.textAlign = 'right'
  ctx.fillStyle = done ? GOLD : '#fff'
  ctx.font = `700 ${54 * u}px ${FONT}`
  ctx.fillText(`${clock.toFixed(2)}s`, box.x + box.w, box.y + box.h * 0.55)
  const label = finale ? (s.toppedOut ? 'topped out' : 'the climb') : t < 0 ? 'pulling on' : done ? 'topped out' : t < tl.climbEnd ? 'on the wall' : 'off the wall'
  capsule(ctx, label, box.x + box.w, box.y + box.h * 0.66, 15 * u, u, look, 'right')
  ctx.textAlign = 'left'
}

function drawClipOverlay(ctx: CanvasRenderingContext2D, R: Reel, box: Rect, t: number, px: number, route: string) {
  const ov = overlayAt(R.s, R.tl, t)
  if (!ov) return
  const P = (q: Vec2): Vec2 => [box.x + q[0] * box.w, box.y + q[1] * box.h]
  for (const h of ov.holds) {
    poly(ctx, h.poly.map(P))
    if (h.lit) {
      ctx.fillStyle = hexA(route, h.held ? 0.6 : 0.4)
      ctx.fill()
    }
    ctx.lineJoin = 'round'
    ctx.lineWidth = (h.held ? 4 : 2.6) * px
    ctx.strokeStyle = h.held ? '#fff' : route
    ctx.stroke()
  }
  if (ov.joints && !R.bareClip) drawSkeleton(ctx, ov.joints.map((j) => ({ p: P(j.p), ok: j.c >= DRAW_MIN_CONFIDENCE })), ov.holding, px)
  if (!R.bareClip) for (const { key, p } of ov.fallbackLimbs) dot(ctx, P(p), 8 * px, LIMB_BY_KEY[key].color, px)
}

function drawSkeleton(ctx: CanvasRenderingContext2D, J: { p: Vec2; ok: boolean }[], holding: Map<LimbKey, number | null> | null, px: number) {
  ctx.lineCap = 'round'
  for (const [a, b, limb] of LIMB_BONES) {
    if (!J[a].ok || !J[b].ok) continue
    ctx.beginPath()
    ctx.moveTo(J[a].p[0], J[a].p[1])
    ctx.lineTo(J[b].p[0], J[b].p[1])
    ctx.lineWidth = (limb ? 4.2 : 3.4) * px
    ctx.strokeStyle = limb ? LIMB_BY_KEY[limb].color : 'rgba(255,255,255,0.92)'
    ctx.stroke()
  }
  for (const i of [5, 6, 7, 8, 11, 12, 13, 14]) if (J[i].ok) dot(ctx, J[i].p, 3.6 * px, '#fff', px * 0.6)
  for (const l of LIMBS) {
    const j = J[LIMB_JOINT[l.key]]
    if (j.ok) dot(ctx, j.p, (holding?.get(l.key) != null ? 10 : 6) * px, l.color, px)
  }
  if (J[0].ok) {
    // the head, sized from the shoulders
    const sh = J[5].ok && J[6].ok ? Math.hypot(J[5].p[0] - J[6].p[0], J[5].p[1] - J[6].p[1]) : 40 * px
    ctx.beginPath()
    ctx.arc(J[0].p[0], J[0].p[1], Math.max(7 * px, sh * 0.32), 0, Math.PI * 2)
    ctx.lineWidth = 3 * px
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.stroke()
  }
}

/** The wall canvas: plate, holds, skeleton, torso path; in the finale, the relight. */
function drawWall(ctx: CanvasRenderingContext2D, R: Reel, panel: Rect, u: number, t: number, vt: number, f: number, route: string) {
  const { s, tl } = R
  const aspect = s.canvas.width / s.canvas.height
  ctx.save()
  roundClip(ctx, panel, 18 * u)
  ctx.fillStyle = '#07090b'
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h)
  const finale = f >= 0
  const head = (finale ? 92 : 78) * u // the heading has its own room above the wall
  const box = fit({ x: panel.x + 10 * u, y: panel.y + head, w: panel.w - 20 * u, h: panel.h - head - 10 * u }, aspect)
  const C = (p: Vec2): Vec2 => [box.x + p[0] * box.w, box.y + p[1] * box.h]
  const px = Math.max(0.6, box.h / 900) * u // strokes scale with the wall as it is drawn

  if (R.wallSoft) {
    // The wall fills its whole panel: out of focus behind, the scan itself on top.
    ctx.save()
    ctx.globalAlpha = 0.36
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const c = cover(panel, R.wallSoft.width / R.wallSoft.height)
    ctx.drawImage(R.wallSoft, c.x - c.w * 0.04, c.y - c.h * 0.04, c.w * 1.08, c.h * 1.08)
    ctx.restore()
  }
  if (R.wall) {
    ctx.save()
    ctx.globalAlpha = R.wallSoft ? 0.74 : 0.62
    const m = invertAffine(s.wall?.affine ?? IDENTITY)
    ctx.setTransform(ctx.getTransform().multiply(new DOMMatrix([box.w * m[0][0], box.h * m[1][0], box.w * m[0][1], box.h * m[1][1], box.x + box.w * m[0][2], box.y + box.h * m[1][2]])))
    ctx.drawImage(R.wall, 0, 0, 1, 1)
    ctx.restore()
  }

  // As the wall takes the stage, one pass of light down it: the scan.
  if (finale && f > 0.1 && f < 1.3) {
    const q = (f - 0.1) / 1.2, y = box.y + box.h * q, band = 110 * u
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.sin(Math.PI * q) ** 0.5
    const g = ctx.createLinearGradient(0, y - band, 0, y + 6 * u)
    g.addColorStop(0, hexA(R.look.art, 0))
    g.addColorStop(0.85, hexA(R.look.art, 0.35))
    g.addColorStop(1, 'rgba(255,255,255,0.9)')
    ctx.fillStyle = g
    ctx.fillRect(box.x, y - band, box.w, band + 6 * u)
    ctx.restore()
  }
  const tc = Math.max(0, Math.min(t, tl.climbEnd))
  const lit = new Set(tl.litAt(tc)) // the same clock as the numbers below
  const holdingNow = new Map(LIMBS.map((l) => [l.key, finale ? null : tl.limbAt(l.key, tc).holdId] as const))
  const heldBy = new Map<number, LimbKey[]>()
  for (const [limb, id] of holdingNow) if (id != null) heldBy.set(id, [...(heldBy.get(id) ?? []), limb])
  const relit = finale ? Math.floor((f - R.finale.relight) / R.finale.step) + 1 : 0 // holds relit so far
  const dim = finale ? clamp01(f / 0.6) : 0

  // the torso's path, dotted
  const upto = finale ? clamp01((f - R.finale.relight) / Math.max(0.01, R.order.length * R.finale.step)) * tl.climbEnd : tc
  const path = R.torso.filter((p) => p[0] <= upto)
  if (path.length > 1 && (finale ? f >= R.finale.relight : true)) {
    ctx.beginPath()
    path.forEach((p, i) => { const [x, y] = C([p[1], p[2]]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
    ctx.setLineDash([2 * px, 9 * px])
    ctx.lineCap = 'round'
    ctx.lineWidth = 3.4 * px
    ctx.strokeStyle = finale ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)'
    ctx.stroke()
    ctx.setLineDash([])
  }

  for (const h of s.holds) {
    const pts = h.polygon.map(C)
    const rank = R.order.findIndex((o) => o.id === h.id)
    poly(ctx, pts)
    ctx.lineJoin = 'round'
    if (finale) {
      const on = rank >= 0 && rank < relit
      if (on) {
        const pop = clamp01((f - R.finale.relight - rank * R.finale.step) / 0.25)
        ctx.fillStyle = hexA(R.order[rank].color, 0.55 + 0.4 * pop)
        ctx.fill()
        ctx.lineWidth = 3 * px
        ctx.strokeStyle = h.id === s.finalHoldId && s.toppedOut ? GOLD : '#fff'
        ctx.stroke()
      } else {
        ctx.fillStyle = rank >= 0 ? hexA(route, 0.4 * (1 - dim)) : 'rgba(0,0,0,0)'
        ctx.fill()
        ctx.lineWidth = 2 * px
        ctx.strokeStyle = `rgba(255,255,255,${rank >= 0 ? 0.45 : 0.22})`
        ctx.stroke()
      }
    } else {
      const held = heldBy.get(h.id)
      if (held) {
        ctx.fillStyle = hexA(held.length === 1 ? LIMB_BY_KEY[held[0]].color : route, 0.85)
        ctx.fill()
        ctx.lineWidth = 3.4 * px
        ctx.strokeStyle = '#fff'
      } else if (lit.has(h.id)) {
        ctx.fillStyle = hexA(route, 0.5)
        ctx.fill()
        ctx.lineWidth = 2.4 * px
        ctx.strokeStyle = route
      } else {
        ctx.lineWidth = 2 * px
        ctx.strokeStyle = 'rgba(255,255,255,0.38)'
      }
      ctx.stroke()
    }
  }

  // order badges, in the finale
  if (finale) {
    R.order.forEach((o, rank) => {
      if (rank >= relit) return
      const h = s.holds.find((x) => x.id === o.id)
      if (!h) return
      const [cx, cy] = C([h.bbox[0] + h.bbox[2], h.bbox[1]])
      const rr = 15 * px
      ctx.beginPath()
      ctx.arc(cx + rr * 0.4, cy - rr * 0.2, rr, 0, Math.PI * 2)
      ctx.fillStyle = h.id === s.finalHoldId && s.toppedOut ? GOLD : '#fff'
      ctx.fill()
      ctx.fillStyle = '#08090b'
      ctx.font = `800 ${17 * px}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(rank + 1), cx + rr * 0.4, cy - rr * 0.2 + px)
    })
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  } else {
    // the climber on the wall: the real skeleton, carried onto the canvas by the camera
    const v = s.video
    const joints = poseAt(s.pose, vt)
    const toVideo: Affine | null = v ? (v.motion ? motionAt(v.motion, vt) : (v.affine ?? IDENTITY)) : null
    if (joints && toVideo) {
      const inv = invert(toVideo)
      drawSkeleton(ctx, joints.map((j) => ({ p: C(applyM(inv, j.p)), ok: j.c >= DRAW_MIN_CONFIDENCE })), holdingNow, px * 1.05)
    } else if (!s.pose && t >= 0) {
      // no pose track (the example): the figure solved from its contacts
      const k = tl.skeletonAt(tc)
      const J = (p: Vec2) => ({ p: C(p), ok: true })
      const none = { p: [0, 0] as Vec2, ok: false }
      const arr = [J(k.head), none, none, none, none, J(k.shoulders[0]), J(k.shoulders[1]), J(k.elbows[0]), J(k.elbows[1]), J(k.wrists[0]), J(k.wrists[1]), J(k.hips[0]), J(k.hips[1]), J(k.knees[0]), J(k.knees[1]), J(k.ankles[0]), J(k.ankles[1])]
      drawSkeleton(ctx, arr, holdingNow, px * 1.05)
    }
  }
  ctx.restore()
  rim(ctx, panel, 18 * u, u, 1)

  // the wall's title, lowercase and light like the app's headings
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.font = `300 ${(finale ? 34 : 26) * u}px ${FONT}`
  ctx.textAlign = 'left'
  const used = finale ? Math.max(0, Math.min(R.order.length, relit)) : lit.size
  ctx.fillText(`${used} hold${used === 1 ? '' : 's'} used`, panel.x + 22 * u, panel.y + (finale ? 50 : 42) * u)
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `600 ${(finale ? 16 : 14) * u}px ${FONT}`
  ctx.fillText(s.video?.motion ? 'the wall, rebuilt from the moving camera' : 'the wall, from the clip', panel.x + 22 * u, panel.y + (finale ? 76 : 64) * u)
}

/** The numbers, in two glass blocks. While it plays: "so far" (time on the
 *  wall, holds used, moves) and the sequence as glossy hold badges. In the
 *  finale: the Coach Score in its chrome ring with the status sticker and the
 *  coach's line, and the climb in four tiles. Returns whether the coach's line
 *  found room here. */
function drawStats(ctx: CanvasRenderingContext2D, R: Reel, box: Rect, u: number, t: number, f: number, route: string, portrait: boolean): boolean {
  const { s, tl, look } = R
  const finale = f >= 0
  const T = finale ? tl.climbEnd : Math.max(0, Math.min(t, tl.climbEnd))
  const wide = !portrait && box.w > box.h * 1.6 // a strip: the blocks side by side
  ctx.save()
  glass(ctx, box, 22 * u, u)
  const pad = 26 * u
  const inner: Rect = { x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: box.h - 2 * pad }
  const [A, B]: Rect[] = wide
    ? [{ ...inner, w: inner.w / 2 - pad / 2 }, { x: inner.x + inner.w / 2 + pad / 2, y: inner.y, w: inner.w / 2 - pad / 2, h: inner.h }]
    : [{ ...inner, h: inner.h * 0.5 - pad / 2 }, { x: inner.x, y: inner.y + inner.h * 0.5 + pad / 2, w: inner.w, h: inner.h * 0.5 - pad / 2 }]
  const z = wide ? Math.max(0.85, Math.min(1.3, box.h / (230 * u))) : Math.max(1, Math.min(1.6, box.w / (420 * u), box.h / (430 * u)))
  const uz = u * z
  const lit = finale ? R.order.slice(0, Math.max(0, Math.floor((f - R.finale.relight) / R.finale.step) + 1)).map((o) => o.id) : tl.litAt(T)
  const sum = finale ? clamp01((f - R.finale.summary) / 0.6) : 0
  let coached = false

  if (sum < 1) {
    ctx.globalAlpha = 1 - sum
    const hy = heading(ctx, 'so far', A, uz, look)
    tiles(ctx, { x: A.x, y: hy, w: A.w, h: A.y + A.h - hy }, [
      [`${T.toFixed(1)}s`, 'on the wall', T >= tl.climbEnd && s.toppedOut],
      [`${lit.length}/${s.holdsDetected}`, 'holds used', false],
      [String(s.moves.filter((m) => m.time <= T).length), 'moves', false],
    ], uz)
    const by = heading(ctx, 'sequence', B, uz, look)
    badges(ctx, { x: B.x, y: by, w: B.w, h: B.y + B.h - by }, lit, (id) => (finale ? (R.order.find((o) => o.id === id)?.color ?? route) : id === s.finalHoldId && s.toppedOut ? GOLD : route), uz)
    ctx.globalAlpha = 1
  }
  if (sum > 0) {
    ctx.globalAlpha = sum
    // A · the Coach Score
    const ay = heading(ctx, 'coach score', A, uz, look)
    const area: Rect = { x: A.x, y: ay, w: A.w, h: A.y + A.h - ay }
    if (area.h > 70 * uz && area.w > 260 * uz) {
      coached = true
      const rr = Math.min(area.h * 0.46, area.w * 0.2, 86 * uz)
      const counted = Math.round(R.score.total * (1 - (1 - clamp01((f - R.finale.summary - 0.3) / 1.1)) ** 3))
      scoreRing(ctx, area.x + rr, area.y + Math.min(area.h / 2, rr + 6 * uz), rr, counted, look)
      const tx = area.x + 2 * rr + 24 * uz, tw = area.x + area.w - tx
      ctx.textAlign = 'left'
      ctx.fillStyle = '#fff'
      const head = `${R.score.total} · ${R.score.label.toLowerCase()}`
      let hs = 34 * uz
      ctx.font = `300 ${hs}px ${FONT}`
      if (ctx.measureText(head).width > tw) { hs = Math.max(20 * uz, hs * (tw / ctx.measureText(head).width)); ctx.font = `300 ${hs}px ${FONT}` }
      ctx.fillText(ellipsis(ctx, head, tw), tx, area.y + 34 * uz)
      sticker(ctx, R.status.status, tx + 4 * uz, area.y + 50 * uz, uz)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.font = `600 ${19 * uz}px ${FONT}`
      const lines = wrap(ctx, R.line, tw)
      const room = Math.max(0, Math.floor((area.y + area.h - (area.y + 104 * uz)) / (25 * uz)) + 1)
      lines.slice(0, room).forEach((ln, i) => ctx.fillText(i === room - 1 && lines.length > room ? ellipsis(ctx, `${ln} …`, tw) : ln, tx, area.y + (104 + i * 25) * uz))
    }
    // B · the climb, in tiles
    const cy = heading(ctx, 'the climb', B, uz, look)
    const facts: [string, string, boolean][] = [
      [s.toppedOut && s.elapsed != null ? `${s.elapsed.toFixed(2)}s` : `${tl.climbEnd.toFixed(1)}s`, s.toppedOut ? 'to the top' : 'on the wall', s.toppedOut],
      [`${R.order.length}/${s.holdsDetected}`, 'holds used', false],
      [String(s.moves.length), 'moves', false],
    ]
    if (R.meters && R.meters.climbed > 0.2) facts.push([`≈${R.meters.climbed.toFixed(1)}m`, 'body rose', false])
    tiles(ctx, { x: B.x, y: cy, w: B.w, h: B.y + B.h - cy }, facts, uz, f - R.finale.summary - 0.5)
    ctx.globalAlpha = 1
  }
  ctx.restore()
  return coached
}

// ── small drawing helpers ───────────────────────────────────────────────────
function kicker(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, u: number) {
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = `600 ${15 * u}px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, x, y)
}

/** A section title as the app draws one: light lowercase over a glossy rule.
 *  Returns where the content under it starts. */
function heading(ctx: CanvasRenderingContext2D, text: string, b: Rect, u: number, look: Look) {
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.94)'
  ctx.font = `300 ${27 * u}px ${FONT}`
  ctx.fillText(text, b.x, b.y + 24 * u)
  const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0)
  g.addColorStop(0, look.b)
  g.addColorStop(0.4, look.a)
  g.addColorStop(1, 'rgba(255,255,255,0)')
  roundRect(ctx, b.x, b.y + 34 * u, b.w, 3.5 * u, 2 * u)
  ctx.fillStyle = g
  ctx.fill()
  return b.y + 52 * u
}

/** Glossy capsule: the primary's gradient, a darker edge, a white sheen on top. */
function capsule(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, u: number, look: Look, align: 'left' | 'right' = 'left') {
  ctx.font = `700 ${size}px ${FONT}`
  const w = ctx.measureText(text).width + size * 1.8, h = size * 2
  const x0 = align === 'right' ? x - w : x
  ctx.save()
  roundRect(ctx, x0, y, w, h, h / 2)
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, look.a)
  g.addColorStop(1, look.b)
  ctx.fillStyle = g
  ctx.fill()
  ctx.lineWidth = 1.5 * u
  ctx.strokeStyle = look.edge
  ctx.stroke()
  roundRect(ctx, x0 + 3 * u, y + 2 * u, w - 6 * u, h * 0.46, h / 2)
  const sheen = ctx.createLinearGradient(0, y, 0, y + h * 0.5)
  sheen.addColorStop(0, 'rgba(255,255,255,0.7)')
  sheen.addColorStop(1, 'rgba(255,255,255,0.12)')
  ctx.fillStyle = sheen
  ctx.fill()
  ctx.fillStyle = look.ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x0 + w / 2, y + h * 0.54)
  ctx.restore()
}

/** Aero glass: a faint fill, a sheen over the top that ends on a curve, a bright rim. */
function glass(ctx: CanvasRenderingContext2D, b: Rect, r: number, u: number, alpha = 1) {
  ctx.save()
  ctx.globalAlpha *= alpha
  roundRect(ctx, b.x, b.y, b.w, b.h, r)
  const fill = ctx.createLinearGradient(0, b.y, 0, b.y + b.h)
  fill.addColorStop(0, 'rgba(255,255,255,0.10)')
  fill.addColorStop(1, 'rgba(255,255,255,0.03)')
  ctx.fillStyle = fill
  ctx.fill()
  ctx.save()
  roundClip(ctx, b, r)
  const gh = Math.min(b.h * 0.4, 150 * u)
  ctx.beginPath()
  ctx.moveTo(b.x, b.y)
  ctx.lineTo(b.x + b.w, b.y)
  ctx.lineTo(b.x + b.w, b.y + gh * 0.7)
  ctx.quadraticCurveTo(b.x + b.w / 2, b.y + gh * 1.15, b.x, b.y + gh * 0.7)
  ctx.closePath()
  const gl = ctx.createLinearGradient(0, b.y, 0, b.y + gh)
  gl.addColorStop(0, 'rgba(255,255,255,0.13)')
  gl.addColorStop(1, 'rgba(255,255,255,0.02)')
  ctx.fillStyle = gl
  ctx.fill()
  ctx.restore()
  ctx.restore()
  rim(ctx, b, r, u, alpha)
}
function rim(ctx: CanvasRenderingContext2D, b: Rect, r: number, u: number, alpha: number) {
  ctx.save()
  ctx.globalAlpha *= alpha
  roundRect(ctx, b.x, b.y, b.w, b.h, r)
  const st = ctx.createLinearGradient(0, b.y, 0, b.y + b.h)
  st.addColorStop(0, 'rgba(255,255,255,0.45)')
  st.addColorStop(1, 'rgba(255,255,255,0.08)')
  ctx.lineWidth = 1.6 * u
  ctx.strokeStyle = st
  ctx.stroke()
  ctx.restore()
}
/** Brushed chrome around the clip, like the app's video bezel. */
function chromeFrame(ctx: CanvasRenderingContext2D, b: Rect, r: number, u: number, alpha: number) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha *= alpha
  const g = ctx.createLinearGradient(0, b.y - 6 * u, 0, b.y + b.h + 6 * u)
  g.addColorStop(0, '#f4f6f7')
  g.addColorStop(0.4, '#c3cacf')
  g.addColorStop(0.62, '#9aa4ab')
  g.addColorStop(1, '#5f6970')
  roundRect(ctx, b.x - 4 * u, b.y - 4 * u, b.w + 8 * u, b.h + 8 * u, r + 4 * u)
  ctx.lineWidth = 7 * u
  ctx.strokeStyle = g
  ctx.stroke()
  roundRect(ctx, b.x - 0.5 * u, b.y - 0.5 * u, b.w + u, b.h + u, r)
  ctx.lineWidth = 1.2 * u
  ctx.strokeStyle = 'rgba(0,0,0,0.7)'
  ctx.stroke()
  ctx.restore()
}
/** Small glass tiles in a row: a big number over a lowercase label. */
function tiles(ctx: CanvasRenderingContext2D, b: Rect, items: [string, string, boolean][], u: number, pop = Infinity) {
  const gap = 12 * u, n = items.length
  // Four tiles in a narrow column go two by two, when there is height for it.
  const twoRows = n === 4 && (b.w - gap * 3) / 4 < 130 * u && b.h >= 2 * 72 * u + gap
  const perRow = twoRows ? 2 : n
  const w = (b.w - gap * (perRow - 1)) / perRow
  const h = twoRows ? Math.min((b.h - gap) / 2, 130 * u) : Math.min(b.h, 150 * u)
  if (h < 40 * u) return
  // One size for every value, small enough that the longest fits its tile.
  let size = Math.min(44 * u, h * 0.4)
  ctx.font = `700 ${size}px ${FONT}`
  const widest = Math.max(...items.map(([v]) => ctx.measureText(v).width))
  if (widest > w - 24 * u) size *= (w - 24 * u) / widest
  const alpha0 = ctx.globalAlpha
  items.forEach(([v, label, gold], i) => {
    // `pop`: seconds since the tiles began to arrive, one after the other.
    const k = clamp01((pop - i * 0.14) / 0.35), rise = (1 - (1 - (1 - k) ** 3)) * 22 * u
    ctx.globalAlpha = alpha0 * k
    const x = b.x + (i % perRow) * (w + gap), y0 = b.y + Math.floor(i / perRow) * (h + gap) + rise
    roundRect(ctx, x, y0, w, h, 16 * u)
    const fill = ctx.createLinearGradient(0, y0, 0, y0 + h)
    fill.addColorStop(0, 'rgba(255,255,255,0.12)')
    fill.addColorStop(1, 'rgba(255,255,255,0.04)')
    ctx.fillStyle = fill
    ctx.fill()
    rim(ctx, { x, y: y0, w, h }, 16 * u, u, 0.8)
    ctx.textAlign = 'left'
    ctx.fillStyle = gold ? GOLD : '#fff'
    ctx.font = `700 ${size}px ${FONT}`
    ctx.fillText(v, x + 14 * u, y0 + h * 0.55)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = `600 ${Math.min(15 * u, h * 0.16)}px ${FONT}`
    ctx.fillText(ellipsis(ctx, label, w - 24 * u), x + 14 * u, y0 + h * 0.82)
  })
  ctx.globalAlpha = alpha0
}
/** The sequence as glossy gel badges, newest last and a little bigger. As many
 *  rows as fit; when they run out, the latest holds stay. */
function badges(ctx: CanvasRenderingContext2D, b: Rect, ids: number[], color: (id: number) => string, u: number) {
  if (!ids.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = `600 ${17 * u}px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('the first hold lights up here', b.x, b.y + 26 * u)
    return
  }
  const r = Math.max(12 * u, Math.min(24 * u, b.h / 2.6)), gap = 10 * u
  const per = Math.max(1, Math.floor((b.w + gap) / (2 * r + gap)))
  const rows = Math.max(1, Math.min(3, Math.floor((b.h + gap) / (2 * r + gap))))
  const shown = ids.slice(-per * rows)
  shown.forEach((id, i) => {
    const row = Math.floor(i / per), col = i % per
    const cx = b.x + r + col * (2 * r + gap), cy = b.y + r + row * (2 * r + gap)
    const last = i === shown.length - 1
    const rr = last ? r * 1.08 : r
    const c = color(id)
    const g = ctx.createRadialGradient(cx - rr * 0.35, cy - rr * 0.4, rr * 0.1, cx, cy, rr)
    g.addColorStop(0, hexA(c, 1))
    g.addColorStop(1, shade(c, 0.6))
    ctx.beginPath()
    ctx.arc(cx, cy, rr, 0, Math.PI * 2)
    ctx.fillStyle = g
    ctx.fill()
    ctx.lineWidth = (last ? 3 : 1.5) * u
    ctx.strokeStyle = last ? '#fff' : 'rgba(0,0,0,0.45)'
    ctx.stroke()
    ctx.beginPath()
    ctx.ellipse(cx, cy - rr * 0.45, rr * 0.62, rr * 0.36, 0, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.32)'
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `700 ${rr * 0.92}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = 3 * u
    ctx.fillText(String(id), cx, cy + rr * 0.06)
    ctx.restore()
    ctx.textBaseline = 'alphabetic'
  })
  ctx.textAlign = 'left'
}
/** The Coach Score in a chrome ring, as on the results screen. */
function scoreRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, value: number, look: Look) {
  ctx.save()
  const outer = ctx.createLinearGradient(0, cy - r, 0, cy + r)
  outer.addColorStop(0, '#f4f6f7')
  outer.addColorStop(0.45, '#c3cacf')
  outer.addColorStop(1, '#7d878e')
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = outer
  ctx.fill()
  const track = r * 0.86
  ctx.lineWidth = r * 0.12
  ctx.beginPath()
  ctx.arc(cx, cy, track, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cx, cy, track, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0, Math.min(100, value))) / 100)
  ctx.strokeStyle = look.theme === 'dusk' ? '#7b6cc4' : look.b
  ctx.lineCap = 'round'
  ctx.stroke()
  const disc = ctx.createRadialGradient(cx, cy - r * 0.35, r * 0.1, cx, cy, r * 0.72)
  disc.addColorStop(0, '#ffffff')
  disc.addColorStop(0.6, '#e9eef0')
  disc.addColorStop(1, '#cfd6da')
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2)
  ctx.fillStyle = disc
  ctx.fill()
  ctx.fillStyle = '#14280f'
  ctx.font = `700 ${r * 0.78}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(value), cx, cy + r * 0.05)
  ctx.restore()
}
/** The status sticker: tilted, with a white die-cut edge. */
function sticker(ctx: CanvasRenderingContext2D, status: StatusRead['status'], x: number, y: number, u: number) {
  const text = status === 'sent' ? 'SENT!' : status === 'unfinished' ? 'SO CLOSE' : 'NOT SURE'
  const [c1, c2, ink, tilt] = status === 'sent' ? ['#a6e86c', '#5cb82f', '#0f3608', -4] : status === 'unfinished' ? ['#ffc163', '#ff8a00', '#2b1400', 3] : ['#f4f6f7', '#b9c1c6', '#20262b', -2]
  ctx.save()
  ctx.font = `700 ${16 * u}px ${FONT}`
  const w = ctx.measureText(text).width + 28 * u, h = 32 * u
  ctx.translate(x + w / 2, y + h / 2)
  ctx.rotate(((tilt as number) * Math.PI) / 180)
  roundRect(ctx, -w / 2, -h / 2, w, h, 8 * u)
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2)
  g.addColorStop(0, c1 as string)
  g.addColorStop(1, c2 as string)
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowBlur = 8 * u
  ctx.shadowOffsetY = 3 * u
  ctx.fillStyle = g
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 3 * u
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  ctx.fillStyle = ink as string
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, h * 0.04)
  ctx.restore()
}
/** Decoration behind everything: a ring burst, a halftone corner, a few stars. */
function drawBackdropArt(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, look: Look, time = 0) {
  ctx.save()
  const m = Math.min(W, H)
  // aurora: three soft lights, drifting
  ctx.globalCompositeOperation = 'lighter'
  for (const [ax, ay, rad, sp, ph] of [[0.2, 0.22, 0.6, 0.05, 0], [0.86, 0.56, 0.55, 0.04, 2.1], [0.4, 0.92, 0.62, 0.03, 4.2]]) {
    const cx = W * (ax + 0.09 * Math.sin(time * sp * 2 * Math.PI + ph)), cy = H * (ay + 0.06 * Math.cos(time * sp * 1.7 * Math.PI + ph))
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, m * rad)
    g.addColorStop(0, hexA(look.art, 0.15))
    g.addColorStop(1, hexA(look.art, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }
  ctx.globalCompositeOperation = 'source-over'
  // speaker-cone rings from the corner, travelling outward
  ctx.fillStyle = look.art
  const gap = 0.09, n = 7, phase = (time * 0.02) % gap
  for (let i = 0; i < n; i++) {
    const r0 = i * gap + phase
    ctx.globalAlpha = 0.09 * Math.sin(Math.PI * Math.min(1, r0 / (n * gap)) ** 0.6)
    ctx.beginPath()
    ctx.arc(W * 0.02, H * 0.98, m * (r0 + 0.045), 0, Math.PI * 2)
    ctx.arc(W * 0.02, H * 0.98, m * r0, 0, Math.PI * 2, true)
    ctx.fill()
  }
  // halftone corner, with a slow wave through it
  const step = 22 * u
  for (let y = 0; y < m * 0.42; y += step) {
    for (let x = 0; x < m * 0.5; x += step) {
      const d = Math.hypot(x, y) / (m * 0.5)
      if (d > 1) continue
      const wave = 0.5 + 0.5 * Math.sin(time * 1.3 - d * 7)
      ctx.globalAlpha = 0.16 * (1 - d) * (0.55 + 0.45 * wave)
      ctx.beginPath()
      ctx.arc(W - x - step, y + step, 5 * u * (1 - d * 0.6) * (0.85 + 0.25 * wave), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  // glass bubbles, rising
  for (let i = 0; i < 11; i++) {
    const seed = (i * 0.618034) % 1, seed2 = (i * 0.381966 + 0.13) % 1
    const rr = (9 + 26 * seed2) * u, speed = 0.012 + 0.018 * seed
    const life = (time * speed + seed2 * 1.3) % 1.3
    const x = W * (0.04 + 0.92 * seed) + Math.sin(time * (0.5 + seed) + i) * 14 * u, y = H * (1.12 - life)
    const fade = Math.min(1, life / 0.15, (1.3 - life) / 0.2)
    ctx.globalAlpha = 0.5 * fade
    const g = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.4, rr * 0.05, x, y, rr)
    g.addColorStop(0, 'rgba(255,255,255,0.34)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.05)')
    g.addColorStop(1, hexA(look.art, 0.2))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, rr, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 1.4 * u
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.stroke()
  }
  // stars that twinkle and turn
  ctx.strokeStyle = look.art
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3 * u
  const stars: [number, number, number][] = [[0.94, 0.52, 18], [0.06, 0.18, 14], [0.52, 0.97, 12], [0.8, 0.88, 9], [0.3, 0.035, 8], [0.97, 0.3, 10], [0.045, 0.62, 9]]
  stars.forEach(([sx, sy, sr], i) => {
    const tw = 0.5 + 0.5 * Math.sin(time * (1.1 + 0.23 * i) + i * 1.9)
    ctx.globalAlpha = 0.12 + 0.26 * tw
    starPath(ctx, W * sx, H * sy, sr * u * (0.85 + 0.3 * tw), time * 0.15 * (i % 2 ? 1 : -1) + i)
    ctx.stroke()
  })
  ctx.restore()
}

/** A five-point star, as the current path. */
function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, R0: number, rot = 0) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = rot - Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? R0 * 0.42 : R0
    ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
  }
  ctx.closePath()
}

/** The send, celebrated: rings out from the middle, stars and dots thrown wide,
 *  and the SENT! sticker slapped on. `tau` is seconds since it began. */
function drawSendBurst(ctx: CanvasRenderingContext2D, box: Rect, tau: number, u: number, look: Look, route: string) {
  if (tau < 0) return
  const cx = box.x + box.w / 2, cy = box.y + box.h * 0.46
  ctx.save()
  roundClip(ctx, box, 18 * u)
  // a flash, then rings
  if (tau < 0.5) {
    ctx.globalAlpha = 0.55 * (1 - tau / 0.5)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, box.w * 0.7)
    g.addColorStop(0, '#fff')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(box.x, box.y, box.w, box.h)
  }
  for (let i = 0; i < 3; i++) {
    const k = (tau - i * 0.16) / 1.1
    if (k <= 0 || k >= 1) continue
    ctx.globalAlpha = 0.8 * (1 - k)
    ctx.lineWidth = (10 - 7 * k) * u
    ctx.strokeStyle = i === 1 ? '#fff' : look.a
    ctx.beginPath()
    ctx.arc(cx, cy, box.w * (0.08 + 0.62 * (1 - (1 - k) ** 3)), 0, Math.PI * 2)
    ctx.stroke()
  }
  // confetti: stars and dots, thrown out and falling
  const colors = [look.a, '#ffffff', GOLD, route, look.art]
  for (let i = 0; i < 46; i++) {
    const a = i * 2.39996, sp = (0.34 + 0.5 * ((i * 0.618034) % 1)) * box.w
    const k = Math.min(tau, 3)
    const x = cx + Math.cos(a) * sp * (1 - Math.exp(-2.4 * k)), y = cy + Math.sin(a) * sp * (1 - Math.exp(-2.4 * k)) * 0.8 + 170 * u * k * k * 0.5
    const fade = clamp01(1 - (tau - 1.5) / 1.1)
    if (fade <= 0) continue
    ctx.globalAlpha = fade
    ctx.fillStyle = colors[i % colors.length]
    const size = (7 + 9 * ((i * 0.381966) % 1)) * u
    if (i % 3) { starPath(ctx, x, y, size, tau * (2 + (i % 5)) + i); ctx.fill() }
    else { ctx.beginPath(); ctx.arc(x, y, size * 0.5, 0, Math.PI * 2); ctx.fill() }
  }
  ctx.restore()
  // the sticker: slapped on big, with a bounce, then resting
  const slap = clamp01(tau / 0.42)
  const bounce = slap < 1 ? 2.6 - 1.6 * (1 - (1 - slap) ** 3) + 0.0 : 1 + 0.07 * Math.exp(-5 * (tau - 0.42)) * Math.cos(16 * (tau - 0.42))
  // ...and once the burst has had its moment, it steps down out of the route's way.
  const rest = ease(clamp01((tau - 1.5) / 0.7))
  const su = u * lerp(4.2, 2.7, rest) * bounce, sy = lerp(cy, box.y + box.h - 74 * u, rest)
  ctx.save()
  ctx.globalAlpha = clamp01(tau / 0.12)
  ctx.font = `700 ${16 * su}px ${FONT}`
  const sw = ctx.measureText('SENT!').width + 28 * su
  sticker(ctx, 'sent', cx - sw / 2, sy - 16 * su, su)
  ctx.restore()
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const lines: string[] = ['']
  for (const w of text.split(/\s+/)) {
    const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w
    if (ctx.measureText(next).width <= max || !lines[lines.length - 1]) lines[lines.length - 1] = next
    else lines.push(w)
  }
  return lines
}
function shade(hex: string, k: number) {
  const n = hex.replace('#', '')
  const v = n.length === 3 ? n.split('').map((c) => c + c).join('') : n
  return `rgb(${Math.round(parseInt(v.slice(0, 2), 16) * k)},${Math.round(parseInt(v.slice(2, 4), 16) * k)},${Math.round(parseInt(v.slice(4, 6), 16) * k)})`
}
function poly(ctx: CanvasRenderingContext2D, pts: Vec2[]) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
}
function dot(ctx: CanvasRenderingContext2D, p: Vec2, r: number, fill: string, px: number) {
  ctx.beginPath()
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 2 * px
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.stroke()
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
function roundClip(ctx: CanvasRenderingContext2D, b: Rect, r: number) {
  roundRect(ctx, b.x, b.y, b.w, b.h, r)
  ctx.clip()
}
function ellipsis(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1)
  return s + '…'
}
function hexA(hex: string, a: number) {
  const n = hex.replace('#', '')
  const v = n.length === 3 ? n.split('').map((c) => c + c).join('') : n
  return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a})`
}
