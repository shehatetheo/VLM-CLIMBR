// Render a bundled example's performance reel to a high-quality MP4, offline.
//
//   node tools/reel/render.mjs --example oliver --format portrait \
//     --start 12 --cut 26.5 --out reel.mp4 [--theme lime] [--credits] [--stills 14,20,40]
//
// --start / --cut  the stretch of the clip to show (video seconds); the finale
//                  follows straight after --cut. Defaults: the whole clip.
// --credits        end on a short credits card.
// --stills a,b,c   write PNGs at those reel times instead of a video (for review).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const FFMPEG = require('ffmpeg-static')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] }
const flag = (k) => process.argv.includes(`--${k}`)
const example = arg('example', 'oliver'), format = arg('format', 'portrait'), theme = arg('theme', 'lime')
const out = path.resolve(arg('out', `${example}-${format}-reel.mp4`))
const FPS = 30
const CREDITS = 3.6 // seconds

const clipFile = path.join('public', 'examples', example, 'climb.mp4')
const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', clipFile], { encoding: 'utf8' }).stderr
const [, hh, mm, ss] = probe.match(/Duration: (\d+):(\d+):([\d.]+)/)
const clipSeconds = +hh * 3600 + +mm * 60 + +ss
const [, vw, vh] = probe.match(/Video:.* (\d{2,5})x(\d{2,5})/)

// Every clip frame, once, as high-quality JPEGs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'climbr-reel-'))
spawnSync(FFMPEG, ['-v', 'error', '-i', clipFile, '-vf', `fps=${FPS}`, '-q:v', '2', path.join(tmp, '%05d.jpg')])
const frames = fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort()
const jpegAt = (t) => {
  const f = frames[Math.max(0, Math.min(frames.length - 1, Math.round(t * FPS)))]
  return `data:image/jpeg;base64,${fs.readFileSync(path.join(tmp, f)).toString('base64')}`
}

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 400, height: 400 } })
page.on('pageerror', (e) => console.error('page:', e.message))
await page.goto(`http://localhost:5199/tools/reel/index.html?example=${example}&format=${format}&theme=${theme}${flag('bare') ? '&bare=1' : ''}`)
await page.waitForFunction(() => window.reel)
const info = await page.evaluate(([c, a]) => window.reel.setup(c, a).then((r) => { window.reel.ready = r; const { frame: _f, ...rest } = r; return rest }), [clipSeconds, +vw / +vh])
console.log(`clip ${clipSeconds.toFixed(2)} s, climb from ${info.offset} s to ${(info.offset + info.climbEnd).toFixed(2)} s, reel ${info.total.toFixed(2)} s at ${info.W}x${info.H}`)

const start = +arg('start', 0), cut = Math.min(+arg('cut', clipSeconds), clipSeconds)
const times = []
for (let t = start; t < cut; t += 1 / FPS) times.push([t, t])
for (let r = info.clip; r <= info.total + 1e-6; r += 1 / FPS) times.push([r, cut - 1 / FPS])
const draw = (r, clipT) => page.evaluate(([r, j]) => window.reel.ready.frame(r, j), [r, jpegAt(clipT)]).then((d) => Buffer.from(d.split(',')[1], 'base64'))

const stills = arg('stills')
if (stills) {
  for (const v of stills.split(',')) {
    const file = out.replace(/\.mp4$/, '') + `-${v}.png`
    if (v.startsWith('c')) {
      const d = await page.evaluate(([p, c]) => window.reel.ready.credits(p, c), [+v.slice(1) / CREDITS, CREDITS])
      fs.writeFileSync(file, Buffer.from(d.split(',')[1], 'base64'))
    } else {
      const r = +v
      fs.writeFileSync(file, await draw(r, r < info.clip ? Math.min(r, cut) : cut - 1 / FPS))
    }
    console.log('wrote', file)
  }
} else {
  const enc = spawn(FFMPEG, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((res, rej) => enc.on('close', (c) => (c ? rej(new Error(`ffmpeg exited ${c}`)) : res())))
  const write = (buf) => new Promise((res) => (enc.stdin.write(buf) ? res() : enc.stdin.once('drain', res)))
  const t0 = Date.now()
  for (const [i, [r, clipT]] of times.entries()) {
    await write(await draw(r, clipT))
    if (i % 60 === 0) process.stdout.write(`\r${i}/${times.length} frames`)
  }
  if (flag('credits')) {
    const n = Math.round(CREDITS * FPS)
    for (let i = 0; i < n; i++) await write(Buffer.from((await page.evaluate(([p, d]) => window.reel.ready.credits(p, d), [i / n, CREDITS])).split(',')[1], 'base64'))
  }
  enc.stdin.end()
  await done
  console.log(`\rwrote ${out}: ${times.length} frames in ${Math.round((Date.now() - t0) / 1000)} s`)
}
await browser.close()
await server.close()
fs.rmSync(tmp, { recursive: true, force: true })
