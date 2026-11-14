import { AnimatePresence, motion } from 'framer-motion'
import { Bookmark, CloudOff, Eye, EyeOff, Flag, HandMetal, ListTree, Play, RotateCcw, Video, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../components/Toast'
import { VideoOverlay } from '../components/VideoOverlay'
import { cloudEnabled, fetchFeed, loadCloudSession, reportClimb, toggleProps, toggleSave, type CloudClimb, type ReportReason } from '../lib/cloud'
import { bestMove, coachInsights, coachScore, secs } from '../lib/score'
import { pop } from '../lib/sound'
import { climbStatus } from '../lib/status'
import { buildTimeline } from '../lib/timeline'
import { ROUTE_COLORS, type Session } from '../lib/types'
import { EmptyIcon, GlossPill, Logo, ScoreBadge, StickerBadge } from '../ui'

interface Entry { key: string; climb: CloudClimb | null; session: Session | null }

/** One climb per screen, like a reel: swipe up for the next. Plays muted while
 *  it is on screen, with the analysis drawn live on top. */
export function FeedView({ example, go }: { example: Session | null; go: (h: string) => void }) {
  const [tab, setTab] = useState<'foryou' | 'saved'>('foryou')
  const [entries, setEntries] = useState<Entry[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [active, setActive] = useState(0)
  const busy = useRef(false)

  const load = useCallback(async (cursor: string | null) => {
    if (busy.current) return
    busy.current = true
    try {
      if (!cloudEnabled) { setEntries([]); setNext(null); setState('ready'); return }
      const page = await fetchFeed({ cursor, saved: tab === 'saved' })
      const fresh = page.items.map((c) => ({ key: c.id, climb: c, session: null }))
      setEntries((old) => (cursor ? [...old, ...fresh] : fresh))
      setNext(page.next)
      setState('ready')
    } catch {
      setState(cursor ? 'ready' : 'error')
    } finally { busy.current = false }
  }, [tab])
  useEffect(() => { setState('loading'); setActive(0); load(null) }, [load])

  // The bundled example leads "for you" until the database has its own seeded examples.
  const list = useMemo(() => {
    const hasSeeded = entries.some((e) => e.climb?.is_example)
    const lead = tab === 'foryou' && example && !hasSeeded ? [{ key: 'example', climb: null, session: example }] : []
    return [...lead, ...entries]
  }, [entries, example, tab])
  useEffect(() => { if (next && active >= list.length - 2) load(next) }, [active, list.length, next, load])

  const patch = (key: string, p: Partial<Entry>) => setEntries((xs) => xs.map((e) => (e.key === key ? { ...e, ...p } : e)))

  return (
    <section className="feed dark">
      <header className="feed-top">
        <Logo height={30} />
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'foryou'} className={tab === 'foryou' ? 'on' : ''} onClick={() => setTab('foryou')}>for you</button>
          <button role="tab" aria-selected={tab === 'saved'} className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>saved</button>
        </div>
        <span aria-hidden />{/* keeps the tabs centered */}
      </header>

      <div className="feed-scroll">
        {state === 'loading' && <div className="feed-card"><div className="feed-skel"><span /><span /><span /></div></div>}
        {state === 'error' && (
          <div className="feed-card"><div className="feed-msg"><EmptyIcon icon={CloudOff} /><h3>the feed is taking a rest</h3><p>We could not load it. Check your connection and try again.</p><button className="gbtn" onClick={() => { setState('loading'); load(null) }}>try again</button></div></div>
        )}
        {state === 'ready' && list.length === 0 && (
          <div className="feed-card"><div className="feed-msg">
            <EmptyIcon icon={tab === 'saved' ? Bookmark : Video} />
            <h3>{tab === 'saved' ? 'nothing saved yet' : 'no climbs here yet'}</h3>
            <p>{tab === 'saved' ? 'Tap the bookmark on a climb to keep it here.' : 'Be the first: analyze a climb and share it.'}</p>
            <button className="gbtn" onClick={() => (tab === 'saved' ? setTab('foryou') : go('#/analyze'))}>{tab === 'saved' ? 'back to the feed' : 'analyze a climb'}</button>
          </div></div>
        )}
        {state === 'ready' && list.map((e, i) => (
          <FeedCard key={e.key} entry={e} index={i} active={active === i} near={Math.abs(active - i) <= 2} onActive={setActive} onSession={(s) => patch(e.key, { session: s })} onClimb={(c) => patch(e.key, { climb: c })} go={go} />
        ))}
      </div>
    </section>
  )
}

function FeedCard({ entry, index, active, near, onActive, onSession, onClimb, go }: { entry: Entry; index: number; active: boolean; near: boolean; onActive: (i: number) => void; onSession: (s: Session) => void; onClimb: (c: CloudClimb) => void; go: (h: string) => void }) {
  const { climb, session: s } = entry
  const root = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [t, setT] = useState(0)
  const [paused, setPaused] = useState(false)
  const [overlays, setOverlays] = useState(true)
  const [sheet, setSheet] = useState(false)
  const [reporting, setReporting] = useState(false)

  // Which card is on screen.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.intersectionRatio > 0.6 && onActive(index), { threshold: [0.6] })
    io.observe(el)
    return () => io.disconnect()
  }, [index, onActive])
  // The analysis loads only for the card on screen and its neighbours.
  useEffect(() => {
    if (!near || s || !climb) return
    let live = true
    loadCloudSession(climb.id).then((x) => live && x && onSession(x)).catch(() => {})
    return () => { live = false }
  }, [near, s, climb, onSession])
  // Play in view, pause out of view.
  useEffect(() => {
    const v = video.current
    if (!v) return
    if (active && !paused && !sheet) v.play().catch(() => {})
    else v.pause()
    if (!active) { setSheet(false); setReporting(false) }
  }, [active, paused, sheet])
  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => { const v = video.current; if (v) setT(v.currentTime); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  const tl = useMemo(() => (s ? buildTimeline(s) : null), [s])
  const score = useMemo(() => (s ? coachScore(s) : null), [s])
  const status = useMemo(() => (s ? climbStatus(s).status : climb?.status ?? 'unclear'), [s, climb])
  const best = useMemo(() => (s ? bestMove(s) : null), [s])
  const notes = useMemo(() => (s ? coachInsights(s).filter((i) => i.kind !== 'unsure').slice(0, 3) : []), [s])
  const src = s?.video?.src || climb?.videoUrl || ''
  const poster = s?.video?.poster || climb?.thumbUrl || undefined
  const offset = s?.video?.offset ?? 0
  const routeColor = s?.route.color ?? climb?.route_color ?? 'green'
  const total = score?.total ?? climb?.coach_score ?? 0
  const isExample = climb ? climb.is_example : true
  const openId = climb ? `c-${climb.id}` : s?.id

  const act = async (kind: 'props' | 'save') => {
    if (!climb) { toast('That is the built-in example. Props and saves work on shared climbs.'); return }
    const on = kind === 'props' ? !climb.propped : !climb.saved
    const count = Math.max(0, (Number(climb.props) || 0) + (on ? 1 : -1))
    onClimb({ ...climb, ...(kind === 'props' ? { propped: on, props: count ? String(count) : null } : { saved: on }) })
    if (on) pop()
    try { await (kind === 'props' ? toggleProps(climb.id, on) : toggleSave(climb.id, on)) } catch (e) {
      onClimb(climb)
      toast((e as Error).message, 'warn')
    }
  }
  const report = async (reason: ReportReason) => {
    setReporting(false)
    if (!climb) return
    try { await reportClimb(climb.id, reason); toast('Thanks. We will take a look.') } catch (e) { toast((e as Error).message, 'warn') }
  }
  const watchAgain = () => {
    const v = video.current
    if (!v) return
    setSheet(false); setPaused(false)
    v.currentTime = 0
    v.play().catch(() => {})
  }

  return (
    <article className="feed-card" ref={root} aria-label={`${climb?.username ?? s?.climber ?? 'A climber'}'s climb`}>
      {near && src ? (
        <video ref={video} src={src} poster={poster} muted playsInline preload={active ? 'auto' : 'metadata'} onClick={() => setPaused((p) => !p)} onEnded={() => setSheet(true)} />
      ) : poster ? <img src={poster} alt="" /> : <div className="feed-skel"><span /><span /><span /></div>}
      {overlays && s && tl && active && <VideoOverlay session={s} tl={tl} t={t - offset} fit="cover" />}
      {paused && active && !sheet && <button className="feed-play" onClick={() => setPaused(false)} aria-label="Play"><Play size={36} fill="currentColor" /></button>}

      <div className="feed-info">
        <div className="feed-who">
          <ScoreBadge value={total} size={64} animate={false} />
          <div>
            <b>{climb?.username ?? 'CLIMBR'}</b>
            <span>{climb?.title ?? s?.title ?? ''}</span>
          </div>
        </div>
        <div className="feed-tags">
          {isExample && <StickerBadge kind="example" />}
          <StickerBadge kind={status} />
          <GlossPill dot={ROUTE_COLORS[routeColor]}>{routeColor}</GlossPill>
        </div>
        <button className="gbtn sm" onClick={() => setSheet(true)}><ListTree size={16} /> breakdown</button>
      </div>

      <div className="feed-rail">
        <button className={climb?.propped ? 'on' : ''} onClick={() => act('props')} aria-pressed={Boolean(climb?.propped)} aria-label="Give props"><HandMetal size={24} /><span>{climb?.props ?? 'props'}</span></button>
        <button className={climb?.saved ? 'on' : ''} onClick={() => act('save')} aria-pressed={Boolean(climb?.saved)} aria-label="Save this climb"><Bookmark size={24} fill={climb?.saved ? 'currentColor' : 'none'} /><span>save</span></button>
        <button onClick={() => setOverlays((x) => !x)} aria-pressed={overlays} aria-label={overlays ? 'Hide the overlays' : 'Show the overlays'}>{overlays ? <Eye size={24} /> : <EyeOff size={24} />}<span>overlay</span></button>
        {climb && !climb.mine && <button onClick={() => setReporting(true)} aria-label="Report this climb"><Flag size={22} /><span>report</span></button>}
      </div>

      <AnimatePresence>
        {reporting && (
          <motion.div className="feed-sheet glass" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}>
            <div className="sheet-head"><h3>report this climb</h3><button className="gbtn chrome round sm" onClick={() => setReporting(false)} aria-label="Close"><X size={18} /></button></div>
            <div className="rows">
              <button className="row" onClick={() => report('not_climbing')}><span className="grow"><b>not a climbing video</b></span></button>
              <button className="row" onClick={() => report('inappropriate')}><span className="grow"><b>inappropriate</b></span></button>
              <button className="row" onClick={() => report('other')}><span className="grow"><b>something else</b></span></button>
            </div>
          </motion.div>
        )}
        {sheet && (
          <motion.div className="feed-sheet glass" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}>
            <div className="sheet-head"><h3>breakdown</h3><button className="gbtn chrome round sm" onClick={() => setSheet(false)} aria-label="Close"><X size={18} /></button></div>
            <div className="sheet-score">
              <ScoreBadge value={total} size={88} animate={false} />
              <ul>{(score?.parts ?? climb?.sub_scores ?? []).map((p) => <li key={p.key}><span>{p.label}</span><span className="sbar"><i style={{ width: `${p.value}%` }} /></span><b className="num">{p.value}</b></li>)}</ul>
            </div>
            {(best ?? climb?.highlight) && <div className="sheet-note best"><em>best move</em><b>{(best ?? climb!.highlight!).title}</b><span>{(best ?? climb!.highlight!).body}</span></div>}
            {notes.filter((n) => n.kind === 'fix').slice(0, 2).map((n) => <div key={n.id} className="sheet-note"><em>{n.time != null ? `at ${secs(n.time, 1)}` : 'to work on'}</em><b>{n.title}</b>{n.tip && <span>{n.tip}</span>}</div>)}
            <div className="sheet-actions">
              <button className="gbtn" onClick={watchAgain}><RotateCcw size={16} /> watch it again</button>
              {openId && <button className="gbtn chrome" onClick={() => go(`#/session/${encodeURIComponent(openId)}/results`)}>full breakdown</button>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  )
}
