// Did the climb finish? Sent, unfinished or unclear, with the reason in plain
// words. Like the score, a pure function of the Session: nothing is guessed,
// and when the clip does not show enough to tell, it says so.

import { LIMB_BY_KEY, type LimbKey, type Session } from './types'

export type ClimbStatus = 'sent' | 'unfinished' | 'unclear'

/** Every threshold in one place. */
export const STATUS_RULES = {
  cutShort: 0.6, // seconds: a climb that ends this close to the end of the clip may have been cut off
  lowConfidence: 0.3, // a joint below this is not trusted
  unseenShare: 0.5, // the hands unseen for this share of the last 3 s makes the ending unclear
  fallSpeed: 0.35, // screen heights per second the hips must drop to call it a fall
  swing: 0.12, // screen widths the hips must move sideways in the last second to call it a swing
}

export interface StatusRead {
  status: ClimbStatus
  title: string // "you sent it" / "so close" / "we couldn't tell"
  detail: string // one or two plain sentences
  time?: number // climb seconds where it ended
  reached?: { rank: number; of: number; holdId: number } // highest hold reached, counted from the bottom
  ending?: 'fell' | 'let-go' | 'cut-off' | 'unknown'
}

const HANDS: LimbKey[] = ['left_hand', 'right_hand']

/** How long both hands shared a hold, in seconds. */
function matchSeconds(s: Session, holdId: number) {
  const on = (l: LimbKey) => s.moves.filter((m) => m.limb === l && m.holdId === holdId)
  let best = 0
  for (const a of on('left_hand')) for (const b of on('right_hand')) best = Math.max(best, Math.min(a.time + a.duration, b.time + b.duration) - Math.max(a.time, b.time))
  return best
}

/** Hip centre in video coordinates around a moment, or null where the pose is missing. */
function hipsAt(s: Session, t: number): [number, number] | null {
  const pose = s.pose
  if (!pose?.t.length) return null
  const vt = t + (s.video?.offset ?? 0)
  let i = 0
  for (let k = 1; k < pose.t.length; k++) if (Math.abs(pose.t[k] - vt) < Math.abs(pose.t[i] - vt)) i = k
  if (Math.abs(pose.t[i] - vt) > 0.3) return null
  const k = pose.k[i]
  const [lx, ly, lc, rx, ry, rc] = [k[33], k[34], k[35], k[36], k[37], k[38]]
  if (lc < STATUS_RULES.lowConfidence && rc < STATUS_RULES.lowConfidence) return null
  return lc >= rc ? (rc >= STATUS_RULES.lowConfidence ? [(lx + rx) / 2, (ly + ry) / 2] : [lx, ly]) : (lc >= STATUS_RULES.lowConfidence ? [(lx + rx) / 2, (ly + ry) / 2] : [rx, ry])
}

/** Share of the last `window` seconds in which neither wrist could be seen. */
function handsUnseen(s: Session, end: number, window = 3) {
  const pose = s.pose
  if (!pose?.t.length) return 0
  const off = s.video?.offset ?? 0
  let n = 0, bad = 0
  pose.t.forEach((vt, i) => {
    const t = vt - off
    if (t < end - window || t > end) return
    n++
    if ((pose.k[i][9 * 3 + 2] ?? 0) < STATUS_RULES.lowConfidence && (pose.k[i][10 * 3 + 2] ?? 0) < STATUS_RULES.lowConfidence) bad++
  })
  return n ? bad / n : 0
}

export function climbStatus(s: Session): StatusRead {
  const R = STATUS_RULES
  const used = s.holds.filter((h) => s.sequence.includes(h.id)).sort((a, b) => b.center[1] - a.center[1]) // bottom first
  const routeHolds = [...s.holds].sort((a, b) => b.center[1] - a.center[1])
  const lastEnd = s.moves.reduce((t, m) => Math.max(t, m.time + m.duration), 0)
  const clipEnd = s.video?.duration != null ? s.video.duration - (s.video.offset ?? 0) : s.duration
  const cutOff = clipEnd - lastEnd < R.cutShort

  // Sent: both hands on the top hold, and they stayed.
  if (s.toppedOut && s.finalHoldId != null) {
    const held = matchSeconds(s, s.finalHoldId)
    // The reader only calls a top-out once both hands have stayed on the top
    // hold, and it stops the climb's clock right there: any shared time is a send.
    if (held > 0 || s.kind === 'example') {
      return { status: 'sent', title: 'you sent it', detail: `Both hands on the top hold${s.elapsed != null ? ` at ${s.elapsed.toFixed(1)}s` : ''}. That is a send. Take a bow.`, time: s.elapsed ?? undefined }
    }
  }

  const top = used[used.length - 1]
  const reached = top ? { rank: routeHolds.findIndex((h) => h.id === top.id) + 1, of: routeHolds.length, holdId: top.id } : undefined
  const lastHand = [...s.moves].filter((m) => HANDS.includes(m.limb)).sort((a, b) => b.time - a.time)[0]
  const nearTop = reached ? reached.rank >= reached.of - 1 : false

  // Unclear: the clip does not show the ending.
  if (!s.moves.length) return { status: 'unclear', title: 'we couldn’t tell', detail: 'We could not spot you on the holds in this clip. Step the camera back so your whole body and the whole route fit in the frame, and we will be all eyes.', ending: 'unknown' }
  const unseen = handsUnseen(s, lastEnd)
  if (unseen >= R.unseenShare || (cutOff && nearTop)) {
    return {
      status: 'unclear', title: 'we couldn’t tell', time: lastEnd, reached, ending: cutOff ? 'cut-off' : 'unknown',
      detail: cutOff
        ? 'The video ended while you were still near the top, so the ending is a mystery. Keep filming until your feet are back on the mat.'
        : 'Your hands slipped out of view near the end, so we could not call the top-out. Fit the whole route and your whole body in the frame next time.',
    }
  }

  // Unfinished: how far, and how it ended.
  let ending: StatusRead['ending'] = cutOff ? 'cut-off' : 'let-go'
  let cause = ''
  const before = hipsAt(s, lastEnd - 1), at = hipsAt(s, lastEnd), after = hipsAt(s, lastEnd + 0.6)
  if (at && after && (after[1] - at[1]) / 0.6 > R.fallSpeed) ending = 'fell'
  if (before && at && Math.abs(at[0] - before[0]) > R.swing) cause = ` Your hips swung ${at[0] > before[0] ? 'right' : 'left'} just before, which peels you off the wall. Keep them close on that move and it is yours.`
  const how = ending === 'fell' ? 'gravity caught up with you' : ending === 'cut-off' ? 'the video ended' : 'you let go or stepped off'
  const where = reached ? `You made it to hold ${reached.rank} of ${reached.of}${reached.rank >= reached.of ? ', the top hold. Match it and hang on one more second next time: the send is right there.' : reached.rank === reached.of - 1 ? ', one hold from glory.' : '.'}` : 'You got on the wall, and that is step one.'
  const limb = lastHand ? ` Your ${LIMB_BY_KEY[lastHand.limb].name} was the last to move.` : ''
  return { status: 'unfinished', title: 'so close', time: lastEnd, reached, ending, detail: `${where} At ${lastEnd.toFixed(1)}s ${how}.${ending === 'cut-off' ? '' : limb}${cause}` }
}
