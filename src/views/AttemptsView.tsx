import { motion } from 'framer-motion'
import { Timer, Trophy, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { MiniRoute } from '../components/MiniRoute'
import { holdLetter } from '../lib/geometry'
import { secs } from '../lib/score'
import { GOLD, ROUTE_COLORS, type Session } from '../lib/types'


export function AttemptsView({ session: s, letters }: { session: Session; letters?: boolean }) {
  const [hover, setHover] = useState<string | null>(null)
  const c = s.comparison
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const L = (id: number) => (letters ? holdLetter(id) : String(id))
  if (!c?.attempts.length) {
    return (
      <div className="empty-state">
        <Waypoints size={28} />
        <h3>One attempt so far</h3>
        <p>When you have more than one attempt on a route, they are compared here.</p>
      </div>
    )
  }
  const attempts = [...c.attempts].sort((a, b) => a.index - b.index)
  const maxT = Math.max(...attempts.map((a) => a.elapsed ?? 0), 1)
  const count = new Map<number, number>()
  for (const a of attempts) for (const id of new Set(a.sequence)) count.set(id, (count.get(id) ?? 0) + 1)
  const uniqueOf = (seq: number[]) => seq.filter((id) => count.get(id) === 1)
  const columns = [...count.keys()].sort((a, b) => a - b)
  const best = attempts.filter((a) => a.elapsed != null).sort((a, b) => a.elapsed! - b.elapsed!)[0]
  const shortest = [...attempts].sort((a, b) => a.sequence.length - b.sequence.length)[0]
  const shared = columns.filter((id) => count.get(id) === attempts.length)
  // One color means one thing: green is this attempt, gray is every other.
  const colorOf = (a: { isThis: boolean }) => (a.isThis ? '#4ADE80' : '#8D949F')

  return (
    <div className="attempts">
      <div className="att-stats">
        {[
          { icon: <Trophy size={16} />, k: 'Fastest send', v: best ? secs(best.elapsed) : '—', sub: best ? `Attempt ${best.index}` : '' },
          { icon: <Waypoints size={16} />, k: 'Fewest holds', v: `${shortest.sequence.length} holds`, sub: `Attempt ${shortest.index}` },
          { icon: <Timer size={16} />, k: 'Average time', v: secs(attempts.reduce((t, a) => t + (a.elapsed ?? 0), 0) / attempts.length), sub: `${attempts.length} attempts` },
          { icon: <span className="dot-route" style={{ background: route }} />, k: 'Used every time', v: `${shared.length} holds`, sub: 'the holds no attempt skipped' },
        ].map((x, i) => (
          <motion.div key={x.k} className="card stat" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
            <span className="stat-k">{x.icon}{x.k}</span>
            <b className="stat-v">{x.v}</b>
            <span className="stat-sub">{x.sub}</span>
          </motion.div>
        ))}
      </div>

      <div className="att-grid">
        <div className="card att-bars">
          <div className="limb-head"><span className="kicker">Time to the top</span></div>
          {attempts.map((a, i) => (
            <div key={a.label} className={`att-bar-row ${a.isThis ? 'this' : ''} ${hover === a.label ? 'hover' : ''}`} onMouseEnter={() => setHover(a.label)} onMouseLeave={() => setHover(null)}>
              <span className="att-name"><i style={{ background: colorOf(a) }} />Attempt {a.index}{a.isThis && <em>this one</em>}</span>
              <span className="att-track">
                <motion.span className="att-fill" style={{ background: colorOf(a) }} initial={{ width: 0 }} animate={{ width: `${((a.elapsed ?? 0) / maxT) * 100}%` }} transition={{ delay: 0.15 + i * 0.08, type: 'spring', stiffness: 120, damping: 20 }} />
              </span>
              <span className="att-val">{secs(a.elapsed)}</span>
              <span className="att-badges">
                {c.fastest === a.label && <span className="badge-gold">Fastest</span>}
                {c.shortest === a.label && <span className="badge-gold">Fewest holds</span>}
              </span>
            </div>
          ))}

          <div className="limb-head" style={{ marginTop: 24 }}><span className="kicker">Hold by hold</span></div>
          <p className="cap">Each column is a hold on the route. The number is when that attempt reached it: 1 is first. Swipe sideways to see them all.</p>
          <div className="matrix-scroll"><div className="matrix" style={{ gridTemplateColumns: `88px repeat(${columns.length}, minmax(28px, 1fr))`, minWidth: 88 + columns.length * 30 }}>
            <span />
            {columns.map((id) => <span key={id} className={`mx-head ${count.get(id) === attempts.length ? 'shared' : ''}`}>{L(id)}</span>)}
            {attempts.map((a, i) => (
              <div key={a.label} className={`mx-row ${hover === a.label ? 'hover' : ''}`} style={{ display: 'contents' }} onMouseEnter={() => setHover(a.label)} onMouseLeave={() => setHover(null)}>
                <span className="mx-label"><i style={{ background: colorOf(a) }} />Attempt {a.index}</span>
                {columns.map((id) => {
                  const k = a.sequence.indexOf(id)
                  const uniq = k >= 0 && count.get(id) === 1
                  return (
                    <motion.span key={id} className={`mx-cell ${k >= 0 ? 'on' : ''}`} style={k >= 0 ? { background: uniq ? GOLD : colorOf(a), color: '#0a0b0d' } : undefined} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.3 + i * 0.05 + columns.indexOf(id) * 0.01 }}>
                      {k >= 0 ? k + 1 : ''}
                    </motion.span>
                  )
                })}
              </div>
            ))}
          </div></div>
          <div className="legend-unique"><span className="sq" /> Gold: only that attempt used this hold</div>
        </div>

        <div className="att-maps">
          {attempts.map((a, i) => (
            <motion.div key={a.label} className={`card att-map ${a.isThis ? 'this' : ''} ${hover === a.label ? 'hover' : ''}`} onMouseEnter={() => setHover(a.label)} onMouseLeave={() => setHover(null)} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.08 }}>
              <div className="att-map-head">
                <span><i style={{ background: colorOf(a) }} />Attempt {a.index}</span>
                <span className="muted xs">{a.sequence.length} holds · {secs(a.elapsed)}</span>
              </div>
              <MiniRoute session={s} sequence={a.sequence} color={colorOf(a)} unique={uniqueOf(a.sequence)} height={230} />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}
