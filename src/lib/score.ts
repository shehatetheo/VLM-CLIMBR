// The Coach Score and the coach's analysis, worked out from the measurements
// alone. Pure functions of a Session: the same climb always gets the same
// score and the same insights, so they can be tuned (SCORE_WEIGHTS and
// SCORE_RULES below) and tested.

import { clamp, median, polygonArea } from './geometry'
import { LIMB_JOINT } from './overlay'
import { LIMBS, LIMB_BY_KEY, type LimbKey, type Move, type Session } from './types'

/** One format for a time, everywhere: "5.00s" for a stat, "5.0s" in a sentence. */
export const secs = (t: number | null | undefined, digits = 2) => (t == null || !Number.isFinite(t) ? '—' : `${t.toFixed(digits)}s`)
const at = (t: number) => secs(Math.max(0, t), 1)

/** How much each part counts toward the score. They are renormalized over the
 *  parts that could be measured, so they need not add up to 1. */
export const SCORE_WEIGHTS = { efficiency: 0.25, flow: 0.25, footwork: 0.2, precision: 0.15, speed: 0.15 } as const
export type ScoreKey = keyof typeof SCORE_WEIGHTS

/** Every threshold and penalty the score uses, in one place. */
export const SCORE_RULES = {
  pause: 1.5, // seconds between placements before the gap counts as hesitation
  pausePenalty: 150, // Flow loses this × (hesitation ÷ climb time)
  extraHold: 12, // Efficiency loses this per hold more than your shortest attempt
  placementsPerHold: 1.6, // one attempt only: placements per hold that cost nothing…
  placementPenalty: 40, // …and what each extra placement per hold costs
  footReplace: 5, // Footwork loses this per foot re-placement
  quickTouch: 0.4, // seconds: a contact shorter than this was an adjustment, not a hold
  regrabPenalty: 200, // Precision loses this × (re-grabs ÷ placements)
  slowerPenalty: 150, // Speed loses this × (how much slower than your best attempt, 0–1)
  paceFree: 1.0, // one attempt only: seconds per placement that cost nothing…
  pacePenalty: 25, // …and points lost per extra second per placement
  floor: 20, // no part scores below this
  noTopCap: 79, // an attempt that did not top out cannot score above this
}

export interface SubScore { key: ScoreKey; label: string; value: number; why: string }
export interface CoachScore { total: number; label: string; parts: SubScore[] }

const climbTime = (s: Session) => Math.max(0.1, s.elapsed ?? s.duration)
const byLimb = (s: Session, limb: LimbKey) => s.moves.filter((m) => m.limb === limb).sort((a, b) => a.time - b.time)
const isFoot = (l: LimbKey) => !LIMB_BY_KEY[l].hand
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Share of the climb a limb spent on a hold, 0–1. */
export function coverage(s: Session, limb: LimbKey) {
  const u = s.utilization?.[limb]
  if (u) return clamp(u.coverage)
  return clamp(byLimb(s, limb).reduce((t, m) => t + m.duration, 0) / climbTime(s))
}

/** Gaps between one placement and the next, longest first. */
export function pauses(s: Session) {
  const times = [...new Set(s.moves.map((m) => m.time))].sort((a, b) => a - b)
  const out: { from: number; to: number; gap: number }[] = []
  for (let i = 1; i < times.length; i++) out.push({ from: times[i - 1], to: times[i], gap: times[i] - times[i - 1] })
  return out.sort((a, b) => b.gap - a.gap)
}
const hesitation = (s: Session) => pauses(s).reduce((t, p) => t + Math.max(0, p.gap - SCORE_RULES.pause), 0)

export interface Regrab { move: Move; kind: 'reset' | 'reversed' | 'touch'; lost: number }
/** Placements that did not stick: a limb back on the hold it just left
 *  ("reset"), back on the hold before that ("reversed"), or on a hold for a
 *  moment only ("touch"). `lost` is the time each one cost, in seconds. */
export function regrabs(s: Session): Regrab[] {
  const out: Regrab[] = []
  for (const l of LIMBS) {
    const ms = byLimb(s, l.key)
    ms.forEach((m, i) => {
      const prev = ms[i - 1], prev2 = ms[i - 2], next = ms[i + 1]
      if (prev && prev.holdId === m.holdId) out.push({ move: m, kind: 'reset', lost: Math.max(0.2, m.time - (prev.time + prev.duration)) })
      else if (prev2 && prev2.holdId === m.holdId) out.push({ move: m, kind: 'reversed', lost: clamp(m.time - prev.time, 0.2, 3) })
      else if (next && m.duration < SCORE_RULES.quickTouch) out.push({ move: m, kind: 'touch', lost: m.duration + 0.3 })
    })
  }
  return out.sort((a, b) => b.lost - a.lost)
}

/**
 * The Coach Score, 0–100.
 *
 *   total = Σ weight × part ÷ Σ weight      (SCORE_WEIGHTS, over the five parts)
 *
 *   Efficiency  100 − 12 per hold more than your shortest attempt of this route.
 *               With one attempt only: 100 − 40 × (placements per hold − 1.6).
 *   Flow        100 − 150 × (seconds paused ÷ climb time), where a pause is any
 *               gap between placements longer than 1.5 s, counted past 1.5 s.
 *   Footwork    average share of the climb your feet were on holds (as 0–100),
 *               minus 5 per foot re-placement.
 *   Precision   100 − 200 × (re-grabs ÷ placements). A re-grab is a limb going
 *               back to a hold it just left, or touching one for under 0.4 s.
 *   Speed       100 − 150 × (how much slower than your best attempt, 0–1).
 *               With one attempt only: 100 − 25 per second per placement past 1 s.
 *
 * Each part is held between 20 and 100. An attempt that did not top out is
 * capped at 79. Every number above lives in SCORE_RULES.
 */
export function coachScore(s: Session): CoachScore {
  const R = SCORE_RULES
  const part = (v: number) => Math.round(clamp(v, R.floor, 100))
  const T = climbTime(s)
  const used = s.sequence.length
  const n = Math.max(1, s.moves.length)
  const attempts = s.comparison?.attempts ?? []
  const mine = attempts.find((a) => a.isThis)
  const sends = attempts.filter((a) => a.toppedOut && a.elapsed != null)

  // Efficiency
  let efficiency: number, effWhy: string
  if (attempts.length > 1) {
    const shortest = Math.min(...(sends.length ? sends : attempts).map((a) => a.sequence.length))
    efficiency = 100 - R.extraHold * Math.max(0, used - shortest)
    effWhy = used <= shortest ? `Your shortest sequence: ${plural(used, 'hold')}.` : `${plural(used, 'hold')}; your shortest attempt used ${shortest}.`
  } else {
    const per = n / Math.max(1, used)
    efficiency = 100 - R.placementPenalty * Math.max(0, per - R.placementsPerHold)
    effWhy = `${plural(s.moves.length, 'placement')} for ${plural(used, 'hold')}.`
  }

  // Flow
  const paused = hesitation(s)
  const flow = 100 - R.pausePenalty * (paused / T)
  const flowWhy = paused > 0.05 ? `${secs(paused, 1)} spent paused between moves.` : `No pause longer than ${R.pause}s.`

  // Footwork
  const re = regrabs(s)
  const footRe = re.filter((r) => isFoot(r.move.limb)).length
  const feet = (coverage(s, 'left_foot') + coverage(s, 'right_foot')) / 2
  const footwork = feet * 100 - R.footReplace * footRe
  const footWhy = `Feet on holds ${Math.round(feet * 100)}% of the climb${footRe ? `, ${plural(footRe, 're-placement')}` : ''}.`

  // Precision
  const precision = 100 - R.regrabPenalty * (re.length / n)
  const precWhy = re.length ? `${plural(re.length, 're-grab')} in ${plural(s.moves.length, 'placement')}.` : 'Every placement stuck the first time.'

  // Speed
  let speed: number, speedWhy: string
  const best = sends.length ? Math.min(...sends.map((a) => a.elapsed!)) : null
  if (best != null && mine?.elapsed != null && sends.length > 1) {
    speed = 100 - R.slowerPenalty * Math.max(0, (mine.elapsed - best) / best)
    speedWhy = mine.elapsed <= best + 0.005 ? `Your fastest of ${sends.length} sends.` : `${secs(mine.elapsed)}; your best is ${secs(best)}.`
  } else {
    const pace = T / n
    speed = 100 - R.pacePenalty * Math.max(0, pace - R.paceFree)
    speedWhy = `${secs(pace, 1)} per placement.`
  }

  const parts: SubScore[] = [
    { key: 'efficiency', label: 'Efficiency', value: part(efficiency), why: effWhy },
    { key: 'flow', label: 'Flow', value: part(flow), why: flowWhy },
    { key: 'footwork', label: 'Footwork', value: part(footwork), why: footWhy },
    { key: 'precision', label: 'Precision', value: part(precision), why: precWhy },
    { key: 'speed', label: 'Speed', value: part(speed), why: speedWhy },
  ]
  const wsum = parts.reduce((t, p) => t + SCORE_WEIGHTS[p.key], 0)
  let total = Math.round(parts.reduce((t, p) => t + p.value * SCORE_WEIGHTS[p.key], 0) / wsum)
  if (!s.toppedOut) total = Math.min(total, R.noTopCap)
  const label = s.toppedOut
    ? total >= 90 ? 'Dialed' : total >= 78 ? 'Solid send' : total >= 65 ? 'Clean enough' : 'Scrappy send'
    : total >= 70 ? 'Strong attempt' : total >= 55 ? 'Good effort' : 'Work in progress'
  return { total, label, parts }
}

// ── where on the wall ────────────────────────────────────────────────────────

/** A hold in words a climber would use: "the big green hold near the top, on the left". */
export function describeHold(s: Session, id: number): string {
  const h = s.holds.find((x) => x.id === id)
  if (!h) return 'a hold'
  if (s.toppedOut && id === s.finalHoldId) return 'the finish hold'
  // Height is judged against the holds you actually climbed: the top third of
  // them is "near the top", whatever else is bolted to the wall.
  const pool = s.sequence.includes(id) ? s.holds.filter((x) => s.sequence.includes(x.id)) : s.holds
  const ys = pool.map((x) => x.center[1]), xs = s.holds.map((x) => x.center[0])
  const ny = (h.center[1] - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys) || 1) // 0 = top of the route
  const nx = (h.center[0] - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1)
  const areas = s.holds.map((x) => polygonArea(x.polygon))
  const rel = polygonArea(h.polygon) / (median(areas) || 1)
  const size = rel > 2.2 ? 'big ' : rel < 0.45 ? 'small ' : ''
  const height = ny < 0.22 ? 'near the top' : ny < 0.45 ? 'in the upper half' : ny < 0.68 ? 'in the middle' : ny < 0.88 ? 'low on the wall' : 'near the start'
  const side = nx < 0.3 ? ', on the left' : nx > 0.7 ? ', on the right' : ''
  return `the ${size}${s.route.color} hold ${height}${side}`
}

// ── the analysis ─────────────────────────────────────────────────────────────

export interface Insight {
  id: string
  /** fix: it cost you something · good: keep doing it · unsure: we could not see it clearly */
  kind: 'fix' | 'good' | 'unsure'
  title: string // what happened, with the moment and the place
  body: string // why it cost you (or why it worked)
  tip?: string // what to try next time
  time?: number // climb seconds to jump the replay to
  holds?: number[]
  limbs?: LimbKey[]
  /** Seconds lost, or a seconds-equivalent for things that tire you rather than
   *  slow you. Insights are sorted by it. */
  cost: number
  costLabel?: string
  ref?: string // the secondary line: hold numbers and limb
  short?: string // one clause for the verdict sentence
}

const refOf = (holds: number[], limb?: LimbKey) => [limb ? LIMB_BY_KEY[limb].name : null, holds.length ? `hold${holds.length > 1 ? 's' : ''} ${holds.join(', ')}` : null].filter(Boolean).join(' · ')
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
/** 1, 3 and 4 */
const list = (xs: (string | number)[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The holds the hands were on at a moment. */
function handsAt(s: Session, t: number): number[] {
  const ids = (['left_hand', 'right_hand'] as LimbKey[]).map((l) => byLimb(s, l).filter((m) => m.time <= t + 0.01).pop()?.holdId)
  return [...new Set(ids.filter((x): x is number => x != null))]
}

/** The longest stretch a limb was on no hold: [from, to]. */
function longestOff(s: Session, limb: LimbKey): [number, number] {
  const ms = byLimb(s, limb), T = climbTime(s)
  let best: [number, number] = [0, 0], cursor = 0
  for (const m of ms) {
    if (m.time - cursor > best[1] - best[0]) best = [cursor, m.time]
    cursor = Math.max(cursor, m.time + m.duration)
  }
  if (T - cursor > best[1] - best[0]) best = [cursor, T]
  return best
}

/** Stretches where ViTPose+ was not sure where a hand or foot was. */
function unseen(s: Session): { limb: LimbKey; from: number; to: number }[] {
  const pose = s.pose
  if (!pose?.t.length) return []
  const off = s.video?.offset ?? 0, T = climbTime(s), out: { limb: LimbKey; from: number; to: number }[] = []
  for (const l of LIMBS) {
    let start: number | null = null, best: [number, number] | null = null
    const close = (end: number) => { if (start != null && (!best || end - start > best[1] - best[0])) best = [start, end]; start = null }
    pose.t.forEach((vt, i) => {
      const t = vt - off
      if (t < 0 || t > T) return
      const c = pose.k[i]?.[LIMB_JOINT[l.key] * 3 + 2] ?? 0
      if (c < 0.3) start ??= t
      else close(t)
    })
    close(T)
    const b = best as [number, number] | null
    if (b && b[1] - b[0] >= 1) out.push({ limb: l.key, from: b[0], to: b[1] })
  }
  return out.sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, 2)
}

/**
 * What the coach has to say, most costly first. Built only from what was
 * measured: pauses between moves, placements that did not stick, time each
 * foot spent off the wall, and how this attempt differs from the others.
 * Fixes come sorted by `cost`; positives and "could not see" notes follow.
 */
export function coachInsights(s: Session): Insight[] {
  const R = SCORE_RULES, T = climbTime(s)
  const fixes: Insight[] = [], good: Insight[] = [], unsure: Insight[] = []

  // 1 · hesitation
  const ps = pauses(s)
  const typical = Math.min(R.pause, median(ps.map((p) => p.gap)) || R.pause)
  for (const p of ps.filter((x) => x.gap > R.pause).slice(0, 2)) {
    const holds = handsAt(s, p.from)
    const where = holds.length ? `on ${describeHold(s, holds[holds.length - 1])}` : 'on the wall'
    const lost = p.gap - typical
    fixes.push({
      id: `pause-${p.from.toFixed(2)}`, kind: 'fix', time: p.from, holds, cost: lost, costLabel: `about ${secs(lost, 1)}`,
      title: `At ${at(p.from)} you paused for ${secs(p.gap, 1)} ${where}.`,
      body: `Nothing moved until ${at(p.to)}. That is about ${secs(lost, 1)} of hanging on your arms.`,
      tip: 'Read this move from the ground so you can keep going when you get here.',
      ref: refOf(holds), short: `You lost about ${secs(lost, 1)} pausing ${where}.`,
    })
  }

  // 2 · placements that did not stick
  for (const r of regrabs(s).slice(0, 3)) {
    const l = LIMB_BY_KEY[r.move.limb], place = describeHold(s, r.move.holdId)
    const foot = !l.hand
    const title = r.kind === 'reset' ? `At ${at(r.move.time)} your ${l.name} came off ${place} and you re-set it.`
      : r.kind === 'reversed' ? `At ${at(r.move.time)} your ${l.name} went back to ${place} after trying the next hold.`
        : `At ${at(r.move.time)} your ${l.name} only touched ${place} for ${secs(r.move.duration, 1)}.`
    fixes.push({
      id: `regrab-${r.move.limb}-${r.move.time.toFixed(2)}`, kind: 'fix', time: r.move.time, holds: [r.move.holdId], limbs: [r.move.limb], cost: r.lost, costLabel: `about ${secs(r.lost, 1)}`,
      title,
      body: `That cost about ${secs(r.lost, 1)}${r.kind === 'reversed' ? ' and a move you had to undo' : ''}.`,
      tip: r.kind === 'touch' ? 'Either skip that hold or commit to it.' : foot ? 'Put your weight on that foot before you reach.' : 'Watch the hold until your hand is on it, and take it where you want it the first time.',
      ref: refOf([r.move.holdId], r.move.limb), short: `You lost about ${secs(r.lost, 1)} re-placing your ${l.name}.`,
    })
  }

  // 3 · a foot that spent the climb off the wall
  const hands = (coverage(s, 'left_hand') + coverage(s, 'right_hand')) / 2
  const weak = (['left_foot', 'right_foot'] as LimbKey[]).sort((a, b) => coverage(s, a) - coverage(s, b))[0]
  const wc = coverage(s, weak)
  if (wc < 0.85 && wc < hands - 0.1) {
    const [a, b] = longestOff(s, weak), name = LIMB_BY_KEY[weak].name
    fixes.push({
      id: `foot-${weak}`, kind: 'fix', time: a, limbs: [weak], cost: (b - a) * 0.3, // not time lost, but arms tiring: a third of the hanging time
      title: `Your ${name} was on a hold only ${Math.round(wc * 100)}% of the climb, much less than your hands (${Math.round(hands * 100)}%).`,
      body: `The longest stretch was ${secs(b - a, 1)} from ${at(a)}. With a foot off, your arms carry that weight.`,
      tip: `Place your ${name} before you reach with a hand.`,
      ref: refOf([], weak), short: `Your ${name} was off the wall ${Math.round((1 - wc) * 100)}% of the time, so your arms did the work.`,
    })
  }

  // 4 · this attempt against the others
  const attempts = s.comparison?.attempts ?? []
  const mine = attempts.find((x) => x.isThis)
  const sends = attempts.filter((x) => x.toppedOut && x.elapsed != null)
  if (mine && sends.length > 1) {
    const fastest = [...sends].sort((x, y) => x.elapsed! - y.elapsed!)[0]
    if (mine.elapsed != null && fastest.label !== mine.label) {
      const extra = [...new Set(mine.sequence)].filter((id) => !fastest.sequence.includes(id))
      const diff = mine.elapsed - fastest.elapsed!
      if (extra.length && diff > 0.2) fixes.push({
        id: 'extra-holds', kind: 'fix', holds: extra, cost: diff, costLabel: `about ${secs(diff, 1)}`,
        title: `You used ${extra.length === 1 ? `an extra hold (${describeHold(s, extra[0])})` : `${extra.length} extra holds`} that your fastest attempt skipped.`,
        body: `Attempt ${fastest.index} topped out ${secs(diff, 1)} faster without ${extra.length === 1 ? 'it' : 'them'}.`,
        tip: `Try the climb again and skip ${extra.length === 1 ? 'it' : 'them'}.`,
        ref: refOf(extra), short: `Your fastest attempt skipped ${plural(extra.length, 'hold')} you used here and was ${secs(diff, 1)} quicker.`,
      })
    } else if (mine.elapsed != null) {
      const avg = sends.reduce((t, x) => t + x.elapsed!, 0) / sends.length
      good.push({ id: 'fastest', kind: 'good', cost: avg - mine.elapsed, title: `This was your fastest of ${sends.length} sends, ${secs(avg - mine.elapsed, 1)} under your average.`, body: `You topped out in ${secs(mine.elapsed)} on ${plural(mine.sequence.length, 'hold')}.` })
      // Holds only the slower attempts used.
      const others = sends.filter((x) => x.label !== mine.label)
      const skipped = new Map<number, typeof others>()
      for (const o of others) for (const id of new Set(o.sequence)) if (!mine.sequence.includes(id)) skipped.set(id, [...(skipped.get(id) ?? []), o])
      const [id, who] = [...skipped.entries()].sort((x, y) => y[1].length - x[1].length)[0] ?? []
      if (id != null && who) {
        const saved = who.reduce((t, x) => t + x.elapsed!, 0) / who.length - mine.elapsed
        if (saved > 0.2) good.push({
          id: 'skipped', kind: 'good', holds: [id], cost: saved,
          title: `On attempt${who.length > 1 ? 's' : ''} ${list(who.map((x) => x.index).sort((x, y) => x - y))} you used an extra hold (${describeHold(s, id)}) that this attempt skipped.`,
          body: `Skipping it saved about ${secs(saved, 1)}. Keep this sequence.`, ref: refOf([id]),
        })
      }
    }
  }

  // 5 · what went well
  const anchor = [...s.moves].filter((m) => isFoot(m.limb)).sort((a, b) => b.duration - a.duration)[0]
  if (anchor && anchor.duration >= Math.max(2.5, T * 0.2)) good.push({
    id: 'anchor', kind: 'good', time: anchor.time, holds: [anchor.holdId], limbs: [anchor.limb], cost: anchor.duration * 0.2,
    title: `Your ${LIMB_BY_KEY[anchor.limb].name} stayed on ${describeHold(s, anchor.holdId)} for ${secs(anchor.duration, 1)} while the rest of you moved.`,
    body: 'A foot that stays put is a base to push from. That is good footwork.', ref: refOf([anchor.holdId], anchor.limb),
  })
  if (!ps.some((p) => p.gap > R.pause) && s.moves.length > 3) good.push({ id: 'rhythm', kind: 'good', cost: 0.5, title: `You never stopped for more than ${R.pause}s.`, body: 'Steady rhythm keeps you off your arms. Keep climbing at this pace.' })
  if (coverage(s, 'left_foot') >= 0.85 && coverage(s, 'right_foot') >= 0.85) good.push({ id: 'feet-on', kind: 'good', cost: 0.4, title: 'Both feet stayed on holds for most of the climb.', body: 'Your legs did the pushing and your arms only steered.' })
  if (!regrabs(s).length && s.moves.length > 3) good.push({ id: 'clean', kind: 'good', cost: 0.3, title: 'Every placement stuck the first time.', body: 'No re-grabs and no hold you had to adjust on.' })

  // 6 · what we could not see
  for (const u of unseen(s)) unsure.push({
    id: `unseen-${u.limb}`, kind: 'unsure', time: u.from, limbs: [u.limb], cost: 0,
    title: `From ${at(u.from)} to ${at(u.to)} we couldn’t clearly see your ${LIMB_BY_KEY[u.limb].name}.`,
    body: 'Anything said about that limb in this stretch is a best guess. Filming from further back or a different side would help.', ref: refOf([], u.limb),
  })

  const order = (xs: Insight[]) => xs.sort((a, b) => b.cost - a.cost)
  return [...order(fixes), ...order(good), ...unsure]
}

/** One plain sentence for the top of the results. */
export function verdict(s: Session, insights = coachInsights(s)): string {
  const T = climbTime(s)
  const lead = s.toppedOut ? `Clean send in ${secs(s.elapsed ?? T, 1)}.` : `${secs(T, 1)} on the wall without topping out.`
  const top = insights.find((i) => i.kind === 'fix')
  return `${lead} ${top?.short ?? (s.toppedOut ? 'Nothing big to fix: repeat it and go for a faster time.' : 'Nothing big went wrong: keep going for the top.')}`
}

export { cap as capitalize }
