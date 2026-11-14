import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, Play, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LogoMark } from '../components/Logo'
import { getPrefs, setPrefs } from '../lib/store'
import { ROUTE_COLORS } from '../lib/types'

const GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7+']
const STEPS = 5 // the splash, then four steps

/** Three fixed rows on every step: top bar (back · progress · skip), content,
 *  action bar. The content row is the only one that flexes, and its picture
 *  shrinks to whatever room is left, so a step never scrolls. */
export function Onboarding({ onDone }: { onDone: (to: string) => void }) {
  const p = getPrefs()
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState(1)
  const [name, setName] = useState(p.name ?? '')
  const [grade, setGrade] = useState(p.grade ?? 'V1')
  const [color, setColor] = useState(p.color ?? 'green')

  const go = (n: number) => {
    setDir(n > step ? 1 : -1)
    setStep(Math.max(0, Math.min(STEPS - 1, n)))
  }
  useEffect(() => {
    if (step !== 0) return
    const id = setTimeout(() => go(1), 2600)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input')) return
      if (e.key === 'ArrowRight' || e.key === 'Enter') go(step + 1)
      if (e.key === 'ArrowLeft') go(step - 1)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  const finish = (to: string) => {
    setPrefs({ onboarded: true, name: name.trim() || undefined, grade, color })
    onDone(to)
  }

  if (step === 0) {
    return (
      <motion.div className="onboarding splash-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} onClick={() => go(1)}>
        <LogoMark size={72} />
        <h1 className="splash-word">CLIMBR</h1>
        <p className="splash-tag">Feedback after every climb.</p>
      </motion.div>
    )
  }

  const last = step === STEPS - 1
  return (
    <motion.div className="onboarding" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
      <header className="ob-top">
        <button className="ob-icon" onClick={() => go(step - 1)} disabled={step <= 1} aria-label="Back"><ArrowLeft size={20} /></button>
        <div className="ob-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS - 1} aria-valuenow={step} aria-label={`Step ${step} of ${STEPS - 1}`}>
          <span className="ob-count">{step} of {STEPS - 1}</span>
          <span className="ob-segs">{Array.from({ length: STEPS - 1 }, (_, i) => <i key={i} className={i < step ? 'on' : ''} />)}</span>
        </div>
        <button className="ob-skip" onClick={() => finish('#/')}>Skip</button>
      </header>

      <main className="ob-body">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div key={step} className={`ob-step ${step >= 3 ? 'solo' : ''}`} initial={{ opacity: 0, x: dir * 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -24 }} transition={{ duration: 0.22, ease: 'easeOut' }}>
            {step === 1 && (
              <>
                <div className="ob-copy">
                  <h1>Film one attempt.</h1>
                  <p>Prop your phone or hand it to a friend. Keep the whole route in frame.</p>
                  <Bullets items={['Portrait or landscape', 'One route color per clip', 'Under two minutes']} />
                </div>
                <ExampleClip label="Example clip" />
              </>
            )}

            {step === 2 && (
              <>
                <div className="ob-copy">
                  <h1>We read every move.</h1>
                  <p>CLIMBR finds your holds and follows your hands and feet to the top.</p>
                  <Bullets items={['SAM 3.1 outlines every hold of your color', 'ViTPose+ tracks your body, frame by frame', 'A coach turns it into what to fix next']} />
                </div>
                <ExampleClip label="Holds and body, tracked" play />
              </>
            )}

            {step === 3 && (
              <div className="ob-copy">
                <h1>Make it yours.</h1>
                <label className="ob-field">
                  <span>Your name</span>
                  <input className="ob-input" ref={(el) => { if (el && !el.dataset.f && window.matchMedia('(pointer: fine)').matches) { el.dataset.f = '1'; el.focus({ preventScroll: true }) } }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" autoComplete="given-name" enterKeyHint="next" onKeyDown={(e) => e.key === 'Enter' && go(4)} />
                </label>
                <div className="ob-field">
                  <span>Your usual grade</span>
                  <div className="grades big">{GRADES.map((g) => <button key={g} className={grade === g ? 'on' : ''} aria-pressed={grade === g} onClick={() => setGrade(g)}>{g}</button>)}</div>
                </div>
                <div className="ob-field">
                  <span>The route color you climb most</span>
                  <div className="swatches big">
                    {Object.entries(ROUTE_COLORS).map(([k, v]) => (
                      <button key={k} className={`swatch ${color === k ? 'on' : ''}`} style={{ background: v }} onClick={() => setColor(k)} aria-label={k} aria-pressed={color === k} title={k} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="ob-copy center">
                <LogoMark size={64} />
                <h1>You’re set{name.trim() ? `, ${name.trim()}` : ''}.</h1>
                <p>After each climb you get a Coach Score and the exact moments to fix.</p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="ob-bottom">
        {last ? (
          <>
            <button className="btn primary xl" onClick={() => finish('#/import')}><Upload size={18} /> Analyze my climb</button>
            <button className="btn xl quiet" onClick={() => finish('#/session/example-green-vb')}><Play size={16} /> Watch the example first</button>
          </>
        ) : (
          <button className="btn primary xl" onClick={() => go(step + 1)}>Continue <ArrowRight size={18} /></button>
        )}
      </footer>
    </motion.div>
  )
}

function Bullets({ items }: { items: string[] }) {
  return <ul className="ob-bullets">{items.map((x) => <li key={x}><Check size={15} strokeWidth={2.6} />{x}</li>)}</ul>
}

/** The bundled example: a 720 × 1200 render with the hold masks and skeleton
 *  already in its pixels. It is shown no larger than its own pixels allow
 *  (CSS caps the frame), so it is never blown up into a blur. */
function ExampleClip({ label, play }: { label: string; play?: boolean }) {
  return (
    <figure className="ob-media">
      <div className="ob-frame">
        {play
          ? <video src="/examples/green-vb/climb.mp4" poster="/examples/green-vb/poster.jpg" autoPlay muted loop playsInline preload="auto" />
          : <img src="/examples/green-vb/poster.jpg" alt="A climber on a green route, filmed from below" />}
        {!play && <span className="ob-rec"><i /> REC</span>}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  )
}
