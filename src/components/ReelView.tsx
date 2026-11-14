// The performance reel, playing live: the clip, the wall and the numbers in one
// picture, then the finale. The same drawing code records it to a video file.

import { Download, Loader2, Maximize2, Pause, Play, RectangleHorizontal, RectangleVertical, RotateCcw, Share2, Video } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { download } from '../lib/download'
import { drawReel, prepareReel, REEL_SIZE, type Reel, type ReelFormat } from '../lib/reel'
import type { Timeline } from '../lib/timeline'
import type { Session } from '../lib/types'
import { canExportVideo, exportReel, loadWall, type ReelFile } from '../lib/videoexport'
import { toast } from './Toast'

export function ReelView({ session: s, tl }: { session: Session; tl: Timeline }) {
  const [format, setFormat] = useState<ReelFormat>(() => (window.innerWidth < 760 ? 'portrait' : 'landscape'))
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [playing, setPlaying] = useState(false)
  const [shown, setShown] = useState(0)
  const [reel, setReel] = useState<Reel | null>(null)
  const [saving, setSaving] = useState<number | null>(null)
  const [file, setFile] = useState<ReelFile | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const st = useRef({ r: 0, playing: false })
  const abort = useRef<AbortController | null>(null)
  const v = s.video

  // The clip and the wall plate, then the reel's plan.
  useEffect(() => {
    let live = true
    const el = video.current
    if (!el) return
    const go = async () => {
      const wall = await loadWall(s)
      await document.fonts?.ready
      if (live) { setReel(prepareReel(s, tl, el.duration, wall)); setStatus('ready') }
    }
    const fail = () => live && setStatus('error')
    if (el.readyState >= 2) void go()
    else { el.addEventListener('loadeddata', go, { once: true }); el.addEventListener('error', fail, { once: true }) }
    return () => { live = false; el.removeEventListener('loadeddata', go); el.removeEventListener('error', fail); el.pause(); abort.current?.abort() }
  }, [s, tl])

  // One loop: advance the reel clock, draw the frame.
  useEffect(() => {
    if (!reel) return
    const el = video.current!, cv = canvas.current!
    const ctx = cv.getContext('2d')!
    let raf = 0, last = performance.now(), told = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const x = st.current
      if (x.playing) {
        if (x.r < reel.clip && !el.ended) {
          if (el.paused) void el.play().catch(() => {})
          x.r = Math.min(el.currentTime, reel.clip)
        } else x.r = Math.max(x.r, reel.clip) + dt
        if (x.r >= reel.total) { x.r = reel.total; x.playing = false; setPlaying(false) }
      }
      // Fit the picture inside the stage, whatever shape the stage is.
      const room = cv.parentElement!.getBoundingClientRect()
      const [fw, fh] = REEL_SIZE[format]
      const cssW = Math.floor(Math.min(room.width, (room.height * fw) / fh)), cssH = Math.floor((cssW * fh) / fw)
      if (cv.style.width !== `${cssW}px`) { cv.style.width = `${cssW}px`; cv.style.height = `${cssH}px` }
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr)
      if (!W || !H) return
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H }
      drawReel(ctx, reel, el, el.videoWidth / Math.max(1, el.videoHeight), x.r, W, H)
      if (now - told > 120) { told = now; setShown(x.r) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reel, format])

  const seek = (r: number) => {
    if (!reel) return
    const el = video.current!
    const x = st.current
    x.r = Math.max(0, Math.min(reel.total, r))
    el.currentTime = Math.min(x.r, Math.max(0, reel.clip - 0.04))
    if (x.r >= reel.clip || !x.playing) el.pause()
    setShown(x.r)
  }
  const toggle = () => {
    if (!reel) return
    const x = st.current
    if (x.playing) { x.playing = false; video.current!.pause(); setPlaying(false); return }
    if (x.r >= reel.total - 0.05) seek(0)
    x.playing = true
    setPlaying(true)
    if (x.r < reel.clip) void video.current!.play().catch(() => {})
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, button')) return
      if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); toggle() }
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  })

  const save = async () => {
    if (saving !== null) return
    st.current.playing = false
    video.current?.pause()
    setPlaying(false)
    const ctl = new AbortController()
    abort.current = ctl
    setSaving(0)
    setFile(null)
    try {
      setFile(await exportReel(s, format, { onProgress: setSaving, signal: ctl.signal }))
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'warn')
    } finally {
      setSaving(null)
    }
  }
  const asFile = (f: ReelFile) => new File([f.blob], f.name, { type: f.blob.type })
  const canShare = useMemo(() => Boolean(file && navigator.canShare?.({ files: [asFile(file)] })), [file])
  const share = async () => {
    if (!file) return
    try {
      await navigator.share({ files: [asFile(file)], title: s.title })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') download(file.name, file.blob)
    }
  }

  if (!v?.src) return <div className="empty-state"><Video size={28} /><h3>No clip, no reel</h3><p>The reel is built from the climb’s video.</p></div>
  const fmt = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`
  return (
    <div className="reel">
      <video ref={video} className="reel-src" muted playsInline preload="auto" crossOrigin={v.src.startsWith('blob:') ? undefined : 'anonymous'}>
        <source src={v.src} type={v.src.endsWith('.webm') ? 'video/webm' : 'video/mp4'} />
        {v.webm && <source src={v.webm} type="video/webm" />}
      </video>
      <div className={`reel-stage ${format}`}>
        <canvas ref={canvas} className="reel-canvas" onClick={toggle} />
        {status === 'loading' && <div className="reel-wait"><div className="spinner" /></div>}
        {status === 'error' && <div className="reel-wait"><p className="muted">This browser could not play the clip.</p></div>}
        {status === 'ready' && !playing && shown < 0.05 && <button className="reel-bigplay" onClick={toggle} aria-label="Play"><Play size={30} fill="currentColor" /></button>}
      </div>
      <div className="reel-bar">
        <button className="play" onClick={toggle} disabled={status !== 'ready'} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={18} fill="currentColor" /> : shown >= (reel?.total ?? 1) - 0.05 ? <RotateCcw size={17} /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <input className="reel-scrub" type="range" min={0} max={reel?.total ?? 1} step={0.01} value={shown} onChange={(e) => seek(Number(e.target.value))} disabled={!reel} aria-label="Position" />
        <span className="reel-time">{fmt(shown)} / {fmt(reel?.total ?? 0)}</span>
        <div className="seg" role="group" aria-label="Shape">
          <button className={format === 'landscape' ? 'on' : ''} onClick={() => { setFormat('landscape'); setFile(null) }} title="16:9, for a desktop or TV"><RectangleHorizontal size={15} /><span>Wide</span></button>
          <button className={format === 'portrait' ? 'on' : ''} onClick={() => { setFormat('portrait'); setFile(null) }} title="9:16, for a phone"><RectangleVertical size={15} /><span>Tall</span></button>
        </div>
        <button className="icon-btn reel-full" onClick={() => canvas.current?.requestFullscreen?.()} title="Full screen" aria-label="Full screen"><Maximize2 size={15} /></button>
        {saving !== null ? (
          <button className="btn" onClick={() => abort.current?.abort()}><Loader2 size={15} className="spin" /> {Math.round(saving * 100)}% · Cancel</button>
        ) : file ? (
          <>
            {canShare && <button className="btn primary" onClick={share}><Share2 size={15} /> Share</button>}
            <button className={`btn ${canShare ? '' : 'primary'}`} onClick={() => download(file.name, file.blob)}><Download size={15} /> {(file.blob.size / 1e6).toFixed(1)} MB</button>
          </>
        ) : (
          <button className="btn primary" onClick={save} disabled={status !== 'ready' || !canExportVideo(s)} title="Records the reel to a video file, in real time"><Video size={15} /> Save video</button>
        )}
      </div>
    </div>
  )
}
