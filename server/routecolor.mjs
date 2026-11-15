// Which color was the route? The app asks, but people forget to change it
// (green is the default), and then SAM dutifully finds the two green holds on
// the wall and the climber touches neither. Two checks catch that:
//
//   touchScore   how often a wrist or ankle sits on a hold of the asked color;
//   guessColors  which hold colors are under the climber's hands and feet,
//                compared with how common each color is on the rest of the
//                frame (a red wall panel should not win just by being big).
//
// The caller re-runs SAM for the best guesses and keeps the color the climber
// actually touches. White and black holds have no hue, so they are never
// guessed; picking them still works as before.
import { spawnSync } from 'node:child_process'

// Hue ranges (degrees) for the route colors the app knows. Pixels need some
// saturation and light to vote, which keeps grey walls, white chalk and shadow out.
const BUCKETS = [
  ['red', 345, 360], ['red', 0, 14], ['orange', 14, 40], ['yellow', 40, 68], ['green', 68, 170],
  ['blue', 170, 252], ['purple', 252, 290], ['pink', 290, 345],
]
const bucketOf = (h) => BUCKETS.find(([, a, b]) => h >= a && h < b)?.[0] ?? null
const MIN_SAT = 0.42, MIN_VAL = 0.22
const HANDS = [[9, 7], [10, 8]] // wrist, elbow
const FEET = [[15, 13], [16, 14]] // ankle, knee

/** The person the clip is about: the pose track seen in the most frames. */
export function mainTrack(pose) {
  const n = new Map()
  for (const f of pose.frames) n.set(f.track, (n.get(f.track) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
}

/** Touches of the climber's hands and feet on SAM's holds: how many sightings
 *  had a wrist or ankle on (or just around) a hold, and on how many holds. */
export function touchScore(sam, pose) {
  const main = mainTrack(pose)
  const byFrame = new Map(pose.frames.filter((f) => f.track === main).map((f) => [f.frame, f]))
  let count = 0
  const holds = new Set()
  for (const d of sam.detections) {
    const f = byFrame.get(d.frame)
    if (!f) continue
    const [x, y, w, h] = d.bbox
    const pad = Math.max(w, h) * 0.35 + 0.012
    for (const [k] of [...HANDS, ...FEET]) {
      const p = f.keypoints[k]
      if (p.confidence < 0.3) continue
      if (p.x >= x - pad && p.x <= x + w + pad && p.y >= y - pad && p.y <= y + h + pad) { count++; holds.add(d.track); break }
    }
  }
  return { count, holds: holds.size }
}

/** Hold colors under the climber's hands and feet, best first. `file` is the
 *  10 fps analysis copy the pose was run on; frame n of it is pose frame n. */
export function guessColors(ffmpeg, file, pose, clip) {
  const main = mainTrack(pose)
  const frames = pose.frames.filter((f) => f.track === main && HANDS.some(([w]) => f.keypoints[w].confidence >= 0.35))
  if (frames.length < 4) return []
  const pick = Array.from({ length: Math.min(20, frames.length) }, (_, i) => frames[Math.floor(((i + 0.5) * frames.length) / Math.min(20, frames.length))])
  const W = 360, H = Math.max(2, Math.round((W * clip.height) / clip.width / 2) * 2)
  const select = pick.map((f) => `eq(n\\,${f.frame})`).join('+')
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select='${select}',scale=${W}:${H}`, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 })
  const size = W * H * 3
  if (r.status !== 0 || !r.stdout || r.stdout.length < size) return []
  const got = Math.floor(r.stdout.length / size)

  const hand = new Map(), wall = new Map()
  let handTotal = 0, wallTotal = 0
  const vote = (m, px, w) => {
    const R = px[0] / 255, G = px[1] / 255, B = px[2] / 255
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
    if (max < MIN_VAL || !max || d / max < MIN_SAT) return 0
    let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
    h = (h * 60 + 360) % 360
    const b = bucketOf(h)
    if (!b) return 0
    const v = w * (d / max)
    m.set(b, (m.get(b) ?? 0) + v)
    return v
  }
  for (let i = 0; i < got; i++) {
    const f = pick[i], buf = r.stdout.subarray(i * size, (i + 1) * size)
    const at = (x, y) => { const o = (y * W + x) * 3; return [buf[o], buf[o + 1], buf[o + 2]] }
    // Where the hand is: a little past the wrist, away from the sleeve.
    for (const [limbs, reach, rad, weight] of [[HANDS, 0.5, 0.42, 1], [FEET, 0.25, 0.3, 0.6]]) {
      for (const [a, b] of limbs) {
        const p = f.keypoints[a], q = f.keypoints[b]
        if (p.confidence < 0.35 || q.confidence < 0.2) continue
        const px = p.x * W, py = p.y * H, dx = px - q.x * W, dy = py - q.y * H
        const len = Math.hypot(dx, dy)
        const cx = px + dx * reach, cy = py + dy * reach, rr = Math.max(3, len * rad)
        for (let y = Math.max(0, Math.floor(cy - rr)); y <= Math.min(H - 1, Math.ceil(cy + rr)); y++) {
          for (let x = Math.max(0, Math.floor(cx - rr)); x <= Math.min(W - 1, Math.ceil(cx + rr)); x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= rr * rr) handTotal += vote(hand, at(x, y), weight)
          }
        }
      }
    }
    // The rest of the frame, away from the climber, sampled on a grid.
    const [bx, by, bw, bh] = f.bbox ?? [0, 0, 0, 0]
    for (let y = 2; y < H; y += 6) for (let x = 2; x < W; x += 6) {
      const u = x / W, v = y / H
      if (u >= bx && u <= bx + bw && v >= by && v <= by + bh) continue
      wallTotal += vote(wall, at(x, y), 1)
    }
  }
  if (handTotal <= 0) return []
  return [...hand.entries()].map(([color, v]) => {
    const share = v / handTotal
    const elsewhere = wallTotal > 0 ? (wall.get(color) ?? 0) / wallTotal : 0
    const lift = share / (elsewhere + 0.03)
    return { color, share: Math.round(share * 1000) / 1000, lift: Math.round(lift * 100) / 100, score: share * Math.min(3, lift) }
  }).sort((a, b) => b.score - a.score)
}
