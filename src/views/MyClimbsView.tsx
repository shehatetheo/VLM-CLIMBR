import { AnimatePresence, motion } from 'framer-motion'
import { Globe, Lock, Play, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from '../components/Toast'
import { cloudEnabled, deleteClimb, listMyClimbs, setVisibility, type CloudClimb } from '../lib/cloud'
import { coachScore, secs } from '../lib/score'
import { climbStatus, type ClimbStatus } from '../lib/status'
import { deleteSession, listSessions, type StoredSession } from '../lib/store'
import type { Session } from '../lib/types'
import { GlossButton, Logo, SectionHeader, Skyline, StickerBadge } from '../ui'

interface Tile { key: string; open: string; title: string; thumb: string | null; score: number; status: ClimbStatus; time: string; local: StoredSession | null; cloud: CloudClimb | null; example?: boolean }

const tileOf = (s: Session, extra: Partial<Tile>): Tile => ({
  key: s.id, open: `#/session/${encodeURIComponent(s.id)}/results`, title: s.title, thumb: s.video?.poster ?? null, score: coachScore(s).total, status: climbStatus(s).status,
  time: s.toppedOut && s.elapsed != null ? secs(s.elapsed) : 'no top-out', local: null, cloud: null, ...extra,
})

/** Your climbs as a grid of glossy tiles, newest first. */
export function MyClimbsView({ example, go }: { example: Session | null; go: (h: string) => void }) {
  const [tiles, setTiles] = useState<Tile[] | null>(null)
  const [menu, setMenu] = useState<Tile | null>(null)

  const load = useCallback(async () => {
    const [local, cloud] = await Promise.all([listSessions(), cloudEnabled ? listMyClimbs().catch(() => [] as CloudClimb[]) : Promise.resolve([] as CloudClimb[])])
    const byCloud = new Map(cloud.map((c) => [c.id, c]))
    const out: Tile[] = local.map((r) => tileOf(r.session, { local: r, cloud: r.session.cloudId ? byCloud.get(r.session.cloudId) ?? null : null }))
    const seen = new Set(local.map((r) => r.session.cloudId).filter(Boolean))
    // Climbs saved online from another session of this account.
    for (const c of cloud) if (!seen.has(c.id)) out.push({ key: `c-${c.id}`, open: `#/session/c-${c.id}/results`, title: c.title, thumb: c.thumbUrl ?? null, score: c.coach_score, status: c.status, time: secs(c.duration, 1), local: null, cloud: c })
    setTiles(out)
  }, [])
  useEffect(() => { load() }, [load])

  const remove = async (t: Tile) => {
    setMenu(null)
    try {
      if (t.cloud) await deleteClimb(t.cloud)
      if (t.local) await deleteSession(t.local.id)
      toast('Climb deleted')
      load()
    } catch (e) { toast((e as Error).message, 'warn') }
  }
  const share = async (t: Tile, visibility: 'private' | 'public') => {
    setMenu(null)
    if (!t.cloud) { toast('Open the climb and save it online first.'); return }
    try {
      await setVisibility(t.cloud.id, visibility)
      toast(visibility === 'public' ? 'Sent for review. It shows up in the feed once it is approved.' : 'This climb is private again.')
      load()
    } catch (e) { toast((e as Error).message, 'warn') }
  }

  const all = tiles ?? []
  return (
    <section className="screen">
      <div className="wrap">
        <div className="page-head"><Logo height={32} /><GlossButton size="sm" onClick={() => go('#/analyze')}><Upload size={16} /> new climb</GlossButton></div>
        <SectionHeader level={1} title="my climbs" sub="your climbs are saved on this device. accounts are coming soon, so you'll be able to keep them forever." />

        {tiles === null && <div className="tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="tile skel" />)}</div>}
        {tiles !== null && all.length === 0 && (
          <div className="empty">
            <Skyline className="art" />
            <h3>no climbs yet</h3>
            <p>Go send something. Film one attempt and get your first Coach Score.</p>
            <GlossButton size="lg" onClick={() => go('#/analyze')}><Upload size={18} /> analyze a climb</GlossButton>
          </div>
        )}
        {all.length > 0 && (
          <div className="tiles">
            {all.map((t) => (
              <article key={t.key} className="tile">
                <button className="tile-open" onClick={() => go(t.open)} aria-label={`Open ${t.title}`}>
                  {t.thumb ? <img src={t.thumb} alt="" loading="lazy" /> : <span className="tile-blank"><Play size={28} /></span>}
                  <span className="tile-score num">{t.score}</span>
                  <StickerBadge kind={t.status} className="tile-sticker" />
                  <span className="tile-text"><b>{t.title}</b><em>{t.time}{t.cloud?.visibility === 'public' ? (t.cloud.is_approved ? ' · in the feed' : ' · in review') : ''}</em></span>
                </button>
                <button className="tile-more" onClick={() => setMenu(t)} aria-label={`Options for ${t.title}`}>···</button>
              </article>
            ))}
          </div>
        )}

        {example && (
          <>
            <SectionHeader title="example" sub="a real climb, already analyzed, to show you how it works." />
            <div className="rows">
              <button className="row" onClick={() => go(`#/session/${example.id}/results`)}>
                {example.video?.poster && <img className="row-thumb" src={example.video.poster} alt="" />}
                <span className="grow"><b>{example.title}</b><span>{example.route.color} {example.route.grade} · {secs(example.elapsed)}</span></span>
                <StickerBadge kind="example" />
              </button>
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {menu && (
          <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenu(null)}>
            <motion.div className="bsheet glass" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={menu.title}>
              <div className="sheet-head"><h3>{menu.title}</h3><button className="gbtn chrome round sm" onClick={() => setMenu(null)} aria-label="Close"><X size={18} /></button></div>
              <div className="rows">
                <button className="row" onClick={() => { setMenu(null); go(menu.open) }}><Play size={20} /><span className="grow"><b>open</b></span></button>
                {menu.cloud && (menu.cloud.visibility === 'public'
                  ? <button className="row" onClick={() => share(menu, 'private')}><Lock size={20} /><span className="grow"><b>make private</b><span>take it out of the feed</span></span></button>
                  : <button className="row" onClick={() => share(menu, 'public')}><Globe size={20} /><span className="grow"><b>share to the feed</b><span>we check every climb before it shows up</span></span></button>)}
                <button className="row danger" onClick={() => remove(menu)}><Trash2 size={20} /><span className="grow"><b>delete</b><span>this cannot be undone</span></span></button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
