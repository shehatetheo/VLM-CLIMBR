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
  if (motion) correctLayers(layers, centres, W, H)
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
    out.data[p * 4 + 3] = sum ? 255 : 0
  }
  // Where the camera never looked, carry the wall's own colors outward, soft,
  // so the scan has no black holes or torn edges.
  if (motion) fillUnseen(out.data, W, H)
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

/**
 * Two corrections before the frames are stitched, each frame against what the
 * ones before it laid down:
 *   · brightness: a phone re-exposes as it tilts toward a window, so the same
 *     wall comes out lighter or darker from frame to frame;
 *   · position: the camera transform is good to a few pixels, and a few pixels
 *     is a doubled edge. Each frame is nudged to where it lines up best.
 * Both are measured on a coarse grey copy, where it overlaps the mosaic so far.
 */
function correctLayers(layers: Uint8ClampedArray[], centres: [number, number][], W: number, H: number) {
  const q = Math.max(2, Math.round(W / 220)) // coarse step
  const w = Math.floor(W / q), h = Math.floor(H / q), R = 4 // search ±R coarse pixels
  const grey = (L: Uint8ClampedArray) => {
    const g = new Float32Array(w * h).fill(-1)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * q * W + x * q) * 4
      if (L[p + 3] >= 250) g[y * w + x] = 0.3 * L[p] + 0.59 * L[p + 1] + 0.11 * L[p + 2]
    }
    return g
  }
  // Start from the frame nearest the middle of everything, and work outward.
  const cx = centres.reduce((t, c) => t + c[0], 0) / centres.length, cy = centres.reduce((t, c) => t + c[1], 0) / centres.length
  const order = layers.map((_, i) => i).sort((a, b) => Math.hypot(centres[a][0] - cx, centres[a][1] - cy) - Math.hypot(centres[b][0] - cx, centres[b][1] - cy))
  const acc = new Float32Array(w * h).fill(-1)
  for (const i of order) {
    const L = layers[i], g = grey(L)
    // brightness, from the overlap as it stands
    let sa = 0, sg = 0, n = 0
    for (let k = 0; k < g.length; k++) if (g[k] >= 0 && acc[k] >= 0) { sa += acc[k]; sg += g[k]; n++ }
    let gain = 1, dx = 0, dy = 0
    if (n > 400 && sg > 0) {
      gain = Math.max(0.75, Math.min(1.33, sa / sg))
      // position: the shift with the smallest mean difference
      let best = Infinity
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
        let err = 0, m = 0
        for (let y = Math.max(0, -oy); y < Math.min(h, h - oy); y += 2) for (let x = Math.max(0, -ox); x < Math.min(w, w - ox); x += 2) {
          const a = acc[(y + oy) * w + x + ox], b = g[y * w + x]
          if (a < 0 || b < 0) continue
          err += Math.abs(a - b * gain); m++
        }
        if (m < 300) continue
        // A small pull toward "leave it where the camera put it".
        const score = err / m + 0.15 * Math.hypot(ox, oy)
        if (score < best) { best = score; dx = ox; dy = oy }
      }
    }
    if (gain !== 1 || dx || dy) {
      const sx = dx * q, sy = dy * q, src = dx || dy ? L.slice() : L
      if (dx || dy) L.fill(0)
      for (let y = 0; y < H; y++) {
        const ty = y + sy
        if (ty < 0 || ty >= H) continue
        for (let x = 0; x < W; x++) {
          const tx = x + sx
          if (tx < 0 || tx >= W) continue
          const a = (y * W + x) * 4, b = (ty * W + tx) * 4
          if (src[a + 3] < 250) { if (dx || dy) L[b + 3] = 0; continue }
          L[b] = src[a] * gain; L[b + 1] = src[a + 1] * gain; L[b + 2] = src[a + 2] * gain; L[b + 3] = 255
        }
      }
      centres[i] = [centres[i][0] + sx, centres[i][1] + sy]
    }
    const placed = dx || dy || gain !== 1 ? grey(L) : g
    for (let k = 0; k < placed.length; k++) if (acc[k] < 0 && placed[k] >= 0) acc[k] = placed[k]
  }
}

/** Fill the pixels no frame covered (alpha 0) from the ones around them: a
 *  pyramid averages what is known at coarser and coarser scales, and each hole
 *  takes the finest scale that reaches it. The fill is smooth by construction. */
function fillUnseen(data: Uint8ClampedArray, W: number, H: number) {
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array }
  const base: Level = { w: W, h: H, c: new Float32Array(W * H * 3), a: new Float32Array(W * H) }
  let holes = 0
  for (let p = 0; p < W * H; p++) {
    if (data[p * 4 + 3]) { base.a[p] = 1; base.c[p * 3] = data[p * 4]; base.c[p * 3 + 1] = data[p * 4 + 1]; base.c[p * 3 + 2] = data[p * 4 + 2] } else holes++
  }
  if (!holes) return
  const levels = [base]
  while (levels[levels.length - 1].w > 2 && levels[levels.length - 1].h > 2) {
    const f = levels[levels.length - 1], w = Math.ceil(f.w / 2), h = Math.ceil(f.h / 2)
    const n: Level = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) }
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const p = y * f.w + x, wgt = f.a[p]
      if (!wgt) continue
      const o = (y >> 1) * w + (x >> 1)
      n.a[o] += wgt; n.c[o * 3] += f.c[p * 3] * wgt; n.c[o * 3 + 1] += f.c[p * 3 + 1] * wgt; n.c[o * 3 + 2] += f.c[p * 3 + 2] * wgt
    }
    for (let o = 0; o < w * h; o++) if (n.a[o]) { n.c[o * 3] /= n.a[o]; n.c[o * 3 + 1] /= n.a[o]; n.c[o * 3 + 2] /= n.a[o]; n.a[o] = 1 }
    levels.push(n)
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], n = levels[l + 1]
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const p = y * f.w + x
      if (f.a[p]) continue
      // bilinear from the coarser level, so the fill has no blocks
      const gx = Math.min(n.w - 1, Math.max(0, (x - 0.5) / 2)), gy = Math.min(n.h - 1, Math.max(0, (y - 0.5) / 2))
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(n.w - 1, x0 + 1), y1 = Math.min(n.h - 1, y0 + 1), fx = gx - x0, fy = gy - y0
      for (let k = 0; k < 3; k++) {
        const v = (i: number, j: number) => n.c[(j * n.w + i) * 3 + k]
        f.c[p * 3 + k] = (v(x0, y0) * (1 - fx) + v(x1, y0) * fx) * (1 - fy) + (v(x0, y1) * (1 - fx) + v(x1, y1) * fx) * fy
      }
      f.a[p] = 1
    }
  }
  for (let p = 0; p < W * H; p++) {
    if (data[p * 4 + 3]) continue
    data[p * 4] = base.c[p * 3]; data[p * 4 + 1] = base.c[p * 3 + 1]; data[p * 4 + 2] = base.c[p * 3 + 2]; data[p * 4 + 3] = 255
  }
}
