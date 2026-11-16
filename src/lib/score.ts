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
  // Two pauses never get the same joke.
  const QUIPS = ['Nice view, pricey rent.', 'Your forearms would like a word.']
  const TIPS = ['Read this move from the ground, so when you get here your body already knows the answer.', 'Plan the next two moves before you leave the ground, then climb straight through this spot.']
  for (const [n, p] of ps.filter((x) => x.gap > R.pause).slice(0, 2).entries()) {
    const holds = handsAt(s, p.from)
    const where = holds.length ? `on ${describeHold(s, holds[holds.length - 1])}` : 'on the wall'
    const lost = p.gap - typical
    fixes.push({
      id: `pause-${p.from.toFixed(2)}`, kind: 'fix', time: p.from, holds, cost: lost, costLabel: `about ${secs(lost, 1)}`,
      title: `At ${at(p.from)} you took a ${secs(p.gap, 1)} breather ${where}.`,
      body: `Nothing moved until ${at(p.to)}: about ${secs(lost, 1)} of hanging out on your arms. ${QUIPS[n]}`,
      tip: TIPS[n],
      ref: refOf(holds), short: `The easiest time to win back: about ${secs(lost, 1)} spent pausing ${where}.`,
    })
  }

  // 2 · placements that did not stick
  for (const r of regrabs(s).slice(0, 3)) {
    const l = LIMB_BY_KEY[r.move.limb], place = describeHold(s, r.move.holdId)
    const foot = !l.hand
    const title = r.kind === 'reset' ? `At ${at(r.move.time)} your ${l.name} slipped off ${place}, and you put it right back.`
      : r.kind === 'reversed' ? `At ${at(r.move.time)} your ${l.name} went exploring, then came home to ${place}.`
        : `At ${at(r.move.time)} your ${l.name} gave ${place} a quick high-five (${secs(r.move.duration, 1)}) and moved on.`
    fixes.push({
      id: `regrab-${r.move.limb}-${r.move.time.toFixed(2)}`, kind: 'fix', time: r.move.time, holds: [r.move.holdId], limbs: [r.move.limb], cost: r.lost, costLabel: `about ${secs(r.lost, 1)}`,
      title,
      body: `That cost about ${secs(r.lost, 1)}${r.kind === 'reversed' ? ', plus a move you had to undo' : ''}. Small on its own, but these add up.`,
      tip: r.kind === 'touch' ? 'Commit to that hold or skip it entirely. Both work; the in-between is the expensive one.' : foot ? 'Settle your weight onto that foot before you reach. Feet love commitment.' : 'Keep your eyes on the hold until your hand lands, and grab it the way you want it the first time.',
      ref: refOf([r.move.holdId], r.move.limb), short: `About ${secs(r.lost, 1)} went to re-placing your ${l.name}, and that is easy time to win back.`,
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
      title: `Your ${name} was on a hold ${Math.round(wc * 100)}% of the climb, while your hands clocked ${Math.round(hands * 100)}%.`,
      body: `Its longest solo flight was ${secs(b - a, 1)} from ${at(a)}. While a foot dangles, your arms pick up the tab.`,
      tip: `Place your ${name} first, then reach: legs are the free upgrade. (Cut feet on purpose on a steep move? Carry on, that was style.)`,
      ref: refOf([], weak), short: `Your ${name} spent ${Math.round((1 - wc) * 100)}% of the climb off the wall, so your arms covered for it.`,
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
        body: `Attempt ${fastest.index} topped out ${secs(diff, 1)} faster without ${extra.length === 1 ? 'it' : 'them'}. The fast version of you already found the shortcut.`,
        tip: `Next go, skip ${extra.length === 1 ? 'it' : 'them'} and trust the bigger move.`,
        ref: refOf(extra), short: `Your fastest attempt skipped ${plural(extra.length, 'hold')} you used here and was ${secs(diff, 1)} quicker. Copy its homework.`,
      })
    } else if (mine.elapsed != null) {
      const avg = sends.reduce((t, x) => t + x.elapsed!, 0) / sends.length
      good.push({ id: 'fastest', kind: 'good', cost: avg - mine.elapsed, title: `Your fastest of ${sends.length} sends, ${secs(avg - mine.elapsed, 1)} under your average. Personal-best energy.`, body: `You topped out in ${secs(mine.elapsed)} on ${plural(mine.sequence.length, 'hold')}.` })
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
          body: `Skipping it saved about ${secs(saved, 1)}. This sequence is a keeper.`, ref: refOf([id]),
        })
      }
    }
  }

  // 5 · what went well
  const anchor = [...s.moves].filter((m) => isFoot(m.limb)).sort((a, b) => b.duration - a.duration)[0]
  if (anchor && anchor.duration >= Math.max(2.5, T * 0.2)) good.push({
    id: 'anchor', kind: 'good', time: anchor.time, holds: [anchor.holdId], limbs: [anchor.limb], cost: anchor.duration * 0.2,
    title: `Your ${LIMB_BY_KEY[anchor.limb].name} stayed on ${describeHold(s, anchor.holdId)} for ${secs(anchor.duration, 1)} while the rest of you moved.`,
    body: 'The most reliable thing on the wall. A foot you can push from makes every reach easier.', ref: refOf([anchor.holdId], anchor.limb),
  })
  if (!ps.some((p) => p.gap > R.pause) && s.moves.length > 3) good.push({ id: 'rhythm', kind: 'good', cost: 0.5, title: `You never stopped for more than ${R.pause}s.`, body: 'Steady as a metronome. That rhythm keeps the pump away, so keep this pace.' })
  if (coverage(s, 'left_foot') >= 0.85 && coverage(s, 'right_foot') >= 0.85) good.push({ id: 'feet-on', kind: 'good', cost: 0.4, title: 'Both feet stayed on holds for most of the climb.', body: 'Your legs did the heavy lifting and your arms just steered. Textbook.' })
  if (!regrabs(s).length && s.moves.length > 3) good.push({ id: 'clean', kind: 'good', cost: 0.3, title: 'Every placement stuck the first time.', body: 'No re-grabs, no fidgeting. Surgical.' })

  // 6 · what we could not see
  for (const u of unseen(s)) unsure.push({
    id: `unseen-${u.limb}`, kind: 'unsure', time: u.from, limbs: [u.limb], cost: 0,
    title: `From ${at(u.from)} to ${at(u.to)} your ${LIMB_BY_KEY[u.limb].name} slipped out of view.`,
    body: 'So anything about it in that stretch is a best guess. Filming from a bit further back (or the other side) gives the coach a better seat.', ref: refOf([], u.limb),
  })

  const order = (xs: Insight[]) => xs.sort((a, b) => b.cost - a.cost)
  return [...order(fixes), ...order(good), ...unsure]
}

// ── the best move ────────────────────────────────────────────────────────────

/** How much each kind of highlight is worth, so the pick can be tuned. Only
 *  things the measurements can actually show: a long reach, a run of moves
 *  with no pause, a hold skipped, a quick fix, a foot that stayed put. (Seventeen
 *  joints cannot tell a heel hook from a toe, so it never names one.) */
export const BEST_RULES = {
  reach: 1.0, // × (reach ÷ shoulder-to-hip length); a reach counts from 1.5 body-lengths of torso
  reachMin: 1.5,
  run: 0.45, // × placements in the longest run with no gap over runGap seconds
  runGap: 1.0,
  runMin: 4,
  skip: 2.2, // a hold your other attempts needed and this one skipped
  recovery: 1.6, // a slip fixed in under recoverySeconds
  recoverySeconds: 0.6,
  anchor: 0.35, // × seconds a foot stayed on one hold
}

export interface BestMove { title: string; body: string; time?: number; holds?: number[]; limbs?: LimbKey[]; kind: 'reach' | 'run' | 'skip' | 'recovery' | 'anchor' }

/** The one thing worth showing off, picked from what was measured. */
export function bestMove(s: Session): BestMove | null {
  const B = BEST_RULES
  const picks: (BestMove & { worth: number })[] = []
  const aspect = s.canvas.width / Math.max(1, s.canvas.height)
  const hold = (id: number) => s.holds.find((h) => h.id === id)
  // Body size on the canvas, from the scale estimate (0.5 m shoulder to hip) or the holds' spread.
  const ys = s.holds.map((h) => h.center[1])
  const torso = s.scale ? 0.5 / s.scale.metersPerUnit : (Math.max(...ys) - Math.min(...ys)) / 5 || 0.1

  // a long reach by one hand
  for (const l of ['left_hand', 'right_hand'] as LimbKey[]) {
    const ms = byLimb(s, l)
    for (let i = 1; i < ms.length; i++) {
      const a = hold(ms[i - 1].holdId), b = hold(ms[i].holdId)
      if (!a || !b || a.id === b.id) continue
      const d = Math.hypot((b.center[0] - a.center[0]) * aspect, b.center[1] - a.center[1])
      const rel = d / torso
      if (rel < B.reachMin || b.center[1] > a.center[1]) continue // only reaches upward
      const meters = s.scale ? ` (about ${(d * s.scale.metersPerUnit).toFixed(1)} m)` : ''
      picks.push({ kind: 'reach', worth: rel * B.reach, time: ms[i].time, holds: [a.id, b.id], limbs: [l], title: `That reach at ${at(ms[i].time)}? Huge.`, body: `Your ${LIMB_BY_KEY[l].name} went from ${describeHold(s, a.id)} to ${describeHold(s, b.id)} in one move${meters}. Zero hesitation.` })
    }
  }

  // a run of moves with no pause
  const times = [...new Set(s.moves.map((m) => m.time))].sort((x, y) => x - y)
  let start = 0, bestRun = [0, 0]
  for (let i = 1; i <= times.length; i++) {
    if (i === times.length || times[i] - times[i - 1] > B.runGap) { if (i - start > bestRun[1] - bestRun[0]) bestRun = [start, i]; start = i }
  }
  const runLen = bestRun[1] - bestRun[0]
  if (runLen >= B.runMin) {
    const from = times[bestRun[0]], to = times[bestRun[1] - 1]
    picks.push({ kind: 'run', worth: runLen * B.run, time: from, holds: handsAt(s, to), title: `From ${at(from)} to ${at(to)}: ${runLen} moves, no stopping.`, body: 'No hesitation, no fiddling. That is what flow looks like, and it looked good on you.' })
  }

  // a hold this attempt skipped
  const attempts = s.comparison?.attempts ?? []
  const mine = attempts.find((x) => x.isThis)
  if (mine) {
    const others = attempts.filter((x) => !x.isThis)
    const skipped = [...new Set(others.flatMap((o) => o.sequence))].filter((id) => !mine.sequence.includes(id) && others.filter((o) => o.sequence.includes(id)).length >= Math.max(1, others.length - 1))
    if (skipped.length) picks.push({ kind: 'skip', worth: B.skip, holds: skipped.slice(0, 1), title: `You skipped ${describeHold(s, skipped[0])}, which your other attempts needed.`, body: 'Going straight past it takes nerve, and it saved you time.' })
  }

  // a slip fixed fast
  const quick = regrabs(s).filter((r) => r.kind === 'reset' && r.lost <= B.recoverySeconds)[0]
  if (quick) picks.push({ kind: 'recovery', worth: B.recovery, time: quick.move.time, holds: [quick.move.holdId], limbs: [quick.move.limb], title: `Quick save at ${at(quick.move.time)}.`, body: `Your ${LIMB_BY_KEY[quick.move.limb].name} came off ${describeHold(s, quick.move.holdId)} and was back in ${secs(quick.lost, 1)}. Calm under pressure; the climb lived on because of it.` })

  // a foot that stayed put
  const anchor = [...s.moves].filter((m) => isFoot(m.limb)).sort((a, b) => b.duration - a.duration)[0]
  if (anchor && anchor.duration >= 2.5) picks.push({ kind: 'anchor', worth: anchor.duration * B.anchor, time: anchor.time, holds: [anchor.holdId], limbs: [anchor.limb], title: `Your ${LIMB_BY_KEY[anchor.limb].name} did not budge for ${secs(anchor.duration, 1)}.`, body: `It held ${describeHold(s, anchor.holdId)} while everything else moved. A foot you can trust makes every reach easier.` })

  picks.sort((a, b) => b.worth - a.worth)
  if (!picks.length) return null
  const { worth: _worth, ...top } = picks[0]
  return top
}

/** One plain sentence for the top of the results. */
export function verdict(s: Session, insights = coachInsights(s)): string {
  const T = climbTime(s)
  const t = secs(s.toppedOut ? s.elapsed ?? T : T, 1)
  // A little variety, but the same climb always reads the same.
  const lead = pickFor(s, s.toppedOut
    ? [`Clean send in ${t}.`, `Sent in ${t}. The wall never stood a chance.`, `Topped out in ${t}. Very smooth.`]
    : [`${t} on the wall, and the top is still up for grabs.`, `${t} of climbing. The wall took this round; the rematch is yours.`])
  const top = insights.find((i) => i.kind === 'fix')
  return `${lead} ${top?.short ?? (s.toppedOut ? 'Nothing big to fix. Run it back and chase a faster time.' : 'Nothing big went wrong. Next time, the top.')}`
}

/** One of a few phrasings, chosen by the climb itself so it never flickers. */
export function pickFor<T>(s: Pick<Session, 'id' | 'title'>, options: T[]): T {
  let h = 0
  for (const c of `${s.id}|${s.title}`) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return options[h % options.length]
}

export { cap as capitalize }
