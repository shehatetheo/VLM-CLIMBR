import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, BarChart3, Bug, ChevronLeft, ChevronRight, Clapperboard, Download, Play, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DebugPanel } from '../components/DebugPanel'
import { LivePanel } from '../components/LivePanel'
import { ReelView } from '../components/ReelView'
import { RoutePanel } from '../components/RoutePanel'
import { TimelineBar, type ViewOpts } from '../components/TimelineBar'
import { VideoStage } from '../components/VideoStage'
import type { Health } from '../lib/api'
import { sessionProblem } from '../lib/live'
import { createPlayer, finaleSchedule, usePlayer } from '../lib/player'
import { coachInsights, coachScore, secs, verdict, type BestMove, type Insight } from '../lib/score'
import { getPrefs, setPrefs } from '../lib/store'
import { buildTimeline } from '../lib/timeline'
import { LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type Session } from '../lib/types'
import { PILL_SPRING } from '../ui'
import { ResultsView } from './ResultsView'

type Tab = 'results' | 'replay' | 'reel'
const ALL_TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'results', label: 'breakdown', icon: <BarChart3 size={15} /> },
  { id: 'replay', label: 'replay', icon: <Play size={15} /> },
  { id: 'reel', label: 'reel', icon: <Clapperboard size={15} /> },
]

export function SessionView({ session: s, health, onUpdate, go, initialTab = 'replay' }: { session: Session; health: Health | null; onUpdate: (s: Session) => void; go: (h: string) => void; initialTab?: 'replay' | 'results' }) {
  const tl = useMemo(() => buildTimeline(s), [s])
  const player = useMemo(() => {
    const climbEnd = tl.climbEnd
    const offset = s.video?.offset ?? 0
    const fin = finaleSchedule(climbEnd, s.sequence.length)
    // The whole clip stays reachable, before the start and after the top-out.
    const clipEnd = s.video?.duration ? s.video.duration - offset : -Infinity
    return createPlayer({ start: s.video ? -offset : -0.4, end: Math.max(s.toppedOut ? fin.end : climbEnd + 0.5, clipEnd), climbEnd, offset })
  }, [s, tl])
  useEffect(() => player.run(), [player])
  const ps = usePlayer(player)

  const [tab, setTab] = useState<Tab>(initialTab)
  const TABS = useMemo(() => ALL_TABS.filter((t) => t.id !== 'reel' || s.video?.src), [s])
  useEffect(() => { if (tab !== 'replay') player.pause() }, [tab, player])
  const [opts, setOptsState] = useState<ViewOpts>(() => ({ skeleton: true, backdrop: Boolean(s.wall), letters: getPrefs().letters ?? false }))
  const setOpts = (o: ViewOpts) => { setOptsState(o); setPrefs({ letters: o.letters }) }
  const [debugOpen, setDebugOpen] = useState(false)
  const problem = sessionProblem(s)

  // The score and the one-line verdict lead every view of a climb.
  const score = useMemo(() => coachScore(s), [s])
  const line = useMemo(() => verdict(s, coachInsights(s)), [s])
  // A note picked in Results: the replay jumps to it and shows what to look at.
  const [focus, setFocus] = useState<Insight | null>(null)
  const replayRef = useRef<HTMLDivElement>(null)
  const watch = (t: number) => { setTab('replay'); player.seek(t - 0.8); player.play(); requestAnimationFrame(() => replayRef.current?.scrollTo({ top: 0 })) }
  const pick = (i: Insight) => { setFocus(i); if (i.time != null) watch(i.time); else setTab('replay') }
  // The best move opens the replay just before it happens, with the move highlighted.
  const showBest = (b: BestMove) => {
    if (b.time == null) return
    setFocus({ id: 'best', kind: 'good', title: b.title, body: b.body, time: b.time, holds: b.holds, limbs: b.limbs, cost: 0 })
    watch(b.time - 0.2)
  }
  const clearFocus = () => setFocus(null)
  const done = s.toppedOut && ps.t >= tl.climbEnd

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      if (e.code === 'Space') { e.preventDefault(); player.toggle() }
      else if (e.key === 'ArrowRight') player.seek(player.get().t + (e.shiftKey ? 2 : 0.5))
      else if (e.key === 'ArrowLeft') player.seek(player.get().t - (e.shiftKey ? 2 : 0.5))
      else if (['1', '2', '3'].includes(e.key) && TABS[Number(e.key) - 1]) setTab(TABS[Number(e.key) - 1].id)
      else if (e.key.toLowerCase() === 'e' && TABS.some((x) => x.id === 'reel')) setTab('reel')
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [player, TABS])

  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green

  return (
    <motion.section className="session" style={{ ['--route' as string]: route }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      <div className="session-head">
        <button className="gbtn chrome round sh-back" onClick={() => go(s.id.startsWith('example') ? '#/' : '#/climbs')} aria-label="Back"><ChevronLeft size={22} /></button>
        <div className="sh-title">
          <h1>{s.title}</h1>
          <div className="sh-meta">
            <span className="gpill"><i style={{ background: route }} />{s.route.color}{s.route.grade ? ` · ${s.route.grade}` : ''}</span>
            {s.kind === 'example' && <span className="sticker example">example</span>}
          </div>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t, i) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)} title={`${t.label} (${i + 1})`}>
              {tab === t.id && <motion.i layoutId="tab-pill" className="tab-pill" transition={PILL_SPRING} />}
              <span className="tab-inner">{t.icon}{t.label}</span>
            </button>
          ))}
        </div>
        <div className="sh-actions">
          {import.meta.env.DEV && s.analysis && <button className="btn ghost" onClick={() => setDebugOpen((o) => !o)} title="Run details (development only)"><Bug size={15} /> Debug</button>}
          {s.video?.src && <button className="gbtn chrome round" onClick={() => setTab('reel')} aria-label="Export the performance reel"><Download size={18} /></button>}
        </div>
      </div>
      {problem && (
        <div className="banner warn"><AlertTriangle size={15} /><span>{problem}</span><a className="link" href="#/import">Re-import</a></div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {tab === 'results' && (
          <motion.div key="results" className="tab-body scroll" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <ResultsView session={s} tl={tl} health={health} onUpdate={onUpdate} onPick={pick} onSeek={watch} onBest={showBest} />
          </motion.div>
        )}
        {tab === 'replay' && (
          <motion.div key="replay" ref={replayRef} className="replay dark" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            {focus ? (
              <div className="focus-note" role="status">
                <span className="fn-text">
                  <b>{focus.title}</b>
                  {focus.tip && <span>{focus.tip}</span>}
                  {focus.limbs?.length ? <span className="fn-limbs">{focus.limbs.map((l) => <i key={l} style={{ background: LIMB_BY_KEY[l].color }}>{LIMB_BY_KEY[l].name}</i>)}</span> : null}
                </span>
                <button className="icon-btn" onClick={clearFocus} aria-label="Dismiss this note"><X size={18} /></button>
              </div>
            ) : !problem && (
              <button className="coach-strip" onClick={() => setTab('results')}>
                <span className="cs-score">{score.total}</span>
                <span className="cs-text"><em>{done ? `Topped out in ${secs(s.elapsed)}` : `Coach Score · ${score.label}`}</em><b>{line}</b></span>
                <span className="cs-go" aria-hidden><ChevronRight size={18} /></span>
              </button>
            )}
            <div className="stage">
              <VideoStage session={s} player={player} tl={tl} t={ps.t} focusLimbs={focus?.limbs} focusHolds={focus?.holds} />
              <div className="route-wrap panel">
                <div className="panel-label">
                  <span className="eyebrow">Route map</span>
                  <span className="eyebrow dim">{s.sequence.length} of {s.holdsDetected} holds used</span>
                </div>
                <RoutePanel session={s} tl={tl} t={ps.t} letters={opts.letters} backdrop={opts.backdrop} skeleton={opts.skeleton} highlight={focus?.holds ?? []} focusLimbs={focus?.limbs} onSeek={(t) => player.seek(t)} />
                <div className="legend">
                  {LIMBS.map((l) => <span key={l.key}><i style={{ background: l.color }} />{l.name}</span>)}
                  <span><i className="body-dot" />body</span>
                </div>
              </div>
              <LivePanel session={s} tl={tl} t={ps.t} letters={opts.letters} onSeek={(t) => player.seek(t)} />
            </div>
            <TimelineBar session={s} tl={tl} player={player} ps={ps} opts={opts} setOpts={setOpts} />
          </motion.div>
        )}
        {tab === 'reel' && (
          <motion.div key="reel" className="tab-body dark reel-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <ReelView session={s} tl={tl} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{debugOpen && s.analysis && <DebugPanel session={s} onClose={() => setDebugOpen(false)} />}</AnimatePresence>
    </motion.section>
  )
}
