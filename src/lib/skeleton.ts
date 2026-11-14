// The climber as ViTPose+ saw them, at any moment of the clip.

import { applyM, IDENTITY, invert, motionAt } from './motion'
import type { Skeleton } from './timeline'
import type { PoseTrack, Session, Vec2 } from './types'

/** COCO-17 bones, by keypoint index. */
export const BONES: [number, number][] = [
  [5, 7], [7, 9], [6, 8], [8, 10], // arms
  [5, 6], [5, 11], [6, 12], [11, 12], // torso
  [11, 13], [13, 15], [12, 14], [14, 16], // legs
  [0, 5], [0, 6], // head to shoulders
]
export const KP = { nose: 0, lWrist: 9, rWrist: 10, lAnkle: 15, rAnkle: 16 }
export const DRAW_MIN_CONFIDENCE = 0.3

export interface Joint { p: Vec2; c: number }

/** Keypoints at video time t, interpolated between the two posed frames around
 *  it. Null when no frame is close: the overlay shows nothing rather than a guess. */
export function poseAt(track: PoseTrack | undefined, t: number, maxGap = 0.25): Joint[] | null {
  if (!track?.t.length) return null
  const ts = track.t
  let lo = 0, hi = ts.length - 1
  if (t <= ts[0]) return ts[0] - t <= 0.06 ? joints(track.k[0]) : null
  if (t >= ts[hi]) return t - ts[hi] <= 0.06 ? joints(track.k[hi]) : null
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= t) lo = mid
    else hi = mid
  }
  const gap = ts[hi] - ts[lo]
  if (gap > maxGap) {
    const near = t - ts[lo] < ts[hi] - t ? lo : hi
    return Math.abs(ts[near] - t) <= 0.06 ? joints(track.k[near]) : null
  }
  const k = (t - ts[lo]) / gap
  const a = track.k[lo], b = track.k[hi]
  return Array.from({ length: 17 }, (_, j) => ({
    p: [a[3 * j] + (b[3 * j] - a[3 * j]) * k, a[3 * j + 1] + (b[3 * j + 1] - a[3 * j + 1]) * k] as Vec2,
    c: Math.min(a[3 * j + 2], b[3 * j + 2]),
  }))
}

const joints = (row: number[]): Joint[] => Array.from({ length: 17 }, (_, j) => ({ p: [row[3 * j], row[3 * j + 1]] as Vec2, c: row[3 * j + 2] }))

/** The climber as posed at video time `vt`, carried onto the wall canvas by the
 *  camera: the figure the route map draws. Null where there is no pose or the
 *  camera is unknown, so the map shows nothing rather than a guess. */
export function canvasSkeletonAt(s: Session, vt: number): Skeleton | null {
  const v = s.video
  const J = poseAt(s.pose, vt)
  if (!J || !v) return null
  const toVideo = v.motion ? motionAt(v.motion, vt) : (v.affine ?? IDENTITY)
  if (!toVideo) return null
  const inv = invert(toVideo)
  const P = (i: number): Vec2 => applyM(inv, J[i].p)
  const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const neck = mid(P(5), P(6))
  return {
    head: P(0), neck, torso: mid(neck, mid(P(11), P(12))),
    shoulders: [P(5), P(6)], elbows: [P(7), P(8)], wrists: [P(9), P(10)],
    hips: [P(11), P(12)], knees: [P(13), P(14)], ankles: [P(15), P(16)],
  }
}
