// Offline reel renderer: the app's own reel drawing (src/lib/reel.ts), driven
// one exact frame at a time instead of recorded in real time, so nothing drops
// and the result can be encoded at full quality. Driven by tools/reel/render.mjs.
import '../../src/styles/metro.css'
import { loadBundled } from '../../src/lib/api'
import { drawReel, loadReelArt, prepareReel, REEL_SIZE, type ReelFormat } from '../../src/lib/reel'
import { applyTheme, type Mode, type Theme } from '../../src/lib/store'
import { buildTimeline } from '../../src/lib/timeline'

const q = new URLSearchParams(location.search)
applyTheme((q.get('theme') ?? 'lime') as Theme, (q.get('mode') ?? 'dark') as Mode)
const format = (q.get('format') ?? 'portrait') as ReelFormat
const example = q.get('example') ?? 'oliver'

const image = (src: string) => new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src })

async function setup(clipSeconds: number, frameAspect: number) {
  const s = await loadBundled(example)
  if (!s) throw new Error(`No bundled example "${example}"`)
  const [wall, art] = await Promise.all([s.wall?.src ? image(s.wall.src) : null, loadReelArt()])
  if (!art.logo) throw new Error('The logo did not load')
  await document.fonts.ready
  const R = prepareReel(s, buildTimeline(s), clipSeconds, wall, art)
  const [W, H] = REEL_SIZE[format]
  const canvas = document.getElementById('c') as HTMLCanvasElement
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  return {
    total: R.total, clip: R.clip, offset: s.video?.offset ?? 0, climbEnd: R.tl.climbEnd, W, H,
    /** Draw reel time r over the given clip frame (a JPEG data URL) and return a PNG data URL. */
    async frame(r: number, jpeg: string | null) {
      const bmp = jpeg ? await createImageBitmap(await (await fetch(jpeg)).blob()) : null
      drawReel(ctx, R, bmp, frameAspect, r, W, H)
      bmp?.close()
      return canvas.toDataURL('image/png')
    },
    /** The credits card at progress p (0..1), faded in over the reel's last frame. */
    credits(p: number, seconds: number) {
      drawReel(ctx, R, null, frameAspect, R.total, W, H)
      drawCredits(ctx, W, H, p * seconds, art.logo, s.climber ?? null)
      return canvas.toDataURL('image/png')
    },
  }
}

const FONT = "'Selawik', 'Open Sans Variable', system-ui, sans-serif"
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3)
/** Who made it possible. `t` is seconds into the card. */
function drawCredits(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, logo: HTMLImageElement | null, climber: string | null) {
  const u = Math.min(W, H) / 1080
  const accent = '#9be36a'
  // the page, fading in over the reel
  ctx.save()
  ctx.globalAlpha = ease(t / 0.5)
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, '#1f4214'); bg.addColorStop(0.5, '#0b1808'); bg.addColorStop(1, '#040803')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W / 2, H * 0.36, 0, W / 2, H * 0.36, W * 0.8)
  glow.addColorStop(0, 'rgba(155,227,106,0.28)'); glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)
  ctx.restore()

  const cx = W / 2
  const portrait = H > W
  let y = portrait ? H * 0.3 + 100 * u : H * 0.2 + 70 * u
  const rise = (at: number) => { const a = ease((t - at) / 0.5); ctx.globalAlpha = a; return (1 - a) * 24 * u }
  ctx.save()
  ctx.textAlign = 'center'
  if (logo) {
    const lw = (portrait ? 560 : 520) * u, lh = lw * (logo.naturalHeight / logo.naturalWidth)
    const dy = rise(0.25)
    ctx.drawImage(logo, cx - lw / 2, y - lh / 2 + dy, lw, lh)
    y += lh / 2 + 70 * u
  }
  let dy = rise(0.45)
  ctx.fillStyle = '#fff'
  ctx.font = `300 ${64 * u}px ${FONT}`
  ctx.fillText('read every move.', cx, y + dy)
  y += 54 * u
  ctx.fillStyle = accent
  ctx.fillRect(cx - 60 * u, y + dy, 120 * u, 4 * u)
  y += (portrait ? 110 : 80) * u

  const lines: [string, string][] = [
    ['holds and pose', 'SAM 3.1 + ViTPose+, served by VLM Run'],
    ['inspired by', 'Jeremy Park’s vision demos'],
    ...(climber ? [['on the wall', climber] as [string, string]] : []),
  ]
  lines.forEach(([k, v], i) => {
    dy = rise(0.7 + i * 0.18)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = `600 ${24 * u}px ${FONT}`
    ctx.fillText(k, cx, y + dy)
    ctx.fillStyle = '#fff'
    ctx.font = `400 ${38 * u}px ${FONT}`
    ctx.fillText(v, cx, y + 50 * u + dy)
    y += (portrait ? 140 : 112) * u
  })
  ctx.restore()
}

declare global { interface Window { reel: { setup: typeof setup; ready?: Awaited<ReturnType<typeof setup>> } } }
window.reel = { setup }
