// Reading the route from SAM 3.1 + ViTPose+, in the browser.
//
// A port of the core of vision-demos/rock_climbing/src/climb.py: SAM 3.1's hold
// tracks become one outline per hold, ViTPose+ gives the climber's four points
// of contact, and contact is decided per limb with a dwell (a hand passing over
// a hold has not used it) and hysteresis (entering a hold is a tight margin,
// letting go a loose one). Margins are in hold heights and body heights, as the
// pipeline quotes them, so framing does not matter.
//
// The pipeline assumes a tripod. A phone in someone's hand follows the climber
// up the wall, so here the camera's motion is read from the hold tracks first
// (motion.ts) and contact is judged in the picture itself, against each hold's
// outline as SAM saw it at that moment. All times are real seconds of the clip.

import { bboxOf, centroid, gaussianSmooth, median, polygonArea, signedDistance } from './geometry'
import { applyM, compose, holdOutlineAt, invert, motionAt, registerCamera, simplify, type Affine, type HoldSighting, type MotionTrack, type Sighting } from './motion'
import { LIMBS, type LimbKey, type PipelineClimb, type PipelineHold, type PipelineMove, type Vec2 } from './types'
import type { PoseResult, SamResult } from './vlm'

export const CFG = {
  HOLD_MIN_SCORE: 0.4,
  HOLD_MIN_APPEARANCE: 0.3,
  HOLD_MIN_SIGHTINGS: 3,
  HOLD_DWELL_SECONDS: 0.5,
  FINAL_HOLD_TOUCH_SECONDS: 0.25,
  FINAL_HOLD_DWELL_SECONDS: 0.5,
  HOLD_MASK_MARGIN: 0.58,
  HOLD_RELEASE_MARGIN: 0.96,
  HOLD_GRAZE_DEPTH: 0.38,
  HOLD_GRAZE_DWELL_SECONDS: 1.5,
  ANKLE_TO_TOE_OFFSET: 0.045,
  START_DWELL_SECONDS: 0.4,
  POSE_SMOOTH_SECONDS: 2 / 30, // the pipeline's POSE_SMOOTH_SIGMA: 2 frames at 30 fps
  // As the pipeline's POSE_MIN_KPT_SCORE: 0 keeps every placed joint and only
  // the (0, 0) sentinel marks one invisible, which is what the dwell and margin
  // numbers were tuned against.
  KEYPOINT_MIN_CONFIDENCE: 0,
  BOX_MIN_CONFIDENCE: 0.3, // joints that outline a person when the box is missing
  POSE_GAP_SECONDS: 0.35, // longer than this without the climber: every limb lets go
  TRACK_JOIN_GAP: 3, // seconds: a climber lost this long and picked up nearby under a new id is still them
  HANDS_FIRST_SECONDS: 3, // hands on 2+ route holds this long before both feet are: the climb started with the hands
  NUMBER_BAND: 0.025, // frame heights: holds this close in height are one row
  START_DWELL_DECAY: 1, // frames the start counter loses per frame off: leaky, not a reset
  FINAL_DWELL_DECAY: 0,
  // A hand-held camera, as the pipeline's camera path reads it:
  HOLD_REJECT_RADIUS: 2.5, // a sighting this many of its hold's sizes from the rest is a track switching holds
  HOLD_BLOWUP: 5, // a sighting whose box is this many times the hold's usual box is a mask gone wrong
  REGRIP_GAP_SECONDS: 1.2, // a limb back on the same hold within this is one grip; later, it is a new one
  LIFT_OFF: 0.25, // feet are off the floor once both ankles rose this much, in leg lengths
  MATCH_REACH: 0.12, // palms this close (in body heights) are hands together
  HAND_REACH: 0.3, // the palm sits this far past the wrist, in forearm lengths
  HOLD_MERGE_IOU: 0.6, // two tracks this much on top of each other on the canvas are one hold…
  HOLD_MERGE_DISTANCE: 1, // …or never in view together, alike in size, and centres within one hold size
  HOLD_SPATIAL_MARGIN: 0.08, // frame heights around where the climber's body went; green further out is another route
}

const KPT = { lShoulder: 5, rShoulder: 6, lElbow: 7, rElbow: 8, lWrist: 9, rWrist: 10, lHip: 11, rHip: 12, lAnkle: 15, rAnkle: 16 }
const LIMB_KPT: Record<LimbKey, number> = { left_hand: KPT.lWrist, right_hand: KPT.rWrist, left_foot: KPT.lAnkle, right_foot: KPT.rAnkle }
const TORSO = [KPT.lShoulder, KPT.rShoulder, KPT.lHip, KPT.rHip]

export interface ReadInput {
  sam: SamResult
  pose: PoseResult
  /** The analyzed frame: its size (for the aspect) and the clip's length. */
  frame: { width: number; height: number; duration: number }
  color: string
  /** Every hold on the wall, whatever its color (a second SAM 3.1 pass): more
   *  fixed points to steady a moving camera against. Never counted as route holds. */
  anchors?: SamResult
}

export interface ReadStats {
  samSamples: number
  samTracks: number
  samDetections: number
  holdTracks: number
  holds: number
  movingTracks: number
  people: number
  poseFrames: number
  climberFrames: number
  climberSpan: [number, number] | null
  poseFps: number
  camera: 'still' | 'handheld'
  registeredSamples: number
  registeredFraction: number
  misfit: number | null // median, in hold heights
  framesRead: number // climber frames with the holds placed
  contacts: number
  moves: number
  start: 'both feet on holds' | 'first contact' | 'feet off the floor' | 'none'
  toppedOut: boolean
}

export interface Reading {
  outcome: 'ok' | 'no-holds' | 'no-climber'
  holds: PipelineHold[] // canvas 0–1, numbered bottom to top
  climb: PipelineClimb // moves timed from the start of the climb
  canvas: { width: number; height: number }
  torso: [number, number, number][] // [s from start, x, y], canvas 0–1
  start: number // video seconds at which the climb clock reads 0
  end: number | null // video seconds of the top-out
  motion?: MotionTrack // canvas → video per sampled frame; absent: the camera never moved
  sightings?: Record<number, HoldSighting[]> // per hold, video 0–1 (moving camera only)
  pose: { t: number[]; k: number[][] } // the climber, video 0–1: per frame 17 × [x, y, confidence]
  stats: ReadStats
  warnings: string[]
}

interface Track {
  id: number
  sightings: { sample: number; t: number; poly: Vec2[]; area: number; box: number; h: number; score: number; whole: boolean }[]
  score: number
  appearance: number
  iso?: Vec2[] // outline on the canvas, isotropic units
}

export function readRoute({ sam, pose, frame, color, anchors }: ReadInput): Reading {
  const warnings: string[] = []
  const aspect = frame.width / frame.height
  if (!(aspect > 0 && Number.isFinite(aspect))) throw new Error(`The analyzed frame has no size (${frame.width}×${frame.height}).`)
  const samples = [...sam.samples].sort((a, b) => a.t - b.t)
  const sampleOf = new Map(samples.map((s, i) => [s.frame, i]))
  const sampleTimes = samples.map((s) => s.t)

  // ── hold tracks ────────────────────────────────────────────────────────────
  const byTrack = new Map<number, Track>()
  let blownUp = 0
  for (const d of sam.detections) {
    if (d.score != null && d.score < CFG.HOLD_MIN_SCORE) continue
    const sample = sampleOf.get(d.frame)
    if (sample == null) continue
    const [x, y, w, h] = d.bbox
    const poly: Vec2[] = d.polygon ?? [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    const tr = byTrack.get(d.track) ?? { id: d.track, sightings: [], score: 0, appearance: 0 }
    tr.sightings.push({ sample, t: d.t, poly, area: polygonArea(poly), box: w * h, h, score: d.score ?? 1, whole: true })
    byTrack.set(d.track, tr)
  }
  let tracks = [...byTrack.values()].filter((tr) => {
    tr.appearance = new Set(tr.sightings.map((s) => s.sample)).size / Math.max(1, samples.length)
    tr.score = tr.sightings.reduce((s, x) => s + x.score, 0) / tr.sightings.length
    return tr.sightings.length >= CFG.HOLD_MIN_SIGHTINGS || tr.appearance >= CFG.HOLD_MIN_APPEARANCE
  })
  for (const tr of tracks) {
    // Now and then SAM's mask for a hold floods across the wall for one sample.
    // A hold cannot grow several times over between samples: drop those.
    const box = median(tr.sightings.map((s) => s.box))
    const kept = tr.sightings.filter((s) => s.box <= CFG.HOLD_BLOWUP * box)
    if (kept.length >= 2 && kept.length < tr.sightings.length) { blownUp += tr.sightings.length - kept.length; tr.sightings = kept }
    // Seen whole: not shrunk by a hand or a foot over it.
    const mid = median(tr.sightings.map((s) => s.area))
    for (const s of tr.sightings) s.whole = s.area >= 0.6 * mid
    tr.sightings.sort((a, b) => a.t - b.t)
  }
  const baseStats = {
    samSamples: samples.length, samTracks: sam.tracks, samDetections: sam.detections.length,
    holdTracks: tracks.length, people: pose.people, poseFrames: pose.frames.length,
  }
  if (!tracks.length) return empty('no-holds', baseStats, warnings, frame)
  const holdUnitV = median(tracks.map((tr) => median(tr.sightings.map((s) => s.h)))) // video heights

  // ── the camera ─────────────────────────────────────────────────────────────
  // Small holds place the camera best: a volume's centre wanders with whatever
  // part of it is in view, and a hold under a hand has a shrunken mask.
  // The other holds on the wall, as fixed points only.
  const anchorSightings: Sighting[] = []
  if (anchors) {
    const groups = new Map<number, { sample: number; c: Vec2; area: number; h: number; score: number }[]>()
    for (const d of anchors.detections) {
      const sample = sampleOf.get(d.frame)
      if (sample == null || (d.score != null && d.score < CFG.HOLD_MIN_SCORE)) continue
      const [x, y, w, h] = d.bbox
      const poly: Vec2[] = d.polygon ?? [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      // A hold cut by the frame's edge has its centre in the wrong place.
      if (x < 0.01 || y < 0.01 || x + w > 0.99 || y + h > 0.99) continue
      groups.set(d.track, [...(groups.get(d.track) ?? []), { sample, c: centroid(poly), area: w * h, h, score: d.score ?? 1 }])
    }
    for (const [track, list] of groups) {
      const mid = median(list.map((s) => s.area))
      for (const s of list) {
        if (s.area > CFG.HOLD_BLOWUP * mid || s.area < 0.6 * mid) continue // flooded, or half hidden
        const size = Math.max(s.h, holdUnitV) / holdUnitV
        anchorSightings.push({ track: 1_000_000 + track, sample: s.sample, c: s.c, w: s.score / (size * size), size: s.h })
      }
    }
  }
  /** What each route sighting was labelled, from the last registration. */
  let labelOf = new Map<Track['sightings'][number], number>()
  const register = (list: Track[]) => {
    const sightings: Sighting[] = []
    const owner: Track['sightings'][number][] = []
    for (const tr of list) {
      const mid = median(tr.sightings.map((s) => s.area))
      for (const s of tr.sightings) {
        const size = Math.max(s.h, holdUnitV) / holdUnitV
        const cover = s.whole ? 1 : (s.area / mid) ** 2
        sightings.push({ track: tr.id, sample: s.sample, c: centroid(s.poly), w: (s.score * cover) / (size * size), size: s.h })
        owner.push(s)
      }
    }
    const r = registerCamera([...sightings, ...anchorSightings], sampleTimes, aspect, holdUnitV)
    labelOf = new Map(owner.map((s, k) => [s, r.labels[k]]))
    return r
  }
  let reg = register(tracks)
  let split = 0
  const dropMoving = () => {
    if (!reg.moving.length) return
    warnings.push(`${reg.moving.length} ${color} track${reg.moving.length > 1 ? 's' : ''} moved against the wall and ${reg.moving.length > 1 ? 'were' : 'was'} not counted as ${reg.moving.length > 1 ? 'holds' : 'a hold'}.`)
    tracks = tracks.filter((tr) => !reg.moving.includes(tr.id))
  }
  dropMoving()
  // SAM hands a track on to another hold once the first leaves the picture: on
  // a camera that follows the climber, one track can be three holds in turn.
  // Each spot it settled on is its own hold.
  if (reg.mode === 'handheld') {
    let nextId = Math.max(0, ...tracks.map((tr) => tr.id)) + 1
    const out: Track[] = []
    for (const tr of tracks) {
      const groups = new Map<number, Track['sightings']>()
      for (const s of tr.sightings) {
        const l = labelOf.get(s) ?? -1
        if (l >= 0) groups.set(l, [...(groups.get(l) ?? []), s])
      }
      const parts = [...groups.values()].filter((g) => g.length >= CFG.HOLD_MIN_SIGHTINGS).sort((a, b) => b.length - a.length)
      if (parts.length <= 1) { if (parts.length) tr.sightings = parts[0]; out.push(tr); continue }
      parts.forEach((g, i) => {
        const part: Track = { ...tr, id: i ? nextId++ : tr.id, sightings: g }
        const mid = median(g.map((s) => s.area))
        for (const s of g) s.whole = s.area >= 0.6 * mid
        part.appearance = new Set(g.map((s) => s.sample)).size / Math.max(1, samples.length)
        part.score = g.reduce((t, s) => t + s.score, 0) / g.length
        out.push(part)
      })
      split += parts.length - 1
    }
    if (split) { tracks = out; reg = register(tracks) }
  }
  // A hold is bolted down, so all its sightings land on one spot of the canvas.
  // One that lands far from the rest is SAM handing the track to another hold.
  let switched = 0
  for (const tr of tracks) {
    const placed = tr.sightings.map((s) => {
      const m = reg.toCanvas[s.sample]
      if (!m) return null
      const zoom = Math.sqrt(Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]) / aspect)
      const [, , w, h] = bboxOf(s.poly)
      return { c: applyM(m, centroid(s.poly)), size: Math.max(w * aspect, h) * zoom }
    })
    const ok = placed.filter(Boolean) as { c: Vec2; size: number }[]
    if (ok.length < 3) continue
    const mid: Vec2 = [median(ok.map((p) => p.c[0])), median(ok.map((p) => p.c[1]))]
    const radius = CFG.HOLD_REJECT_RADIUS * median(ok.map((p) => p.size))
    const keep = tr.sightings.filter((_, i) => !placed[i] || Math.hypot(placed[i]!.c[0] - mid[0], placed[i]!.c[1] - mid[1]) <= radius)
    switched += tr.sightings.length - keep.length
    tr.sightings = keep
  }
  if (switched) {
    tracks = tracks.filter((tr) => tr.sightings.length >= CFG.HOLD_MIN_SIGHTINGS)
    reg = register(tracks)
    dropMoving()
  }
  const still = reg.mode === 'still'
  const registered = reg.toCanvas.filter(Boolean).length
  if (!registered) throw new Error('The camera moved too much to place the holds: no sampled frame shares enough holds with the others.')
  if (!still && registered / samples.length < 0.5) warnings.push(`The camera could be placed in only ${Math.round((registered / samples.length) * 100)}% of the sampled frames; contacts are read only there.`)

  // Each hold's outline on the canvas: the whole sighting of median area (the
  // largest is usually two holds bridged; the smallest, one half-covered).
  for (const tr of tracks) {
    const placed = tr.sightings.filter((s) => reg.toCanvas[s.sample])
    const pool = !still && placed.some((s) => s.whole) ? placed.filter((s) => s.whole) : placed
    if (!pool.length) continue
    const pick = [...pool].sort((a, b) => a.area - b.area)[pool.length >> 1]
    tr.iso = pick.poly.map((p) => applyM(reg.toCanvas[pick.sample]!, p))
  }
  const unplaced = tracks.filter((tr) => !tr.iso).length
  if (unplaced) warnings.push(`${unplaced} hold track${unplaced > 1 ? 's were' : ' was'} only seen while the camera could not be placed.`)
  tracks = tracks.filter((tr) => tr.iso)

  // Two tracks on one hold (SAM re-acquiring it after an occlusion, or after the
  // camera left and came back): keep the steadier one's outline, both sightings.
  tracks.sort((a, b) => b.appearance - a.appearance || b.score - a.score)
  const kept: Track[] = []
  let merged = 0
  for (const tr of tracks) {
    const bc = bboxOf(tr.iso!)
    const twin = kept.find((k) => {
      const bk = bboxOf(k.iso!)
      if (still) return iou(bk, bc) > 0.45
      // Seen side by side in one frame, they are two holds.
      const mine = new Set(tr.sightings.map((s) => s.sample))
      if (k.sightings.some((s) => mine.has(s.sample))) return false
      if (iou(bk, bc) >= CFG.HOLD_MERGE_IOU) return true
      // The canvas is placed from SAM's own tracks, good to a fraction of a hold
      // nearby but not to a pixel across twenty seconds: a hold re-acquired late
      // lands beside its first sighting rather than on it.
      const sk = Math.max(bk[2], bk[3]), sc = Math.max(bc[2], bc[3])
      const d = Math.hypot(bk[0] + bk[2] / 2 - (bc[0] + bc[2] / 2), bk[1] + bk[3] / 2 - (bc[1] + bc[3] / 2))
      return Math.max(sk, sc) / Math.min(sk, sc) <= 2 && d <= CFG.HOLD_MERGE_DISTANCE * Math.max(sk, sc)
    })
    if (!twin) { kept.push(tr); continue }
    if (!still) {
      twin.sightings.push(...tr.sightings)
      twin.sightings.sort((a, b) => a.t - b.t)
    }
    merged++
  }
  tracks = kept
  if (!tracks.length) return empty('no-holds', baseStats, warnings, frame)

  // canvas-iso → video, per registered sample, for carrying outlines around.
  const isoMotion: MotionTrack | undefined = still ? undefined : {
    t: sampleTimes.filter((_, i) => reg.toCanvas[i]),
    m: reg.toCanvas.filter(Boolean).map((m) => invert(m!)),
  }
  const isoStill: Affine = [[aspect, 0, 0], [0, 1, 0]]
  const toIsoAt = (t: number): Affine | null => {
    if (still) return isoStill
    const m = motionAt(isoMotion, t)
    return m ? invert(m) : null
  }
  // How many video heights one canvas unit is at time t (the camera zooms).
  const zoomAt = (t: number): number | null => {
    const m = toIsoAt(t)
    return m ? 1 / Math.sqrt(Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]) / aspect) : null
  }
  const byId = new Map(tracks.map((tr) => [tr.id, tr]))
  const videoPoly = new Map(tracks.map((tr) => [tr.id, tr.iso!.map((p) => [p[0] / aspect, p[1]] as Vec2)]))
  const hSightings = new Map(tracks.map((tr) => [tr.id, tr.sightings.map((s) => ({ t: s.t, poly: s.poly, whole: s.whole }))]))
  const outlineAt = (id: number, t: number): Vec2[] | null => (still ? videoPoly.get(id)! : holdOutlineAt(byId.get(id)!.iso!, hSightings.get(id), isoMotion, t))

  // ── the climber ────────────────────────────────────────────────────────────
  const people = new Map<number, PoseResult['frames']>()
  for (const f of pose.frames) {
    const list = people.get(f.track) ?? []
    list.push(f)
    people.set(f.track, list)
  }
  if (!people.size) return empty('no-climber', { ...baseStats, holdTracks: tracks.length }, warnings, frame)
  // The climber is the person on the holds — not the biggest, not the most central.
  const holdsBoxAt = (t: number) => {
    const pts: Vec2[] = []
    for (const tr of tracks) {
      const o = outlineAt(tr.id, t)
      if (o && o.some(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)) pts.push(...o)
    }
    return pts.length ? bboxOf(pts) : null
  }
  const evidence = new Map<number, number>()
  for (const [track, list] of people) {
    let s = 0
    for (const f of list) {
      const box = f.bbox ?? kptBox(f.keypoints)
      const wall = holdsBoxAt(f.timestamp)
      if (box && wall) s += overlapFrac(box, wall)
    }
    evidence.set(track, (s / list.length) * 10 + list.length / pose.frames.length)
  }
  const order = [...people.keys()].sort((a, b) => evidence.get(b)! - evidence.get(a)!)
  const chain = [order[0]]
  // A person tracker can lose the climber and pick them up under a new id: join
  // a track on the wall that starts within a few seconds of where theirs
  // stopped, near where they were (further allowed the longer the gap).
  for (let grew = true; grew;) {
    grew = false
    const all = chain.flatMap((id) => people.get(id)!)
    const first = all.reduce((a, b) => (b.timestamp < a.timestamp ? b : a))
    const last = all.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
    for (const id of order) {
      if (chain.includes(id)) continue
      const list = people.get(id)!
      const head = list[0], tail = list[list.length - 1]
      const after = head.timestamp > last.timestamp && head.timestamp - last.timestamp <= CFG.TRACK_JOIN_GAP
      const before = tail.timestamp < first.timestamp && first.timestamp - tail.timestamp <= CFG.TRACK_JOIN_GAP
      if (!after && !before) continue
      const ba = after ? boxOf(last) : boxOf(tail), bb = after ? boxOf(head) : boxOf(first)
      if (!ba || !bb || evidence.get(id)! < 1) continue
      const gap = after ? head.timestamp - last.timestamp : first.timestamp - tail.timestamp
      if (Math.hypot(ba[0] + ba[2] / 2 - (bb[0] + bb[2] / 2), ba[1] + ba[3] / 2 - (bb[1] + bb[3] / 2)) > Math.min(0.5, 0.3 + 0.08 * gap)) continue
      chain.push(id)
      grew = true
      break
    }
  }
  const climber = chain.flatMap((id) => people.get(id)!).sort((a, b) => a.timestamp - b.timestamp)
  const dts = climber.slice(1).map((f, i) => f.timestamp - climber[i].timestamp).filter((d) => d > 1e-6)
  const fps = dts.length ? Math.round(1 / median(dts)) : 10
  // Joint by joint, smoothed across unbroken runs only.
  const T = climber.map((f) => f.timestamp)
  const K = climber.map((f) => f.keypoints.map((k) => [k.x, k.y, k.confidence]))
  const ok = (i: number, j: number) => K[i][j][2] >= CFG.KEYPOINT_MIN_CONFIDENCE && !(K[i][j][0] === 0 && K[i][j][1] === 0)
  const sigma = CFG.POSE_SMOOTH_SECONDS * fps
  for (let j = 0; j < 17; j++) {
    let run: number[] = []
    const flush = () => {
      const present = run.filter((i) => ok(i, j))
      if (present.length >= 3) {
        const xs = gaussianSmooth(present.map((i) => K[i][j][0]), sigma)
        const ys = gaussianSmooth(present.map((i) => K[i][j][1]), sigma)
        present.forEach((i, n) => { K[i][j][0] = xs[n]; K[i][j][1] = ys[n] })
      }
      run = []
    }
    for (let i = 0; i < T.length; i++) {
      if (i && T[i] - T[i - 1] > 1.5 / fps) flush()
      run.push(i)
    }
    flush()
  }
  const bodyH = gaussianSmooth(climber.map((f) => (boxOf(f) ?? [0, 0, 0, 0])[3]), Math.max(1, fps))

  // A colour is not a route: the same green turns up round the corner and above
  // the finish. This route's holds are the ones the climber's body went near.
  const body: Vec2[] = []
  for (let i = 0; i < climber.length; i++) {
    const toIso = toIsoAt(T[i])
    if (toIso) for (let j = 0; j < 17; j++) if (ok(i, j)) body.push(applyM(toIso, [K[i][j][0], K[i][j][1]]))
  }
  const hull = convexHull(body)
  if (hull.length >= 3) {
    const near = tracks.filter((tr) => {
      const [x, y, w, h] = bboxOf(tr.iso!)
      return signedDistance(hull, x + w / 2, y + h / 2) >= -CFG.HOLD_SPATIAL_MARGIN
    })
    const off = tracks.length - near.length
    // Dropping everything means the filter, not the route, is wrong.
    if (off && near.length) {
      warnings.push(`${off} ${color} hold${off > 1 ? 's' : ''} away from where the climber went ${off > 1 ? 'were' : 'was'} left out as another route.`)
      tracks = near
    }
  }
  const holdUnit = median(tracks.map((tr) => bboxOf(tr.iso!)[3])) // canvas units (one = a reference frame height)

  // ── contact, frame by frame, in the picture ────────────────────────────────
  const dwell = Math.max(1, Math.round(CFG.HOLD_DWELL_SECONDS * fps))
  const finalTouch = Math.max(1, Math.round(CFG.FINAL_HOLD_TOUCH_SECONDS * fps))
  const finalFrames = Math.max(1, Math.round(CFG.FINAL_HOLD_DWELL_SECONDS * fps))
  const grazeFrames = Math.max(1, Math.round(CFG.HOLD_GRAZE_DWELL_SECONDS * fps))
  const startFrames = Math.max(1, Math.round(CFG.START_DWELL_SECONDS * fps))
  const centreY = (tr: Track) => { const b = bboxOf(tr.iso!); return b[1] + b[3] / 2 }
  const finalHold = tracks.reduce((a, b) => (centreY(a) < centreY(b) ? a : b)).id

  type Contact = { limb: LimbKey; holdId: number; start: number; end: number }
  const contacts: Contact[] = []
  const activatedAt = new Map<number, number>()
  const st = Object.fromEntries(LIMBS.map((l) => [l.key, { on: null as number | null, since: 0, sinceIdx: 0, held: 0, confirmed: false, last: 0, peak: -Infinity }])) as Record<LimbKey, { on: number | null; since: number; sinceIdx: number; held: number; confirmed: boolean; last: number; peak: number }>
  const close = (k: LimbKey) => {
    const s = st[k]
    if (s.on != null && s.confirmed) contacts.push({ limb: k, holdId: s.on, start: s.since, end: s.last })
    s.on = null; s.held = 0; s.confirmed = false; s.peak = -Infinity
  }
  const midline: { t: number; p: Vec2 }[] = []
  let startT: number | null = null, startDwell = 0
  let completion: number | null = null, finalDwell = 0
  let framesRead = 0

  // ViTPose+ marks the wrist; the hold is under the palm and fingers, a little
  // further along the forearm's line.
  const palmAt = (i: number, key: 'left_hand' | 'right_hand'): Vec2 | null => {
    const w = key === 'left_hand' ? KPT.lWrist : KPT.rWrist, el = key === 'left_hand' ? KPT.lElbow : KPT.rElbow
    if (!ok(i, w)) return null
    const [x, y] = K[i][w]
    return ok(i, el) ? [x + CFG.HAND_REACH * (x - K[i][el][0]), y + CFG.HAND_REACH * (y - K[i][el][1])] : [x, y]
  }
  for (let i = 0; i < climber.length; i++) {
    const t = T[i], k = K[i]
    if (i && t - T[i - 1] > CFG.POSE_GAP_SECONDS) for (const l of LIMBS) close(l.key)
    const toIso = toIsoAt(t)
    const tor = TORSO.filter((j) => ok(i, j))
    if (tor.length && toIso) {
      const p: Vec2 = [tor.reduce((s, j) => s + k[j][0], 0) / tor.length, tor.reduce((s, j) => s + k[j][1], 0) / tor.length]
      midline.push({ t, p: applyM(toIso, p) })
    }
    const zoom = zoomAt(t)
    const outlines = new Map<number, Vec2[]>()
    for (const tr of tracks) {
      const o = outlineAt(tr.id, t)
      if (o) outlines.set(tr.id, o)
    }
    if (!outlines.size || zoom == null) { for (const l of LIMBS) close(l.key); continue }
    framesRead++
    const hu = holdUnit * zoom // a hold height, in video heights, right now
    const enter = CFG.HOLD_MASK_MARGIN * hu, release = CFG.HOLD_RELEASE_MARGIN * hu, grazeDepth = CFG.HOLD_GRAZE_DEPTH * hu
    const toe = CFG.ANKLE_TO_TOE_OFFSET * bodyH[i]
    const depth = (id: number, x: number, y: number) => (outlines.has(id) ? signedDistance(outlines.get(id)!, x, y, aspect) : -Infinity)
    const bestHold = (x: number, y: number, margin: number) => {
      let bestId: number | null = null, bestD = -margin
      for (const id of outlines.keys()) {
        const d = depth(id, x, y)
        if (d >= -margin && d > bestD) { bestD = d; bestId = id }
      }
      return bestId
    }
    const now: Partial<Record<LimbKey, number>> = {}
    for (const limb of LIMBS) {
      const key = limb.key, kp = LIMB_KPT[key], s = st[key]
      if (!ok(i, kp)) { close(key); continue }
      let x = k[kp][0], y = k[kp][1] + (limb.hand ? 0 : toe)
      if (limb.hand) [x, y] = palmAt(i, key as 'left_hand' | 'right_hand')!
      let chosen: number | null
      let d: number | null = null
      if (s.on != null && depth(s.on, x, y) >= -release) {
        const cur = depth(s.on, x, y)
        const better = bestHold(x, y, enter)
        chosen = better != null && better !== s.on && depth(better, x, y) > cur ? better : s.on
        d = chosen === s.on ? cur : null
      } else chosen = bestHold(x, y, enter)
      if (chosen == null && limb.hand) {
        // Matching a small top hold, the second hand lands on the first hand,
        // not on the hold: palms together there is on the hold too.
        const ok2 = key === 'left_hand' ? 'right_hand' : 'left_hand', o = st[ok2], op = palmAt(i, ok2)
        if (o.on === finalHold && o.confirmed && op && Math.hypot((op[0] - x) * aspect, op[1] - y) <= CFG.MATCH_REACH * bodyH[i]) chosen = finalHold
      }
      if (chosen == null) { close(key); continue }
      if (s.on !== chosen) { close(key); s.on = chosen; s.since = t; s.sinceIdx = i }
      s.held++
      s.last = t
      s.peak = Math.max(s.peak, d ?? depth(chosen, x, y))
      const need = chosen === finalHold ? finalTouch : dwell
      // Matching the top hold, the second hand often lands on the first one's
      // fingers, at the hold's edge: with one hand already on it, half a second there counts.
      const other = st[key === 'left_hand' ? 'right_hand' : 'left_hand']
      const matching = limb.hand && chosen === finalHold && other.on === finalHold && other.confirmed && s.held >= finalFrames
      if (!s.confirmed && s.held >= need && (s.peak >= -grazeDepth || s.held >= grazeFrames || matching)) {
        s.confirmed = true
        if (!activatedAt.has(chosen)) activatedAt.set(chosen, t)
      }
      if (s.confirmed) now[key] = chosen
    }
    if (completion == null) {
      // Topping out: both hands in confirmed contact with the top hold, backdated
      // to when both were touching it, as the pipeline measures it.
      if (now.left_hand === finalHold && now.right_hand === finalHold) {
        const overlap = i - Math.max(st.left_hand.sinceIdx, st.right_hand.sinceIdx) + 1
        finalDwell = Math.max(finalDwell + 1, overlap)
        if (finalDwell >= finalFrames) completion = t
      } else finalDwell = Math.max(0, finalDwell - CFG.FINAL_DWELL_DECAY)
    }
    if (startT == null) {
      // No floor segmentation here: both feet on holds is "off the ground".
      // Leaky rather than reset, and backdated to the first frame of the run.
      const started = st.left_foot.on != null && st.right_foot.on != null
      startDwell = started ? startDwell + 1 : Math.max(0, startDwell - CFG.START_DWELL_DECAY)
      if (startDwell >= startFrames) startT = T[Math.max(0, i - startDwell + 1)]
    }
  }
  for (const l of LIMBS) close(l.key)

  let startSource: ReadStats['start'] = 'both feet on holds'
  if (startT == null) {
    if (contacts.length) {
      startT = Math.min(...contacts.map((c) => c.start))
      startSource = 'first contact'
      warnings.push('The climb clock starts at the first contact: both feet were never seen on holds together.')
    } else {
      startT = T[0]
      startSource = 'none'
    }
  }
  // Feet off the route: on some problems the feet use volumes and the wall
  // itself, and never stand on two route holds together until late. When the
  // hands were already moving between route holds well before that, the
  // climb started with them.
  if (startSource === 'both feet on holds' && startT != null) {
    const feet = startT
    const early = contacts.filter((c) => (c.limb === 'left_hand' || c.limb === 'right_hand') && c.start < feet - CFG.HANDS_FIRST_SECONDS)
    if (new Set(early.map((c) => c.holdId)).size >= 2) {
      startT = Math.min(...early.map((c) => c.start))
      startSource = 'first contact'
      warnings.push('The climb clock starts at the first hand hold: the feet were off the route holds until late in the climb.')
    }
  }
  // Standing with the hands already on the start hold is not climbing yet. When
  // the clock would start at a hand contact, move it to the moment both feet
  // left the floor: each ankle clearly above where it stood, and staying there.
  if (startSource === 'first contact' && startT != null) {
    const firstFoot = Math.min(Infinity, ...contacts.filter((c) => c.limb === 'left_foot' || c.limb === 'right_foot').map((c) => c.start))
    const rows: { t: number; l: number; r: number; hip: number }[] = []
    for (let i = 0; i < climber.length; i++) {
      const m = toIsoAt(T[i])
      if (!m || ![KPT.lAnkle, KPT.rAnkle, KPT.lHip, KPT.rHip].every((j) => ok(i, j))) continue
      const y = (j: number) => applyM(m, [K[i][j][0], K[i][j][1]])[1]
      rows.push({ t: T[i], l: y(KPT.lAnkle), r: y(KPT.rAnkle), hip: (y(KPT.lHip) + y(KPT.rHip)) / 2 })
    }
    const base = rows.filter((x) => x.t <= rows[0]?.t + 0.6)
    if (base.length >= 3 && rows[0].t <= startT + 0.5) {
      const l0 = median(base.map((x) => x.l)), r0 = median(base.map((x) => x.r)), leg = Math.max(l0, r0) - median(base.map((x) => x.hip))
      const up = (x: (typeof rows)[number]) => l0 - x.l > CFG.LIFT_OFF * leg && r0 - x.r > CFG.LIFT_OFF * leg
      const need = Math.max(2, Math.round(0.4 * fps))
      for (let i = 0; leg > 0 && i + need <= rows.length; i++) {
        if (rows[i].t >= firstFoot) break
        if (rows.slice(i, i + need).every(up)) {
          if (rows[i].t > startT) { startT = rows[i].t; startSource = 'feet off the floor' }
          break
        }
      }
    }
  }
  if (completion == null) warnings.push('No top-out detected: both hands never held the top hold together.')
  if (!contacts.length) warnings.push('No contacts: no hand or foot stayed on a hold long enough to count.')
  // The climb runs to the top-out or, short of one, to the last moment a limb
  // held a hold: a fall and the mat after it are not time on the wall.
  const lastHold = contacts.length ? Math.max(...contacts.map((c) => c.end)) : null
  const lo = startT, hi = completion ?? (lastHold != null && lastHold > startT ? lastHold : T[T.length - 1])
  const step = 1 / fps

  // Restrict to the climb, then merge a limb's re-grips on the same hold.
  const mergedC: Contact[] = []
  const latest = new Map<LimbKey, Contact>()
  for (const c of [...contacts].sort((a, b) => a.start - b.start || a.limb.localeCompare(b.limb))) {
    const start = Math.max(c.start, lo), end = Math.min(c.end, hi)
    if (end < start) continue
    const prev = latest.get(c.limb)
    if (prev && prev.holdId === c.holdId && start - prev.end <= CFG.REGRIP_GAP_SECONDS) { prev.end = Math.max(prev.end, end); continue }
    const e = { ...c, start, end }
    mergedC.push(e)
    latest.set(c.limb, e)
  }

  // ── the canvas ─────────────────────────────────────────────────────────────
  // A still camera's canvas is its frame. A moving one's is the part of the
  // wall the route and the climber cover, with a margin.
  let X0 = 0, Y0 = 0, Wc = aspect, Hc = 1
  if (!still) {
    const pts: Vec2[] = tracks.flatMap((tr) => tr.iso!)
    for (const m of midline) if (m.t >= lo - 0.5 && m.t <= hi + 0.3) pts.push(m.p)
    for (let i = 0; i < climber.length; i++) {
      if (T[i] < lo || T[i] > hi) continue
      const toIso = toIsoAt(T[i])
      if (!toIso) continue
      for (const j of [KPT.lWrist, KPT.rWrist, KPT.lAnkle, KPT.rAnkle]) if (ok(i, j)) pts.push(applyM(toIso, [K[i][j][0], K[i][j][1]]))
    }
    const [bx, by, bw, bh] = bboxOf(pts)
    const pad = Math.max(0.06 * Math.max(bw, bh), 1.5 * holdUnit)
    X0 = bx - pad; Y0 = by - pad; Wc = bw + 2 * pad; Hc = bh + 2 * pad
  }
  const toCanvas = (p: Vec2): Vec2 => [(p[0] - X0) / Wc, (p[1] - Y0) / Hc]
  const C: Affine = [[1 / Wc, 0, -X0 / Wc], [0, 1 / Hc, -Y0 / Hc]]

  const holds = assignIds(tracks.map((tr) => {
    const polygon = tr.iso!.map(toCanvas)
    return {
      id: tr.id,
      bbox: bboxOf(polygon),
      polygon,
      score: round(tr.score, 4),
      appearance_fraction: round(tr.appearance, 4),
      tracks: [tr.id],
      seen: [round(tr.sightings[0].t), round(tr.sightings[tr.sightings.length - 1].t)],
    } as PipelineHold
  }), CFG.NUMBER_BAND / Hc)
  const idOf = new Map(holds.map((h) => [(h.tracks as number[])[0], h.id]))

  const moves: PipelineMove[] = mergedC.map((m, i) => ({
    step: i + 1,
    hold_id: idOf.get(m.holdId)!,
    limb: m.limb,
    limb_label: LIMBS.find((l) => l.key === m.limb)!.label,
    time: round(m.start - lo),
    contact_seconds: round(m.end - m.start + step),
  }))
  // The order holds were reached: when each contact was confirmed, as the
  // pipeline ranks them, for the holds used during the climb.
  const used = new Set(mergedC.map((m) => m.holdId))
  const sequence = [...activatedAt.entries()].filter(([track]) => used.has(track)).sort((a, b) => a[1] - b[1]).map(([track]) => idOf.get(track)!)
  const elapsed = completion != null ? completion - lo : null

  const journey = hi - lo + step
  const perLimb: Record<string, any> = {}
  let total = 0
  for (const l of LIMBS) total += mergedC.filter((m) => m.limb === l.key).reduce((s, m) => s + m.end - m.start + step, 0)
  for (const l of LIMBS) {
    const own = mergedC.filter((m) => m.limb === l.key)
    const secs = own.reduce((s, m) => s + m.end - m.start + step, 0)
    const seq: number[] = []
    for (const m of own) if (seq[seq.length - 1] !== idOf.get(m.holdId)) seq.push(idOf.get(m.holdId)!)
    perLimb[l.key] = {
      seconds: round(secs),
      share_of_contact: round(total ? secs / total : 0, 5),
      coverage_of_climb: round(journey > 0 ? Math.min(1, secs / journey) : 0, 5),
      holds: [...new Set(seq)].sort((a, b) => a - b),
      n_holds: new Set(seq).size,
      sequence: seq,
    }
  }

  // The torso's path on the canvas, over the climb. Smoothed, so it reads as
  // the shape of the climb rather than every wobble of a reach (and, with a
  // moving camera, of the camera's placement).
  const near = midline.filter((m) => m.t >= lo - 0.5 && m.t <= hi + 0.3)
  const tx = gaussianSmooth(near.map((m) => m.p[0]), (still ? 0.1 : 0.3) * fps)
  const ty = gaussianSmooth(near.map((m) => m.p[1]), (still ? 0.1 : 0.3) * fps)
  const torso: [number, number, number][] = []
  near.forEach((m, i) => {
    if (torso.length && m.t - lo - torso[torso.length - 1][0] < 1 / 15 - 1e-6) return
    const [x, y] = toCanvas([tx[i], ty[i]])
    torso.push([round(m.t - lo), round(x, 5), round(y, 5)])
  })

  const climb: PipelineClimb = {
    route: { color, grade: '—', name: null, prompt: `${color} climbing hold` },
    route_color: color,
    prompt: `${color} climbing hold`,
    fps,
    holds_detected: holds.length,
    holds_used: sequence.length,
    start_frame: Math.round(lo * fps),
    completion_frame: completion != null ? Math.round(completion * fps) : null,
    final_hold_id: idOf.get(finalHold)!,
    elapsed_seconds: elapsed != null ? round(elapsed) : null,
    topped_out: completion != null,
    order: sequence,
    sequence,
    moves,
    utilization: { total_contact_seconds: round(total), per_limb: perLimb },
  }

  // What the overlay needs to draw on the video: the camera per sampled frame
  // (canvas → video), each hold's own outlines, the climber's 17 joints.
  const motion: MotionTrack | undefined = still ? undefined : {
    t: sampleTimes.filter((_, i) => reg.toCanvas[i]).map((t) => round(t, 4)),
    m: reg.toCanvas.filter(Boolean).map((m) => roundM(invert(compose(C, m!)))),
  }
  const sightingsOut = still ? undefined : Object.fromEntries(tracks.map((tr) => [idOf.get(tr.id)!, tr.sightings.map((s) => ({
    t: round(s.t, 4), whole: s.whole, poly: simplify(s.poly).map((p) => [round(p[0], 4), round(p[1], 4)] as Vec2),
  }))]))
  const misfits = reg.residual.filter((r): r is number => r != null)

  return {
    outcome: 'ok',
    holds: holds.map((h) => ({ ...h, polygon: (h.polygon ?? []).map((p) => [round(p[0], 5), round(p[1], 5)] as Vec2) })),
    climb,
    canvas: still ? { width: frame.width, height: frame.height } : { width: Math.round(Wc * frame.height), height: Math.round(Hc * frame.height) },
    torso,
    start: round(lo, 4),
    end: completion != null ? round(completion, 4) : null,
    motion,
    sightings: sightingsOut,
    pose: { t: T.map((t) => round(t, 4)), k: K.map((row) => row.flatMap(([x, y, c]) => [round(x, 4), round(y, 4), round(c, 2)])) },
    stats: {
      ...baseStats,
      holdTracks: tracks.length + merged,
      holds: holds.length,
      movingTracks: reg.moving.length,
      climberFrames: climber.length,
      climberSpan: climber.length ? [T[0], T[T.length - 1]] : null,
      poseFps: fps,
      camera: reg.mode,
      registeredSamples: registered,
      registeredFraction: round(registered / samples.length, 3),
      misfit: misfits.length ? round(median(misfits), 3) : null,
      framesRead,
      contacts: contacts.length,
      moves: moves.length,
      start: startSource,
      toppedOut: completion != null,
    },
    warnings,
  }
}

function empty(outcome: 'no-holds' | 'no-climber', base: Partial<ReadStats>, warnings: string[], frame: ReadInput['frame']): Reading {
  return {
    outcome,
    holds: [],
    climb: { moves: [], sequence: [], order: [], holds_detected: 0, holds_used: 0, topped_out: false, elapsed_seconds: null },
    canvas: { width: frame.width, height: frame.height },
    torso: [],
    start: 0,
    end: null,
    pose: { t: [], k: [] },
    stats: {
      samSamples: 0, samTracks: 0, samDetections: 0, holdTracks: 0, holds: 0, movingTracks: 0, people: 0, poseFrames: 0,
      climberFrames: 0, climberSpan: null, poseFps: 0, camera: 'still', registeredSamples: 0, registeredFraction: 0, misfit: null,
      framesRead: 0, contacts: 0, moves: 0, start: 'none', toppedOut: false, ...base,
    },
    warnings,
  }
}

/** Bottom to top; holds in one horizontal band are read left to right. */
function assignIds(holds: PipelineHold[], band: number): PipelineHold[] {
  const c = (h: PipelineHold) => [h.bbox[0] + h.bbox[2] / 2, h.bbox[1] + h.bbox[3] / 2]
  const sorted = [...holds].sort((a, b) => c(b)[1] - c(a)[1])
  const rows: PipelineHold[][] = []
  for (const h of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(c(row[0])[1] - c(h)[1]) < band) row.push(h)
    else rows.push([h])
  }
  let id = 1
  for (const row of rows) for (const h of row.sort((a, b) => c(a)[0] - c(b)[0])) h.id = id++
  return sorted.sort((a, b) => a.id - b.id)
}

/** Andrew's monotone chain. */
function convexHull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Vec2[] = [], upper: Vec2[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function kptBox(kps: { x: number; y: number; confidence: number }[]): [number, number, number, number] | null {
  const pts = kps.filter((k) => k.confidence >= CFG.BOX_MIN_CONFIDENCE).map((k) => [k.x, k.y] as Vec2)
  return pts.length >= 3 ? bboxOf(pts) : null
}
const boxOf = (f: PoseResult['frames'][number]) => f.bbox ?? kptBox(f.keypoints)

function iou(a: number[], b: number[]) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const u = a[2] * a[3] + b[2] * b[3] - inter
  return u > 0 ? inter / u : 0
}
function overlapFrac(box: number[], wall: number[]) {
  const x0 = Math.max(box[0], wall[0]), y0 = Math.max(box[1], wall[1])
  const x1 = Math.min(box[0] + box[2], wall[0] + wall[2]), y1 = Math.min(box[1] + box[3], wall[1] + wall[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return box[2] * box[3] > 0 ? inter / (box[2] * box[3]) : 0
}
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
const roundM = (m: Affine): Affine => m.map((r) => r.map((v) => round(v, 6)))
