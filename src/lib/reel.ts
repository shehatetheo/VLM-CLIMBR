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
import { holdFill } from './colors'
import { invertAffine } from './geometry'
import { applyM, invert, motionAt, IDENTITY, type Affine } from './motion'
import { LIMB_JOINT, overlayAt } from './overlay'
import { DRAW_MIN_CONFIDENCE, poseAt } from './skeleton'
import type { Timeline } from './timeline'
import { GOLD, LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type LimbKey, type Session, type Vec2 } from './types'

export type ReelFormat = 'landscape' | 'portrait'
export const REEL_SIZE: Record<ReelFormat, [number, number]> = { landscape: [1920, 1080], portrait: [1080, 1920] }

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Geist Variable', system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', 'Geist Mono Variable', Menlo, monospace"

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
  finale: { relight: number; step: number; summary: number; total: number }
  total: number
  wall: CanvasImageSource | null
  order: { id: number; time: number; color: string }[] // holds in the order they were first used
  torso: [number, number, number][] // [climb seconds, x, y] on the canvas
  meters: { climbed: number; travelled: number } | null
  score: CoachScore
  line: string // the one thing to fix first, in a sentence
}

export function prepareReel(s: Session, tl: Timeline, clip: number, wall: CanvasImageSource | null): Reel {
  const order = [...tl.firstUse.entries()].sort((a, b) => a[1].time - b[1].time).map(([id, f]) => ({ id, time: f.time, color: holdFill(s, id) }))
  const torso = (s.torso ?? []).filter((p) => p[0] >= 0 && p[0] <= tl.climbEnd)
  const step = order.length > 14 ? 0.22 : 0.32
  const finale = { relight: 0.9, step, summary: 0.9 + order.length * step + 0.4, total: 0.9 + order.length * step + 0.4 + 3.2 }
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
  return { s, tl, clip, finale, total: clip + finale.total, wall, order, torso, meters, score: coachScore(s), line }
}

interface Rect { x: number; y: number; w: number; h: number }
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const mix = (a: Rect, b: Rect, k: number): Rect => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) })
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
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
      const cw = Math.min((top.w - gap) / 2, top.h * clipAspect)
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
  ctx.fillStyle = '#050607'
  ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W * 0.7, H * 0.2, 0, W * 0.7, H * 0.2, Math.max(W, H) * 0.7)
  glow.addColorStop(0, hexA(route, 0.1))
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)

  drawHeader(ctx, R, L.header, u, t, inFinale, route)

  // ── the clip, with what the models saw drawn on it ──
  if (k < 1) {
    ctx.save()
    ctx.globalAlpha = 1 - k
    const box = fit(L.clip, frameAspect)
    if (L.portrait && frameAspect <= 1) box.y = L.clip.y
    roundClip(ctx, box, 18 * u)
    ctx.fillStyle = '#000'
    ctx.fillRect(box.x, box.y, box.w, box.h)
    if (frame) ctx.drawImage(frame, box.x, box.y, box.w, box.h)
    drawClipOverlay(ctx, R, box, t, u * (box.h / (L.portrait ? 900 : 880)), route)
    ctx.restore()
    panelBorder(ctx, box, 18 * u, 1 - k)
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
  // Where the numbers had no room for the coach's line, it captions the wall.
  if (inFinale && !coached) {
    const a = clamp01((f - R.finale.summary) / 0.6)
    if (a > 0) {
      ctx.save()
      ctx.globalAlpha = a
      const h = 96 * u, y = mapRect.y + mapRect.h - h
      roundClip(ctx, mapRect, 18 * u)
      const shade = ctx.createLinearGradient(0, y - 40 * u, 0, y + h)
      shade.addColorStop(0, 'rgba(5,6,7,0)')
      shade.addColorStop(0.45, 'rgba(5,6,7,0.86)')
      shade.addColorStop(1, 'rgba(5,6,7,0.94)')
      ctx.fillStyle = shade
      ctx.fillRect(mapRect.x, y - 40 * u, mapRect.w, h + 40 * u)
      kicker(ctx, `COACH SCORE · ${R.score.total} · ${R.score.label.toUpperCase()}`, mapRect.x + 22 * u, y + 30 * u, u)
      ctx.fillStyle = '#fff'
      ctx.font = `720 ${27 * u}px ${FONT}`
      ctx.fillText(ellipsis(ctx, R.line, mapRect.w - 44 * u), mapRect.x + 22 * u, y + 66 * u)
      ctx.restore()
    }
  }
  ctx.restore()
}

function drawHeader(ctx: CanvasRenderingContext2D, R: Reel, box: Rect, u: number, t: number, finale: boolean, route: string) {
  const { s, tl } = R
  // the mark: three holds and the line between them
  const m = box.h * 0.82, mx = box.x, my = box.y + (box.h - m) / 2
  roundRect(ctx, mx, my, m, m, m * 0.25)
  ctx.fillStyle = '#12151a'
  ctx.fill()
  for (const [cx, cy, c] of [[0.3, 0.72, '#E879F9'], [0.5, 0.5, '#22D3EE'], [0.72, 0.26, '#F5C542']] as const) {
    ctx.beginPath()
    ctx.ellipse(mx + cx * m, my + cy * m, m * 0.1, m * 0.085, -0.4, 0, Math.PI * 2)
    ctx.fillStyle = c
    ctx.fill()
  }
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  const tx = mx + m + 18 * u
  ctx.fillStyle = '#fff'
  ctx.font = `780 ${34 * u}px ${FONT}`
  ctx.fillText(ellipsis(ctx, s.title, box.w * 0.5), tx, box.y + box.h * 0.46)
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = `600 ${20 * u}px ${FONT}`
  ctx.fillText(ellipsis(ctx, `${s.climber} · ${s.route.color}${s.route.grade ? ` ${s.route.grade}` : ''} · SAM 3.1 + ViTPose+`, box.w * 0.55), tx, box.y + box.h * 0.86)

  const done = s.toppedOut && t >= tl.climbEnd
  const clock = Math.max(0, Math.min(t, tl.climbEnd))
  ctx.textAlign = 'right'
  ctx.fillStyle = done ? GOLD : '#fff'
  ctx.font = `760 ${58 * u}px ${FONT}`
  ctx.fillText(`${clock.toFixed(2)} s`, box.x + box.w, box.y + box.h * 0.6)
  ctx.fillStyle = done ? GOLD : hexA(route, 0.95)
  ctx.font = `750 ${17 * u}px ${FONT}`
  ctx.fillText(finale ? (s.toppedOut ? 'TOPPED OUT' : 'THE CLIMB') : t < 0 ? 'PULLING ON' : done ? 'TOPPED OUT' : t < tl.climbEnd ? 'ON THE WALL' : 'OFF THE WALL', box.x + box.w, box.y + box.h * 0.95)
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
  if (ov.joints) drawSkeleton(ctx, ov.joints.map((j) => ({ p: P(j.p), ok: j.c >= DRAW_MIN_CONFIDENCE })), ov.holding, px)
  for (const { key, p } of ov.fallbackLimbs) dot(ctx, P(p), 8 * px, LIMB_BY_KEY[key].color, px)
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
  const box = fit({ x: panel.x + 10 * u, y: panel.y + 10 * u, w: panel.w - 20 * u, h: panel.h - 20 * u }, aspect)
  const C = (p: Vec2): Vec2 => [box.x + p[0] * box.w, box.y + p[1] * box.h]
  const px = Math.max(0.6, box.h / 900) * u // strokes scale with the wall as it is drawn

  if (R.wall) {
    ctx.save()
    ctx.globalAlpha = 0.62
    const m = invertAffine(s.wall?.affine ?? IDENTITY)
    ctx.setTransform(ctx.getTransform().multiply(new DOMMatrix([box.w * m[0][0], box.h * m[1][0], box.w * m[0][1], box.h * m[1][1], box.x + box.w * m[0][2], box.y + box.h * m[1][2]])))
    ctx.drawImage(R.wall, 0, 0, 1, 1)
    ctx.restore()
  }

  const finale = f >= 0
  const lit = new Set(tl.litAt(t))
  const tc = Math.max(0, Math.min(t, tl.climbEnd))
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
  panelBorder(ctx, panel, 18 * u, 1)

  // caption, as the reference titles its wall
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.font = `750 ${(finale ? 26 : 19) * u}px ${FONT}`
  ctx.textAlign = 'left'
  const used = finale ? Math.max(0, Math.min(R.order.length, relit)) : lit.size
  ctx.fillText(`${used} hold${used === 1 ? '' : 's'} used`, panel.x + 20 * u, panel.y + (finale ? 44 : 36) * u)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = `600 ${(finale ? 16 : 13.5) * u}px ${FONT}`
  ctx.fillText(s.video?.motion ? 'wall rebuilt from the moving camera' : 'the wall, from the clip', panel.x + 20 * u, panel.y + (finale ? 68 : 56) * u)
}

/** Draws the numbers; returns whether the coach's line found room among them. */
function drawStats(ctx: CanvasRenderingContext2D, R: Reel, box: Rect, u: number, t: number, f: number, route: string, portrait: boolean): boolean {
  const { s, tl } = R
  const finale = f >= 0
  const T = finale ? tl.climbEnd : Math.max(0, Math.min(t, tl.climbEnd))
  const wide = !portrait && box.w > box.h * 1.6 // a strip: lay the blocks side by side
  let coached = false
  ctx.save()
  roundRect(ctx, box.x, box.y, box.w, box.h, 18 * u)
  ctx.fillStyle = 'rgba(255,255,255,0.035)'
  ctx.fill()
  panelBorder(ctx, box, 18 * u, 1)
  const pad = 22 * u
  const cols: Rect[] = wide
    ? [0, 1, 2].map((i) => ({ x: box.x + pad + (i * (box.w - pad)) / 3, y: box.y + pad, w: (box.w - pad) / 3 - pad, h: box.h - 2 * pad }))
    : (() => {
        const h = box.h - 2 * pad
        return [{ x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: h * 0.4 }, { x: box.x + pad, y: box.y + pad + h * 0.43, w: box.w - 2 * pad, h: h * 0.25 }, { x: box.x + pad, y: box.y + pad + h * 0.71, w: box.w - 2 * pad, h: h * 0.29 }]
      })()
  // Type grows with the room it has.
  const z = wide ? Math.max(0.85, Math.min(1.3, box.h / (230 * u))) : Math.max(1, Math.min(1.7, box.w / (400 * u), box.h / (430 * u)))

  // 1 · on a hold: one bar per limb, and the holds it has used
  let c = cols[0]
  kicker(ctx, 'ON A HOLD', c.x, c.y + 14 * u * z, u * z)
  const rowH = Math.min(46 * u * z, (c.h - 26 * u * z) / 4)
  LIMBS.forEach((l, i) => {
    const y = c.y + 26 * u * z + i * rowH + rowH * 0.62
    const cover = tl.coverageAt(l.key, T)
    ctx.fillStyle = l.color
    roundRect(ctx, c.x, y - 11 * u * z, 12 * u * z, 12 * u * z, 3 * u)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.86)'
    ctx.font = `620 ${17 * u * z}px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(l.name, c.x + 22 * u * z, y)
    const bx = c.x + 118 * u * z, bw = Math.max(40 * u, c.w * 0.3)
    roundRect(ctx, bx, y - 8 * u * z, bw, 6 * u * z, 3 * u * z)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.fill()
    if (cover > 0.005) {
      roundRect(ctx, bx, y - 8 * u * z, bw * cover, 6 * u * z, 3 * u * z)
      ctx.fillStyle = l.color
      ctx.fill()
    }
    ctx.fillStyle = '#fff'
    ctx.font = `650 ${15 * u * z}px ${MONO}`
    ctx.fillText(`${Math.round(cover * 100)}%`.padStart(4, ' '), bx + bw + 10 * u, y)
    const seq = tl.sequenceAt(l.key, T)
    ctx.fillStyle = l.color
    ctx.font = `700 ${15 * u * z}px ${MONO}`
    const sx = bx + bw + 64 * u * z
    ctx.fillText(tail(ctx, seq.join(' '), c.x + c.w - sx), sx, y)
  })

  // 2 · the sequence so far
  c = cols[1]
  const lit = finale ? R.order.slice(0, Math.max(0, Math.floor((f - R.finale.relight) / R.finale.step) + 1)).map((o) => o.id) : tl.litAt(T)
  kicker(ctx, c.w < 330 * u * z ? `SEQUENCE · ${lit.length}/${s.holdsDetected}` : `SEQUENCE · ${lit.length}/${s.holdsDetected} HOLDS · ${s.moves.filter((m) => m.time <= T).length} MOVES`, c.x, c.y + 14 * u * z, u * z)
  ctx.font = `800 ${34 * u * z}px ${FONT}`
  let shown = lit.slice()
  while (shown.length > 1 && ctx.measureText(shown.join(' › ')).width > c.w) shown = shown.slice(1)
  let x = c.x
  const sy = c.y + Math.min(c.h, 74 * u * z)
  shown.forEach((id, i) => {
    if (i) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillText('›', x, sy); x += ctx.measureText('› ').width }
    ctx.fillStyle = finale ? (R.order.find((o) => o.id === id)?.color ?? route) : id === s.finalHoldId && s.toppedOut ? GOLD : route
    ctx.fillText(String(id), x, sy)
    x += ctx.measureText(`${id} `).width
  })

  // 3 · contact lanes while it plays; the summary once it is over
  c = cols[2]
  const sum = finale ? clamp01((f - R.finale.summary) / 0.6) : 0
  if (sum > 0) {
    ctx.globalAlpha = sum
    kicker(ctx, 'THE CLIMB', c.x, c.y + 14 * u * z, u * z)
    const facts: [string, string][] = [
      [s.toppedOut && s.elapsed != null ? `${s.elapsed.toFixed(2)} s` : `${tl.climbEnd.toFixed(1)} s`, s.toppedOut ? 'to the top' : 'on the wall'],
      [`${R.order.length}/${s.holdsDetected}`, 'holds used'],
      [String(s.moves.length), 'moves'],
    ]
    if (R.meters && R.meters.climbed > 0.2) facts.push([`≈ ${R.meters.climbed.toFixed(1)} m`, 'body rose'])
    const fw = c.w / facts.length
    // One size for all four, small enough that the longest fits its slot.
    let size = 34 * u * z
    ctx.font = `760 ${size}px ${FONT}`
    const widest = Math.max(...facts.map(([v]) => ctx.measureText(v).width))
    if (widest > fw - 14 * u) size *= (fw - 14 * u) / widest
    facts.forEach(([v, k], i) => {
      ctx.fillStyle = i === 0 && s.toppedOut ? GOLD : '#fff'
      ctx.font = `760 ${size}px ${FONT}`
      ctx.fillText(v, c.x + i * fw, c.y + 60 * u * z)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.font = `600 ${14 * u * z}px ${FONT}`
      ctx.fillText(ellipsis(ctx, k, fw - 8 * u), c.x + i * fw, c.y + 82 * u * z)
    })
    // What the coach made of it, where there is room under the numbers.
    if (c.h > 190 * u * z) {
      coached = true
      const top = c.y + 124 * u * z
      kicker(ctx, `COACH SCORE · ${R.score.total} · ${R.score.label.toUpperCase()}`, c.x, top, u * z)
      ctx.fillStyle = '#fff'
      ctx.font = `700 ${22 * u * z}px ${FONT}`
      const words = R.line.split(/\s+/)
      const lines: string[] = ['']
      for (const w of words) {
        const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w
        if (ctx.measureText(next).width <= c.w || !lines[lines.length - 1]) lines[lines.length - 1] = next
        else lines.push(w)
      }
      const room = Math.max(1, Math.floor((c.y + c.h - top - 20 * u * z) / (28 * u * z)))
      lines.slice(0, room).forEach((ln, i, all) => ctx.fillText(i === all.length - 1 && lines.length > room ? ellipsis(ctx, `${ln} …`, c.w) : ellipsis(ctx, ln, c.w), c.x, top + (30 + i * 28) * u * z))
    }
    ctx.globalAlpha = 1
  } else {
    kicker(ctx, 'CONTACT', c.x, c.y + 14 * u * z, u * z)
    const span = Math.max(0.01, tl.climbEnd)
    const lx = c.x + 34 * u * z, lw = c.w - 34 * u * z
    const laneH = Math.min(16 * u * z, (c.h - 30 * u * z) / 4 - 4 * u)
    LIMBS.forEach((l, i) => {
      const y = c.y + 28 * u * z + i * (laneH + 5 * u)
      ctx.fillStyle = l.color
      ctx.font = `800 ${11 * u * z}px ${MONO}`
      ctx.fillText(l.label, c.x, y + laneH * 0.8)
      roundRect(ctx, lx, y, lw, laneH, 4 * u)
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fill()
      for (const iv of tl.intervals[l.key]) {
        const a = clamp01(iv.start / span), b = clamp01(iv.end / span)
        roundRect(ctx, lx + a * lw, y, Math.max(3 * u, (b - a) * lw), laneH, 4 * u)
        ctx.fillStyle = hexA(l.color, iv.start <= T ? 0.95 : 0.25)
        ctx.fill()
      }
    })
    const hx = lx + clamp01(T / span) * lw
    ctx.fillStyle = '#fff'
    ctx.fillRect(hx - u, c.y + 24 * u * z, 2 * u, 4 * (laneH + 5 * u) + 2 * u)
  }
  ctx.restore()
  return coached
}

// ── small drawing helpers ───────────────────────────────────────────────────
function kicker(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, u: number) {
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = `750 ${12.5 * u}px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  try { (ctx as any).letterSpacing = `${1.2 * u}px` } catch { /* older canvases */ }
  ctx.fillText(text, x, y)
  try { (ctx as any).letterSpacing = '0px' } catch { /* older canvases */ }
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
function panelBorder(ctx: CanvasRenderingContext2D, b: Rect, r: number, alpha: number) {
  roundRect(ctx, b.x, b.y, b.w, b.h, r)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = `rgba(255,255,255,${0.12 * alpha})`
  ctx.stroke()
}
function ellipsis(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1)
  return s + '…'
}
/** The end of a list that fits: the latest holds matter most. */
function tail(ctx: CanvasRenderingContext2D, text: string, max: number) {
  let s = text
  while (s.length > 1 && ctx.measureText(s).width > max) s = s.slice(s.indexOf(' ') + 1 || 1)
  return s
}
function hexA(hex: string, a: number) {
  const n = hex.replace('#', '')
  const v = n.length === 3 ? n.split('').map((c) => c + c).join('') : n
  return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a})`
}
