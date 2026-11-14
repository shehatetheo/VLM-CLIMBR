import { polygonPath } from '../lib/geometry'
import { LIMB_JOINT, overlayAt } from '../lib/overlay'
import { BONES, DRAW_MIN_CONFIDENCE } from '../lib/skeleton'
import type { Timeline } from '../lib/timeline'
import { LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type LimbKey, type Session, type Vec2 } from '../lib/types'

/** What the models saw, drawn live over the video from the saved analysis:
 *  hold outlines and the skeleton. SVG in the video's own pixels, letterboxed
 *  exactly as the video is, so it stays sharp and lined up at any size.
 *  `fit` must match the video's object-fit. */
export function VideoOverlay({ session: s, tl, t, fit = 'contain', focusLimbs = [], focusHolds = [] }: { session: Session; tl: Timeline; t: number; fit?: 'contain' | 'cover'; focusLimbs?: LimbKey[]; focusHolds?: number[] }) {
  const v = s.video
  const aspect = v?.width && v?.height ? v.width / v.height : null
  if (!v || !aspect) return null
  const ov = overlayAt(s, tl, t)
  if (!ov) return null
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const toV = (q: Vec2): Vec2 => [q[0] * 1000 * aspect, q[1] * 1000]
  return (
    <svg className="video-overlay" viewBox={`0 0 ${1000 * aspect} 1000`} preserveAspectRatio={fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'} aria-hidden>
      {ov.holds.map((h) => {
        const hot = focusHolds.includes(h.id)
        return <path key={h.id} d={polygonPath(h.poly, toV)} fill={h.lit || hot ? route : 'none'} fillOpacity={h.held || hot ? 0.6 : 0.4} stroke={h.held || hot ? '#fff' : route} strokeWidth={hot ? 6 : h.held ? 3.5 : 2.5} strokeOpacity={0.95} strokeLinejoin="round" />
      })}
      {ov.joints && (
        <g className="pose">
          {BONES.map(([a, b]) => ov.joints![a].c >= DRAW_MIN_CONFIDENCE && ov.joints![b].c >= DRAW_MIN_CONFIDENCE && (
            <line key={`${a}-${b}`} x1={toV(ov.joints![a].p)[0]} y1={toV(ov.joints![a].p)[1]} x2={toV(ov.joints![b].p)[0]} y2={toV(ov.joints![b].p)[1]} stroke="#fff" strokeOpacity={0.85} strokeWidth={3} strokeLinecap="round" />
          ))}
          {ov.joints.map((j, i) => j.c >= DRAW_MIN_CONFIDENCE && i > 4 && !Object.values(LIMB_JOINT).includes(i) && <circle key={i} cx={toV(j.p)[0]} cy={toV(j.p)[1]} r={4} fill="#fff" />)}
          {LIMBS.map((l) => {
            const j = ov.joints![LIMB_JOINT[l.key]]
            if (j.c < DRAW_MIN_CONFIDENCE) return null
            const [x, y] = toV(j.p)
            return (
              <g key={l.key}>
                {focusLimbs.includes(l.key) && <circle cx={x} cy={y} r={22} fill="none" stroke="#fff" strokeWidth={4} />}
                <circle cx={x} cy={y} r={ov.holding.get(l.key) != null ? 10 : 6.5} fill={l.color} stroke="#000" strokeWidth={2} />
              </g>
            )
          })}
        </g>
      )}
      {ov.fallbackLimbs.map(({ key, p }) => {
        const [x, y] = toV(p)
        return <circle key={key} cx={x} cy={y} r={7} fill={LIMB_BY_KEY[key].color} stroke="#000" strokeWidth={2} />
      })}
    </svg>
  )
}
