// A photo of the wall with the climber taken out, built in the browser from the
// clip itself: frames spread across the climb, the climber cut out of each one
// (ViTPose+ says where they were), each frame laid onto the wall canvas, and the
// median of what is left at every pixel. The climber is somewhere different in
// every frame, so the median returns the bare wall. With a camera that moved,
// each frame is warped by its own camera transform first, so the plate is a
// mosaic of everything the camera saw. It is what the route backdrop is drawn from.

import { IDENTITY, invert, motionAt, type Affine } from './motion'
import type { Session } from './types'

function once(el: HTMLMediaElement, ev: string, ms = 6000) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms)
    el.addEventListener(ev, () => { clearTimeout(t); res() }, { once: true })
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('video error')) }, { once: true })
  })
}

/** The climber's box at video time t, from the pose track (video 0–1). */
function climberBox(s: Session, t: number): [number, number, number, number] | null {
  const p = s.pose
  if (!p?.t.length) return null
  let best = 0
  for (let i = 1; i < p.t.length; i++) if (Math.abs(p.t[i] - t) < Math.abs(p.t[best] - t)) best = i
  if (Math.abs(p.t[best] - t) > 0.2) return null
  const k = p.k[best]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let j = 0; j < 17; j++) {
    if (k[3 * j + 2] < 0.2) continue
    x0 = Math.min(x0, k[3 * j]); x1 = Math.max(x1, k[3 * j])
    y0 = Math.min(y0, k[3 * j + 1]); y1 = Math.max(y1, k[3 * j + 1])
  }
  if (!Number.isFinite(x0)) return null
  // Joints are centres; the body, hair, shoes and chalk bag spill past them.
  const padX = (x1 - x0) * 0.3 + 0.045, padY = (y1 - y0) * 0.16 + 0.045
  return [x0 - padX, y0 - padY, x1 - x0 + 2 * padX, y1 - y0 + 2 * padY]
}

export async function buildWallPlate(s: Session, width = 300): Promise<string | null> {
  const src = s.video?.src
  if (!src) return null
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'
  for (const url of [src, s.video?.webm].filter(Boolean) as string[]) {
    const so = document.createElement('source')
    so.src = url
    if (url.endsWith('.webm')) so.type = 'video/webm'
    v.appendChild(so)
  }
  try {
    v.load()
    await once(v, 'loadeddata')
  } catch {
    return null
  }
  const motion = s.video?.motion
  const W = width, H = Math.round((width * s.canvas.height) / Math.max(1, s.canvas.width))
  if (!H || !v.videoWidth) return null
  // The frame, a little bigger than the plate needs; the climber cut out of it.
  const fh = Math.min(v.videoHeight, 2 * H), fw = Math.round((fh * v.videoWidth) / v.videoHeight)
  const frame = document.createElement('canvas')
  frame.width = fw
  frame.height = fh
  const fctx = frame.getContext('2d')!
  const plate = document.createElement('canvas')
  plate.width = W
  plate.height = H
  const ctx = plate.getContext('2d', { willReadFrequently: true })!

  // Times to sample: spread over the climb; with a moving camera, only where
  // the camera is known, and more of them, since each covers only part of the wall.
  const offset = s.video?.offset ?? 0
  const lo = motion ? motion.t[0] : 0, hi = motion ? motion.t[motion.t.length - 1] : v.duration
  const n = motion ? 48 : 12
  const times = Array.from({ length: n }, (_, i) => lo + ((i + 0.5) / n) * (hi - lo)).filter((t) => !motion || motionAt(motion, t))
  const layers: Uint8ClampedArray[] = []
  const centres: [number, number][] = [] // each frame's middle, in plate pixels
  for (const t of times) {
    const toVideo: Affine | null = motion ? motionAt(motion, t) : (s.video?.affine ?? IDENTITY)
    if (!toVideo) continue
    v.currentTime = Math.min(Math.max(0, t), v.duration - 0.05)
    try { await once(v, 'seeked', 4000) } catch { continue }
    fctx.clearRect(0, 0, fw, fh)
    fctx.drawImage(v, 0, 0, fw, fh)
    const box = climberBox(s, t)
    if (box) fctx.clearRect(box[0] * fw, box[1] * fh, box[2] * fw, box[3] * fh)
    else if (s.torso?.length) {
      // No pose: the old way, an ellipse around the torso track.
      const tr = s.torso.reduce((a, b) => (Math.abs(b[0] - (t - offset)) < Math.abs(a[0] - (t - offset)) ? b : a))
      if (Math.abs(tr[0] - (t - offset)) < 1) {
        const [x, y] = [toVideo[0][0] * tr[1] + toVideo[0][1] * tr[2] + toVideo[0][2], toVideo[1][0] * tr[1] + toVideo[1][1] * tr[2] + toVideo[1][2]]
        fctx.save()
        fctx.globalCompositeOperation = 'destination-out'
        fctx.beginPath()
        fctx.ellipse(x * fw, (y + 0.04) * fh, 0.2 * fw, 0.36 * fh, 0, 0, Math.PI * 2)
        fctx.fill()
        fctx.restore()
      }
    }
    // video pixels → canvas 0–1 → plate pixels
    const A = invert(toVideo)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.setTransform((W * A[0][0]) / fw, (H * A[1][0]) / fw, (W * A[0][1]) / fh, (H * A[1][1]) / fh, W * A[0][2], H * A[1][2])
    ctx.drawImage(frame, 0, 0)
    layers.push(ctx.getImageData(0, 0, W, H).data)
    centres.push([W * (A[0][0] * 0.5 + A[0][1] * 0.5 + A[0][2]), H * (A[1][0] * 0.5 + A[1][1] * 0.5 + A[1][2])])
  }
  if (motion && layers.length > 6) {
    // A frame caught mid-swing is a smear. Keep the crisp ones: detail is the
    // average step between neighbouring pixels.
    const detail = layers.map((L) => {
      let sum = 0, n = 0
      for (let p = 0; p + 1 < W * H; p += 3) {
        if (L[p * 4 + 3] < 250 || L[p * 4 + 7] < 250) continue
        sum += Math.abs(L[p * 4 + 1] - L[p * 4 + 5]); n++
      }
      return n ? sum / n : 0
    })
    const mid = [...detail].sort((a, b) => a - b)[detail.length >> 1]
    for (let i = layers.length - 1; i >= 0; i--) if (detail[i] < 0.7 * mid) { layers.splice(i, 1); centres.splice(i, 1) }
  }
  if (layers.length < 3) return null
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const out = ctx.createImageData(W, H)
  const buf = [0, 0, 0].map(() => new Array<number>(layers.length))
  // A camera that moved saw each patch of wall from a slightly different place
  // every time, so the frames never line up to the pixel and a median smears
  // them. There, each pixel comes from the frames that looked most squarely at
  // it (its distance from the frame's middle), blended only where they meet.
  const reach = Math.hypot(W, H)
  for (let p = 0; motion && p < W * H; p++) {
    const x = p % W, y = (p - x) / W
    let near = Infinity
    for (let i = 0; i < layers.length; i++) if (layers[i][p * 4 + 3] >= 250) near = Math.min(near, Math.hypot(x - centres[i][0], y - centres[i][1]))
    let r = 0, g = 0, b = 0, sum = 0
    for (let i = 0; i < layers.length && near < Infinity; i++) {
      const L = layers[i]
      if (L[p * 4 + 3] < 250) continue
      // The nearest frame that saw this pixel, feathered into the next only where they tie.
      const w = Math.exp(-(Math.hypot(x - centres[i][0], y - centres[i][1]) - near) / (0.012 * reach))
      if (w < 0.01) continue
      r += w * L[p * 4]; g += w * L[p * 4 + 1]; b += w * L[p * 4 + 2]; sum += w
    }
    out.data[p * 4] = sum ? r / sum : 12; out.data[p * 4 + 1] = sum ? g / sum : 12; out.data[p * 4 + 2] = sum ? b / sum : 12
    out.data[p * 4 + 3] = 255
  }
  for (let p = 0; !motion && p < W * H; p++) {
    let k = 0
    for (const L of layers) {
      if (L[p * 4 + 3] < 250) continue
      buf[0][k] = L[p * 4]; buf[1][k] = L[p * 4 + 1]; buf[2][k] = L[p * 4 + 2]
      k++
    }
    for (let c = 0; c < 3; c++) {
      if (!k) { out.data[p * 4 + c] = 12; continue }
      const a = buf[c].slice(0, k).sort((x, y) => x - y)
      out.data[p * 4 + c] = a[k >> 1]
    }
    out.data[p * 4 + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  const blob = await new Promise<Blob | null>((res) => plate.toBlob(res, 'image/jpeg', 0.86))
  return blob ? URL.createObjectURL(blob) : null
}
