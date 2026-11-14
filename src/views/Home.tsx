import { coachScore, secs } from '../lib/score'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowRight, Brain, Clapperboard, Play, ScanLine, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MiniRoute } from '../components/MiniRoute'
import { sessionProblem } from '../lib/live'
import { getPrefs, listSessions, type StoredSession } from '../lib/store'
import { ROUTE_COLORS, type Session } from '../lib/types'

export function Home({ sessions, go }: { sessions: Session[]; go: (h: string) => void }) {
  const [saved, setSaved] = useState<StoredSession[]>([])
  useEffect(() => { listSessions().then(setSaved) }, [])
  const example = sessions.find((s) => s.kind === 'example')
  const name = getPrefs().name
  const all = [...sessions.filter((s) => s.kind === 'example'), ...saved.map((r) => r.session).filter((s) => !sessions.some((x) => x.id === s.id && x.kind === 'example'))]

  return (
    <motion.section className="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="hero">
        <div className="hero-copy">
          <motion.span className="kicker" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>{name ? `Welcome back, ${name}` : 'Coaching for bouldering'}</motion.span>
          <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
            Feedback after every climb.
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
            Film one attempt on your phone. CLIMBR finds your holds, follows your hands and feet, and tells you exactly where the climb cost you time.
          </motion.p>
          <motion.div className="cta" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
            <button className="btn primary lg" onClick={() => go('#/import')}><Upload size={16} /> Analyze a climb</button>
            <button className="btn lg" onClick={() => go('#/session/example-green-vb')}><Play size={16} /> Watch the example</button>
          </motion.div>
          <p className="muted xs built-on">Built on SAM 3.1 and ViTPose+ through VLM Run.</p>
        </div>
        <motion.div className="hero-visual" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15, type: 'spring', stiffness: 120, damping: 20 }}>
          <div className="hero-glow" />
          {example ? (
            <div className="hero-card card">
              <MiniRoute session={example} sequence={example.sequence} loop body height={420} />
            </div>
          ) : <div className="spinner" />}
        </motion.div>
      </div>

      <div className="section-head">
        <h2>Your climbs</h2>
        <button className="link" onClick={() => go('#/import')}>New climb <ArrowRight size={14} /></button>
      </div>
      <div className="session-cards">
        {all.map((s, i) => (
          <motion.button key={s.id} className="card session-card" onClick={() => go(`#/session/${encodeURIComponent(s.id)}`)} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.06 }} whileHover={{ y: -4 }}>
            <div className="sc-visual">
              {s.video?.poster ? <img src={s.video.poster} alt="" /> : <MiniRoute session={s} sequence={s.sequence} animate={false} height={180} />}
              <span className="sc-play"><Play size={14} fill="currentColor" /></span>
              {s.kind === 'example' && <span className="chip sc-tag">Example</span>}
              {s.kind === 'live' && (sessionProblem(s) ? <span className="chip warn sc-tag" title={sessionProblem(s)!}><AlertTriangle size={11} /> Re-analyze</span> : null)}
            </div>
            <div className="sc-body">
              <b>{s.title}</b>
              <span className="muted xs"><span className="route-dot" style={{ background: ROUTE_COLORS[s.route.color] }} />{s.route.color} · {s.route.grade} · {s.climber}</span>
              <div className="sc-stats">
                <span>Score <b>{coachScore(s).total}</b></span>
                <span>{s.toppedOut && s.elapsed != null ? <><b>{secs(s.elapsed)}</b> to the top</> : 'No top-out yet'}</span>
              </div>
            </div>
          </motion.button>
        ))}
        <motion.button className="card session-card add" onClick={() => go('#/import')} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + all.length * 0.06 }} whileHover={{ y: -4 }}>
          <Upload size={22} />
          <b>New climb</b>
          <span className="muted xs">A phone video of one attempt</span>
        </motion.button>
      </div>

      <div className="how">
        {[
          { icon: <Clapperboard size={18} />, t: 'Film one attempt', d: 'Prop your phone or hand it to a friend.' },
          { icon: <ScanLine size={18} />, t: 'We find your holds', d: 'Every hold of your route color, in any gym.' },
          { icon: <Play size={18} />, t: 'We track your body', d: 'Both hands and both feet, frame by frame.' },
          { icon: <Brain size={18} />, t: 'You get feedback', d: 'A Coach Score and the exact moments to fix.' },
        ].map((x, i) => (
          <motion.div key={x.t} className="how-step" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }}>
            <span className="how-icon">{x.icon}</span>
            <span className="how-n">0{i + 1}</span>
            <b>{x.t}</b>
            <p>{x.d}</p>
          </motion.div>
        ))}
      </div>
      <p className="credit">Example footage and the reference pipeline: <a href="https://github.com/jeremyipark/vision-demos" target="_blank" rel="noreferrer">jeremyipark/vision-demos</a> (Apache-2.0).</p>
    </motion.section>
  )
}
