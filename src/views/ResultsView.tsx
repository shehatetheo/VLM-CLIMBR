import { AlertCircle, ArrowUpRight, ChevronDown, CircleCheck, EyeOff, RefreshCw, Sparkles, Star } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CloudSave } from '../components/CloudSave'
import { RoutePanel } from '../components/RoutePanel'
import { toast } from '../components/Toast'
import { YourData } from '../components/YourData'
import type { Health } from '../lib/api'
import { requestVlmCoach } from '../lib/coach'
import { bestMove, coachInsights, coachScore, SCORE_WEIGHTS, secs, verdict, type BestMove, type Insight } from '../lib/score'
import { climbStatus } from '../lib/status'
import type { Timeline } from '../lib/timeline'
import type { Session } from '../lib/types'
import { ScoreBadge, SectionHeader, StickerBadge } from '../ui'

/** Results in three layers: the Coach Score, the coach's analysis in plain
 *  English, and the raw data, collapsed until asked for. */
export function ResultsView({ session: s, tl, health, onUpdate, onPick, onSeek, onBest }: { session: Session; tl: Timeline; health: Health | null; onUpdate: (s: Session) => void; onPick: (i: Insight) => void; onSeek: (t: number) => void; onBest: (b: BestMove) => void }) {
  const score = useMemo(() => coachScore(s), [s])
  const insights = useMemo(() => coachInsights(s), [s])
  const line = useMemo(() => verdict(s, insights), [s, insights])
  const status = useMemo(() => climbStatus(s), [s])
  const best = useMemo(() => bestMove(s), [s])
  const [all, setAll] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const fixes = insights.filter((i) => i.kind === 'fix')
  const good = insights.filter((i) => i.kind === 'good')
  const unsure = insights.filter((i) => i.kind === 'unsure')
  // First: the three that cost the most, and up to two things that went well.
  const lead = [...fixes.slice(0, 3), ...good.slice(0, 2)]
  const rest = [...fixes.slice(3), ...good.slice(2), ...unsure]

  const generate = async () => {
    setBusy(true)
    try {
      const coach = await requestVlmCoach(s)
      onUpdate({ ...s, coach })
      toast('AI coach notes updated')
    } catch (e) {
      toast((e as Error).message, 'warn')
    } finally {
      setBusy(false)
    }
  }
  const ai = s.coach?.source === 'vlm' ? s.coach : null
  const canVlm = Boolean(health?.connected)

  return (
    <div className="results">
      {/* 1 · Coach Score */}
      <section className="panel score-card" aria-label="Coach Score">
        <div className="score-top">
          <ScoreBadge value={score.total} />
          <div className="score-head">
            <span className="eyebrow">coach score</span>
            <h2>{score.total} · {score.label.toLowerCase()}</h2>
            <StickerBadge kind={status.status} />
          </div>
        </div>
        <p className="verdict say">{line}</p>
        {status.status !== 'sent' && <p className="status-note say"><b>{status.title}.</b> {status.detail}</p>}
        <ul className="subs">
          {score.parts.map((p) => (
            <li key={p.key}>
              <div className="sub-row"><span>{p.label}</span><span className="sub-bar"><i style={{ width: `${p.value}%` }} /></span><b>{p.value}</b></div>
              <p>{p.why}</p>
            </li>
          ))}
        </ul>
        <details className="more">
          <summary>How the score is worked out</summary>
          <p>Each part is scored 0–100 from what was measured in your clip, then weighted: {score.parts.map((p) => `${p.label} ${Math.round(SCORE_WEIGHTS[p.key] * 100)}%`).join(', ')}. {s.toppedOut ? '' : 'An attempt that does not top out is capped at 79.'}</p>
        </details>
      </section>

      {/* 2 · Best Move */}
      {best && (
        <button className="panel best-move" onClick={() => onBest(best)} disabled={best.time == null}>
          <span className="best-star"><Star size={20} fill="currentColor" /></span>
          <span className="ic-text">
            <em className="eyebrow">best move</em>
            <b className="say">{best.title}</b>
            <span className="say">{best.body}</span>
            {best.time != null && <span className="ic-meta"><em>watch this move <ArrowUpRight size={12} /></em></span>}
          </span>
        </button>
      )}

      {/* 3 · Coach Analysis */}
      <section className="analysis" aria-label="Coach analysis">
        <SectionHeader title="where you lost time" sub="biggest first. tap a note to watch that moment." />
        {lead.length === 0 && <p className="panel empty-note">Not enough was measured in this clip to say where it went wrong. Try a clip that shows the whole route and your whole body.</p>}
        {lead.map((i) => <InsightCard key={i.id} i={i} onPick={onPick} />)}
        {all && rest.map((i) => <InsightCard key={i.id} i={i} onPick={onPick} />)}
        {rest.length > 0 && <button className="gbtn chrome wide see-all" onClick={() => setAll((x) => !x)} aria-expanded={all}>{all ? 'show fewer' : `see all ${insights.length} notes`}</button>}
      </section>

      {/* The model's own read of the clip, when there is one */}
      <section className="panel ai" aria-label="AI coach notes">
        <div className="ai-head">
          <span className="eyebrow"><Sparkles size={13} /> ai coach notes</span>
          <button className="btn sm" disabled={!canVlm || busy} onClick={generate}>
            {busy ? <RefreshCw size={14} className="spin" /> : <Sparkles size={14} />}{busy ? 'Reading your clip…' : ai ? 'New notes' : 'Ask the AI coach'}
          </button>
        </div>
        {ai ? (
          <>
            <h4>{ai.headline}</h4>
            <p>{ai.summary}</p>
            <details className="more">
              <summary>Drills and what to try next</summary>
              {ai.focus.map((x, k) => (
                <button key={k} className="ai-item" disabled={x.time == null} onClick={() => x.time != null && onSeek(x.time)}>
                  <b>{x.title}</b><span>{x.detail}</span>{x.time != null && <em>Watch at {secs(x.time, 1)} <ArrowUpRight size={12} /></em>}
                </button>
              ))}
              {ai.drills.map((d, k) => <div key={k} className="ai-item"><b>{d.name}{d.dose ? ` · ${d.dose}` : ''}</b><span>{d.how}</span></div>)}
              {ai.beta && <div className="ai-item"><b>Sequence to try</b><span>{ai.beta}</span></div>}
              {ai.next_goal && <div className="ai-item"><b>Next goal</b><span>{ai.next_goal}</span></div>}
            </details>
            <p className="fine">Written by an AI coach{ai.watchedVideo ? ` from ${ai.frames ?? 8} frames of your clip` : ''}. The score above does not depend on it.</p>
          </>
        ) : (
          <p>{canVlm ? 'The AI coach can look at frames of your clip and add its own notes and drills.' : 'AI coach notes are not set up on this copy of CLIMBR. Your score and breakdown above work without them.'}</p>
        )}
      </section>

      {/* Layer 3 · Your Data */}
      <section className="your-data" aria-label="Your data">
        <button className="data-toggle" onClick={() => setDataOpen((x) => !x)} aria-expanded={dataOpen}>
          <span><b>your data</b><em>every measurement behind the score</em></span>
          <ChevronDown size={20} className={dataOpen ? 'flip' : ''} />
        </button>
        {dataOpen && (
          <>
            <YourData session={s} tl={tl} onSeek={onSeek} />
            <section className="panel">
              <h4>route map</h4>
              <p className="cap">The holds you used, numbered in the order you reached them. Tap a hold to see its number.</p>
              <div className="data-map dark"><RoutePanel session={s} tl={tl} t={tl.climbEnd + 30} backdrop={Boolean(s.wall)} skeleton={false} /></div>
            </section>
          </>
        )}
      </section>

      <CloudSave session={s} onUpdate={onUpdate} />
    </div>
  )
}

function InsightCard({ i, onPick }: { i: Insight; onPick: (i: Insight) => void }) {
  const tappable = i.time != null || Boolean(i.holds?.length)
  const Icon = i.kind === 'good' ? CircleCheck : i.kind === 'unsure' ? EyeOff : AlertCircle
  return (
    <button className={`insight-card ${i.kind}`} onClick={() => tappable && onPick(i)} disabled={!tappable}>
      <Icon size={18} className="ic" />
      <span className="ic-text">
        <b className="say">{i.title}</b>
        <span className="say">{i.body}</span>
        {i.tip && <span className="tip say"><i>next time</i> {i.tip}</span>}
        {(tappable || i.ref) && (
          <span className="ic-meta">
            {i.time != null && <em>Watch at {secs(i.time, 1)} <ArrowUpRight size={12} /></em>}
            {i.ref && <span>{i.ref}</span>}
          </span>
        )}
      </span>
    </button>
  )
}
