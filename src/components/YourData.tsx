import { secs } from '../lib/score'
import type { Timeline } from '../lib/timeline'
import { LIMBS, LIMB_BY_KEY, type Session } from '../lib/types'
import { AttemptsView } from '../views/AttemptsView'

const PX_PER_SECOND = 44 // wide enough that a one-second hold can carry its number

/** The detailed views, each with one line on how to read it. */
export function YourData({ session: s, tl, onSeek }: { session: Session; tl: Timeline; onSeek: (t: number) => void }) {
  const T = tl.climbEnd
  const width = Math.max(320, Math.ceil(T * PX_PER_SECOND))
  const step = T > 40 ? 10 : T > 16 ? 5 : T > 8 ? 2 : 1
  const ticks = Array.from({ length: Math.floor(T / step) + 1 }, (_, i) => i * step)
  const order = s.sequence
  const meters = s.scale?.metersPerUnit
  const ys = s.holds.filter((h) => order.includes(h.id)).map((h) => h.center[1])
  const xs = s.holds.filter((h) => order.includes(h.id)).map((h) => h.center[0])
  const aspect = s.canvas.width / s.canvas.height

  return (
    <div className="data">
      <section className="panel">
        <h4>Time on holds</h4>
        <p className="cap">How much of the climb each hand and foot was on a hold. A low number means that limb was hanging or moving.</p>
        {LIMBS.map((l) => {
          const cov = tl.coverageAt(l.key, T)
          return (
            <div key={l.key} className="d-row">
              <span className="d-name"><i style={{ background: l.color }} />{l.name}</span>
              <span className="d-bar"><i style={{ width: `${cov * 100}%`, background: l.color }} /></span>
              <b>{Math.round(cov * 100)}%</b>
            </div>
          )
        })}
      </section>

      <section className="panel">
        <h4>Limb timeline</h4>
        <p className="cap">One row per hand and foot. Each bar is the time it spent on one hold; the number is the hold. Swipe sideways to see the whole climb.</p>
        <div className="lanes-scroll" tabIndex={0} role="group" aria-label="Limb timeline, scrolls sideways">
          <div className="lanes" style={{ width }}>
            <div className="lane-axis">{ticks.map((t) => <span key={t} style={{ left: `${(t / T) * 100}%` }}>{t}s</span>)}</div>
            {LIMBS.map((l) => (
              <div key={l.key} className="d-lane">
                {tl.intervals[l.key].filter((iv) => iv.start < T).map((iv, i) => {
                  const w = ((Math.min(iv.end, T) - iv.start) / T) * width
                  return (
                    <button key={i} className="d-bar-iv" style={{ left: `${(iv.start / T) * 100}%`, width: Math.max(3, w), background: l.color }} onClick={() => onSeek(iv.start)} aria-label={`${l.name} on hold ${iv.holdId} at ${secs(iv.start, 1)}`}>
                      {w >= 20 && iv.holdId}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="legend compact">{LIMBS.map((l) => <span key={l.key}><i style={{ background: l.color }} />{l.name}</span>)}</div>
      </section>

      <section className="panel">
        <h4>Which holds each limb used</h4>
        <p className="cap">The holds each hand and foot touched, in order. The numbers are hold numbers; tap a hold on the map to see its number.</p>
        {LIMBS.map((l) => {
          const seq = tl.sequenceAt(l.key, T)
          return (
            <div key={l.key} className="d-seq">
              <span className="d-name"><i style={{ background: l.color }} />{l.name}</span>
              <span className="d-holds">{seq.length ? seq.map((id, i) => <span key={i}>{id}</span>) : <em>no holds</em>}</span>
            </div>
          )
        })}
      </section>

      <section className="panel">
        <h4>Move order</h4>
        <p className="cap">Every hold in the order you first reached it. Tap one to watch that move.</p>
        <ol className="d-moves">
          {order.map((id, i) => {
            const first = tl.firstUse.get(id)
            return (
              <li key={id}>
                <button onClick={() => first && onSeek(first.time)} disabled={!first}>
                  <b>Move {i + 1}</b><span>Hold {id}{first ? ` · ${LIMB_BY_KEY[first.limb].name}` : ''}</span><em>{first ? secs(first.time, 1) : ''}</em>
                </button>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="panel">
        <h4>Every placement</h4>
        <p className="cap">Each time a hand or foot landed on a hold, and how long it stayed.</p>
        <ol className="d-moves dense">
          {s.moves.map((m, i) => (
            <li key={i}>
              <button onClick={() => onSeek(m.time)}>
                <b><i style={{ background: LIMB_BY_KEY[m.limb].color }} />{LIMB_BY_KEY[m.limb].name}</b><span>Hold {m.holdId} · held {secs(m.duration, 1)}</span><em>{secs(m.time, 1)}</em>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {meters && ys.length > 1 && (
        <section className="panel">
          <h4>Climb size</h4>
          <p className="cap">Estimated from your body size in the clip, so treat these as rough.</p>
          <div className="d-facts">
            <div><b>{((Math.max(...ys) - Math.min(...ys)) * meters).toFixed(1)} m</b><span>Route height</span></div>
            <div><b>{((Math.max(...xs) - Math.min(...xs)) * aspect * meters).toFixed(1)} m</b><span>Route width</span></div>
            <div><b>{secs(s.elapsed ?? T)}</b><span>{s.toppedOut ? 'Time to the top' : 'Time on the wall'}</span></div>
          </div>
        </section>
      )}

      {Boolean(s.comparison?.attempts.length) && (
        <section className="panel">
          <h4>Attempts compared</h4>
          <p className="cap">Your attempts on this route, side by side: how long each took and which holds each one used.</p>
          <AttemptsView session={s} />
        </section>
      )}
    </div>
  )
}
