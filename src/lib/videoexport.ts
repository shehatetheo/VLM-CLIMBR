// The performance reel as a video file. Rendered in the browser only when asked
// for, in real time: the clip plays once into a canvas (reel.ts draws it), the
// finale follows, and MediaRecorder records the lot. MP4 where the browser can
// record H.264 (Safari, so iPhone), WebM otherwise.

import { slug } from './download'
import { drawReel, prepareReel, REEL_SIZE, type ReelFormat } from './reel'
import { buildTimeline } from './timeline'
import type { Session } from './types'

function recorderType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const ok = (t: string) => MediaRecorder.isTypeSupported(t)
  for (const t of ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1']) if (ok(t)) return t
  // Safari records H.264 under plain video/mp4. Chromium's plain MP4 is VP9,
  // which QuickTime will not open, so there it is WebM instead.
  if (ok('video/mp4') && !ok('video/webm')) return 'video/mp4'
  for (const t of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']) if (ok(t)) return t
  return null
}

export function canExportVideo(s: Session) {
  return Boolean(s.video?.src) && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && recorderType() !== null
}

export function loadClip(s: Session): Promise<HTMLVideoElement> {
  const v = s.video
  if (!v?.src) return Promise.reject(new Error('This climb has no video.'))
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  if (!v.src.startsWith('blob:')) el.crossOrigin = 'anonymous'
  for (const src of [v.src, v.webm].filter(Boolean) as string[]) {
    const so = document.createElement('source')
    so.src = src
    if (src.endsWith('.webm')) so.type = 'video/webm'
    el.appendChild(so)
  }
  el.load()
  return new Promise((res, rej) => {
    el.addEventListener('loadeddata', () => res(el), { once: true })
    el.addEventListener('error', () => rej(new Error('The clip could not be loaded.')), { once: true })
  })
}

export function loadWall(s: Session): Promise<HTMLImageElement | null> {
  if (!s.wall?.src) return Promise.resolve(null)
  return new Promise((res) => {
    const img = new Image()
    if (!s.wall!.src.startsWith('blob:')) img.crossOrigin = 'anonymous'
    img.onload = () => res(img)
    img.onerror = () => res(null)
    img.src = s.wall!.src
  })
}

export interface ReelFile { blob: Blob; name: string; seconds: number }

export async function exportReel(s: Session, format: ReelFormat, { onProgress, signal }: { onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<ReelFile> {
  const type = recorderType()
  if (!type) throw new Error('This browser cannot record video.')
  const [el, wall] = await Promise.all([loadClip(s), loadWall(s)])
  // Safari only keeps a video's picture fresh while it is in the page.
  el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none'
  document.body.appendChild(el)
  await document.fonts?.ready
  const tl = buildTimeline(s)
  const R = prepareReel(s, tl, el.duration, wall)
  const [W, H] = REEL_SIZE[format]
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const aspect = el.videoWidth / el.videoHeight
  let ended = 0 // performance.now() when the clip finished
  const reelTime = () => (ended ? R.clip + (performance.now() - ended) / 1000 : Math.min(el.currentTime, R.clip))
  const draw = () => {
    const r = Math.min(reelTime(), R.total)
    drawReel(ctx, R, el, aspect, r, W, H)
    onProgress?.(r / R.total)
  }

  const stream = canvas.captureStream(30)
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10_000_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise<void>((res) => { rec.onstop = () => res() })

  let raf = 0
  try {
    el.currentTime = 0
    await new Promise((res) => el.addEventListener('seeked', res, { once: true }))
    draw()
    rec.start(500)
    await new Promise<void>((res, rej) => {
      const fail = (e: Error) => { cancelAnimationFrame(raf); rej(e) }
      const loop = () => {
        draw()
        if (ended && reelTime() >= R.total) return res()
        raf = requestAnimationFrame(loop)
      }
      el.addEventListener('ended', () => { ended = performance.now() }, { once: true })
      el.addEventListener('error', () => fail(new Error('Playback stopped while rendering.')), { once: true })
      signal?.addEventListener('abort', () => fail(new DOMException('Cancelled', 'AbortError')), { once: true })
      el.play().then(() => { raf = requestAnimationFrame(loop) }, () => fail(new Error('The browser would not play the clip for rendering.')))
    })
  } finally {
    cancelAnimationFrame(raf)
    el.pause()
    el.remove()
    if (rec.state !== 'inactive') rec.stop()
  }
  await stopped
  stream.getTracks().forEach((tr) => tr.stop())
  let blob = new Blob(chunks, { type: type.split(';')[0] })
  if (!blob.size) throw new Error('The recording came out empty.')
  if (blob.type === 'video/webm') blob = await withWebmDuration(blob, R.total * 1000)
  return { blob, name: `${slug(s)}-reel.${blob.type === 'video/mp4' ? 'mp4' : 'webm'}`, seconds: R.total }
}

/** MediaRecorder's WebM has no Duration, so players cannot seek it. Write one
 *  into the Segment's Info element (in TimecodeScale units: ms by default). */
async function withWebmDuration(blob: Blob, ms: number): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer())
  const find = (id: number[], from = 0) => {
    for (let i = from; i < head.length - id.length; i++) if (id.every((b, k) => head[i + k] === b)) return i
    return -1
  }
  const vint = (at: number) => {
    const first = head[at]
    let len = 1
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
    let v = first & (0xff >> len)
    for (let k = 1; k < len; k++) v = v * 256 + head[at + k]
    return { len, v }
  }
  const info = find([0x15, 0x49, 0xa9, 0x66])
  if (info < 0) return blob
  const size = vint(info + 4)
  const start = info + 4 + size.len, end = start + size.v
  if (end > head.length || find([0x44, 0x89], start) > -1 && find([0x44, 0x89], start) < end) return blob
  const duration = new Uint8Array(11)
  duration.set([0x44, 0x89, 0x88])
  new DataView(duration.buffer).setFloat64(3, ms)
  const newSize = size.v + duration.length
  const sizeBytes = new Uint8Array(8) // an 8-byte vint always fits
  sizeBytes[0] = 0x01
  for (let k = 7, v = newSize; k >= 1; k--, v = Math.floor(v / 256)) sizeBytes[k] = v & 0xff
  return new Blob([head.slice(0, info + 4), sizeBytes, head.slice(start, end), duration, blob.slice(end)], { type: blob.type })
}
