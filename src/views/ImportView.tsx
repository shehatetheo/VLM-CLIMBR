import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, FileVideo, Loader2, RotateCcw, SearchX, Sparkles, TriangleAlert, Upload, X, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ConnectKey } from '../components/ConnectKey'
import { toast } from '../components/Toast'
import { readRoute, type Reading } from '../lib/analyze'
import { analyzeLive, keepMedia, reportRun, STAGE_KEYS, StageError, type Health, type StageEvent, type StageKey } from '../lib/api'
import { requestVlmCoach } from '../lib/coach'
import { clipFrom, filesFromDataTransfer, fmtBytes, isVideo, videoMeta, type Clip } from '../lib/importers'
import { failedChecks, sessionFromLive } from '../lib/live'
import { getPrefs, saveSession } from '../lib/store'
import { ROUTE_COLORS, type Check, type Session } from '../lib/types'
import { EmptyIcon, Logo, RingBurst, SectionHeader } from '../ui'
import { buildWallPlate } from '../lib/wallplate'

const GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7+']

// ── the run, as a state machine ─────────────────────────────────────────────
// uploading → extracting_frames → segmenting ‖ estimating_pose → analyzing_moves
// → (coaching) → complete. Any stage can end it in `error`; a run that worked
// but found nothing to read ends in `empty`, which is not a failure.
type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'
interface StageState { status: StageStatus; detail?: string; progress?: number }
type Phase = StageKey | 'complete' | 'empty' | 'error'
interface Run {
  phase: Phase
  stages: Record<StageKey, StageState>
  started: number
  finished?: number
  clip: Clip
  error?: { stage: StageKey | null; message: string; checks?: Check[] }
  empty?: string
  debug?: string | null
}

const fresh = (clip: Clip): Run => ({
  phase: 'uploading',
  stages: Object.fromEntries(STAGE_KEYS.map((k) => [k, { status: k === 'uploading' ? 'running' : 'pending' }])) as Run['stages'],
  started: Date.now(),
  clip,
})

export function ImportView({ health, onHealth, onSession }: { health: Health | null; onHealth: (h: Health) => void; onSession: (s: Session) => void }) {
  const prefs = getPrefs()
  const [clip, setClip] = useState<Clip | null>(null)
  const [drag, setDrag] = useState(false)
  const [title, setTitle] = useState('')
  const climber = prefs.username ?? 'climber'
  const [color, setColor] = useState(prefs.color ?? 'green')
  const [grade, setGrade] = useState(prefs.grade ?? 'V0')
  const [run, setRun] = useState<Run | null>(null)
  const abort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)


  const add = async (files: File[]) => {
    const video = files.find(isVideo)
    if (!video) {
      if (files.length) toast('CLIMBR reads a video of the climb: .mov, .mp4 or .webm', 'warn')
      return
    }
    const c = clipFrom(video)
    setClip(c)
    const meta = await videoMeta(c.url)
    setClip((cur) => (cur?.id === c.id ? { ...c, meta } : cur))
  }

  const patch = (fn: (r: Run) => Run) => setRun((r) => (r ? fn(r) : r))
  const stage = (k: StageKey, s: Partial<StageState>) => patch((r) => {
    const stages = { ...r.stages, [k]: { ...r.stages[k], ...s } }
    // The phase is the furthest stage under way.
    const running = STAGE_KEYS.filter((x) => stages[x].status === 'running')
    return { ...r, stages, phase: running.length ? running[running.length - 1] : r.phase }
  })

  const maxSeconds = health?.analysis?.maxSeconds ?? 120
  const tooLong = clip?.meta ? clip.meta.dur > maxSeconds : false
  const start = async () => {
    if (!clip || tooLong) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setRun(fresh(clip))
    let current: StageKey = 'uploading'
    const onEvent = (e: StageEvent) => {
      if (e.stage !== 'uploading') stage('uploading', { status: 'done', progress: 1 })
      current = e.stage
      stage(e.stage, { status: e.status, detail: e.detail?.replace(/^(SAM 3\.1|ViTPose\+)\s*·\s*/, '') ?? undefined, progress: e.progress })
    }
    try {
      const r = await analyzeLive(clip.file, { color, health }, onEvent, (p) => stage('uploading', { progress: p, detail: `${Math.round(p * 100)}% of ${fmtBytes(clip.size)}` }), ctl.signal)
      patch((x) => ({ ...x, debug: r.debug }))
      // The server reads the color the climber was actually on, if it was plainly not the one picked.
      const routeColor = r.color || color

      // ── analyzing_moves: the route reader, then every number checked ──
      current = 'analyzing_moves'
      stage('analyzing_moves', { status: 'running', detail: 'Working out which holds you used, and when' })
      await new Promise((res) => setTimeout(res, 50))
      let reading: Reading
      try {
        reading = readRoute({ sam: r.sam, pose: r.pose, frame: { width: r.analysis.width, height: r.analysis.height, duration: r.analysis.duration }, color: routeColor })
      } catch (e) {
        throw new StageError((e as Error).message, 'analyzing_moves')
      }
      if (reading.outcome !== 'ok') {
        const why = reading.outcome === 'no-holds'
          ? `We could not find any ${routeColor} holds in this clip. Check the route color you picked, film close enough that the holds are easy to see, and avoid dim or strongly colored lighting.`
          : `We found the ${routeColor} holds but could not see a climber on them. Keep your whole body in the frame, and film from behind or from the side.`
        stage('analyzing_moves', { status: 'done', detail: reading.outcome === 'no-holds' ? `0 ${routeColor} holds` : 'no climber' })
        reportRun(r.id, { status: 'empty', outcome: reading.outcome, summary: reading.stats, warnings: reading.warnings })
        patch((x) => ({ ...x, phase: 'empty', empty: why, finished: Date.now() }))
        return
      }
      const s = sessionFromLive(r, reading, { title, climber: getPrefs().username ?? climber, color: routeColor, grade }, await keepMedia(r.playback, health))
      const bad = failedChecks(s.analysis!.validation)
      reportRun(r.id, { status: bad.length ? 'invalid' : 'valid', summary: reading.stats, validation: s.analysis!.validation, warnings: s.analysis!.warnings, session: { duration: s.duration, offset: s.video!.offset, canvas: s.canvas, holds: s.holds.length, moves: s.moves.length, sequence: s.sequence, elapsed: s.elapsed } })
      if (bad.length) throw Object.assign(new StageError(`The result failed ${bad.length} check${bad.length > 1 ? 's' : ''}, so it was not opened.`, 'analyzing_moves'), { checks: bad })
      const plate = await buildWallPlate(s)
      if (plate) s.wall = { src: plate, affine: [[1, 0, 0], [0, 1, 0]] }
      stage('analyzing_moves', { status: 'done', detail: `${s.holds.length} holds · ${s.moves.length} moves · ${s.toppedOut ? `topped out in ${s.elapsed!.toFixed(2)}s` : 'no top-out'}` })

      // ── coaching: optional. A coach that cannot answer does not sink the run. ──
      current = 'coaching'
      stage('coaching', { status: 'running', detail: 'The AI coach looks at 8 frames of your clip' })
      try {
        const fb = await requestVlmCoach(s, ctl.signal)
        s.coach = fb
        stage('coaching', { status: 'done', detail: `“${fb.headline}”` })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        stage('coaching', { status: 'skipped', detail: `Skipped: ${(e as Error).message}. You can ask again from Results.` })
      }

      const saved = await saveSession(s)
      if (!saved) toast('Could not save to this browser (storage is blocked); the replay still opens.', 'warn')
      patch((x) => ({ ...x, phase: 'complete', finished: Date.now() }))
      await new Promise((res) => setTimeout(res, 900))
      setRun(null)
      if (routeColor !== color) toast(`Read as a ${routeColor} route: you picked ${color}, but your hands and feet were on ${routeColor} holds.`)
      onSession(s)
    } catch (e) {
      if ((e as Error).name === 'AbortError') { setRun(null); return }
      const err = e as StageError & { checks?: Check[] }
      const failed = err.stage ?? current
      stage(failed, { status: 'error', detail: err.message })
      patch((x) => ({ ...x, phase: 'error', finished: Date.now(), error: { stage: failed, message: err.message, checks: err.checks } }))
    }
  }

  const ready = Boolean(clip && health?.connected && health.ffmpeg !== false && (health.platform !== 'vercel' || health.uploads === 'blob'))

  const pick = () => fileInput.current?.click()
  const status = !clip ? 'choose a video to start' : tooLong ? 'this clip is too long' : ready ? 'ready when you are' : health === null ? 'checking the coach…' : 'the coach is not connected yet'
  return (
    <section className="screen"
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
      onDrop={async (e) => { e.preventDefault(); setDrag(false); add(await filesFromDataTransfer(e.dataTransfer)) }}>
      <div className="wrap">
        <div className="page-head"><Logo height={32} /></div>
        <SectionHeader level={1} title="analyze" sub="film one attempt, then let the coach break it down." />

        {/* the one big action: a glossy round button on a speaker-cone ring burst */}
        <div className={`go ${drag ? 'drag' : ''}`}>
          <RingBurst className="go-rings" rings={6} />
          <button className="gbtn go-btn" onClick={clip && ready && !tooLong ? start : pick} disabled={Boolean(clip) && (!ready || tooLong)}>
            {clip ? <><Sparkles size={26} /><span>analyze</span></> : <><Upload size={26} /><span>choose a video</span></>}
          </button>
        </div>
        <input ref={fileInput} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
        <p className="go-status" role="status">{status}</p>
        {clip && (
          <div className="row clip-row">
            <FileVideo size={22} />
            <span className="grow"><b>{clip.name}</b><span>{clip.meta ? `${clip.meta.dur.toFixed(1)}s · ` : ''}{fmtBytes(clip.size)}</span></span>
            <button className="gbtn chrome round sm" onClick={() => setClip(null)} aria-label="Remove this video"><X size={16} /></button>
          </div>
        )}
        {tooLong && <p className="panel fix-note">Your clip is {Math.round(clip!.meta!.dur)} seconds and CLIMBR reads up to {maxSeconds / 60} minutes. Trim it to one attempt in your Photos app, then choose it again.</p>}
        {clip && health?.connected && health.ffmpeg === false && <p className="panel fix-note">The server is missing its video tools. Run npm install and restart it.</p>}
        {clip && health?.connected && health.platform === 'vercel' && health.uploads !== 'blob' && <p className="panel fix-note">Video uploads are not set up on the server yet (it needs a Blob store).</p>}

        <div className="panel">
          <SectionHeader onPanel title="your route" sub="pick the color of the holds you climbed." />
          <div className="swatches big" role="radiogroup" aria-label="Route color">
            {Object.entries(ROUTE_COLORS).map(([k, v]) => (
              <button key={k} role="radio" aria-checked={color === k} className={`swatch ${color === k ? 'on' : ''}`} style={{ background: v }} onClick={() => setColor(k)} aria-label={k} title={k} />
            ))}
          </div>
          <div className="field"><span>Grade</span>
            <div className="grades big">{GRADES.map((g) => <button key={g} className={grade === g ? 'on' : ''} aria-pressed={grade === g} onClick={() => setGrade(g)}>{g}</button>)}</div>
          </div>
          <label className="field"><span>Name this climb (optional)</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. the green slab" maxLength={40} /></label>
        </div>

        <div className="panel glass tips">
          <SectionHeader onPanel title="filming tips" />
          <ul className="ob-bullets">
            <li><CheckCircle2 size={16} /> Prop your phone or hand it to a friend</li>
            <li><CheckCircle2 size={16} /> Keep the whole route and your whole body in the frame</li>
            <li><CheckCircle2 size={16} /> One attempt per clip, under two minutes</li>
            <li><CheckCircle2 size={16} /> Keep filming until you are back on the ground</li>
          </ul>
        </div>

        {health && !health.connected && health.ok && <div className="panel"><ConnectKey health={health} onConnected={onHealth} /></div>}
        {health && !health.ok && <p className="panel fix-note">The CLIMBR server is not reachable right now. Try again in a minute.</p>}
      </div>

      <AnimatePresence>{run && <AnalyzeOverlay run={run} onRetry={start} onClose={() => { abort.current?.abort(); setRun(null) }} />}</AnimatePresence>
    </section>
  )
}

const STAGES: { key: StageKey; label: string; model?: string }[] = [
  { key: 'uploading', label: 'uploading your clip' },
  { key: 'extracting_frames', label: 'reading the video', model: '10 frames a second' },
  { key: 'segmenting', label: 'finding holds…', model: 'every hold of your color' },
  { key: 'estimating_pose', label: 'tracking your moves…', model: 'hands, feet and body' },
  { key: 'analyzing_moves', label: 'reading the route', model: 'on this device' },
  { key: 'coaching', label: 'writing your breakdown…', model: 'AI coach notes · optional' },
]

function AnalyzeOverlay({ run, onRetry, onClose }: { run: Run; onRetry: () => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(id) }, [])
  const elapsed = ((run.finished ?? now) - run.started) / 1000
  const failed = run.phase === 'error', empty = run.phase === 'empty', done = run.phase === 'complete'
  return (
    <motion.div className="analyze" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className={`analyze-card glass ${failed ? 'failed' : ''}`} initial={{ y: 40 }} animate={{ y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}>
        {failed || empty ? <EmptyIcon icon={failed ? TriangleAlert : SearchX} className="analyze-oops" /> : (
          <div className={`pulse-hold ${done ? 'still' : ''}`} aria-hidden>
            <i /><i /><i />
            <img src="/icons/icon-192.png" alt="" />
          </div>
        )}
        <div className="analyze-body">
          <span className="kicker">{failed ? 'Stopped' : empty ? 'Finished' : done ? 'Done' : 'Analyzing'} · {elapsed.toFixed(1)}s</span>
          <h2>{failed ? 'that did not work' : empty ? 'we could not read this clip' : done ? 'your breakdown is ready' : 'analyzing your climb'}</h2>
          <ul className="stages">
            {STAGES.map((st) => {
              const s = run.stages[st.key]
              const shown = s.status === 'pending' && (failed || empty) ? 'not run' : null
              return (
                <li key={st.key} className={s.status}>
                  <span className="st-icon">{s.status === 'done' ? <CheckCircle2 size={17} /> : s.status === 'running' ? <Loader2 size={17} className="spin" /> : s.status === 'error' ? <XCircle size={17} /> : s.status === 'skipped' ? <SearchX size={17} /> : <span className="st-dot" />}</span>
                  <span className="st-text">
                    <b>{st.label}</b>
                    <em>{shown ?? s.detail ?? st.model ?? ''}</em>
                    {s.status === 'running' && s.progress != null && st.key !== 'coaching' && <span className="st-bar"><i style={{ width: `${s.progress * 100}%` }} /></span>}
                  </span>
                </li>
              )
            })}
          </ul>
          {failed && run.error?.checks && (
            <ul className="failed-checks">{run.error.checks.map((c) => <li key={c.id}><b>{c.label}</b> — {c.detail}</li>)}</ul>
          )}
          {empty && <p className="muted empty-note">{run.empty}</p>}
          <div className="analyze-actions">
            {(failed || empty) && <button className="gbtn" onClick={onRetry}><RotateCcw size={16} /> try again</button>}
            <button className="gbtn chrome" onClick={onClose}>{failed || empty ? 'close' : 'cancel'}</button>
            {import.meta.env.DEV && run.debug && <a className="link debug-link" href={run.debug} target="_blank" rel="noreferrer">debug log</a>}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
