// Background art, all SVG and all drawn in currentColor (or a CSS variable), so
// a theme recolors it for free. Climbing-gym takes on the Frutiger Metro kit:
// ring bursts, halftone dots, outlined stars, rope swooshes, chalk drips, and
// a skyline built from climbing walls.
import { useId, type CSSProperties } from 'react'

type P = { className?: string; style?: CSSProperties }

/** Concentric rings, like a speaker cone or a target. */
export function RingBurst({ rings = 5, className, style }: P & { rings?: number }) {
  return (
    <svg viewBox="0 0 200 200" className={className} style={style} aria-hidden>
      {Array.from({ length: rings }, (_, i) => {
        const r = 96 - i * (92 / rings)
        return <circle key={i} cx="100" cy="100" r={r} fill={i % 2 ? 'var(--art-2, #fff)' : 'currentColor'} opacity={i % 2 ? 0.9 : 1} />
      })}
    </svg>
  )
}

/** A halftone dot field that fades out from one corner. */
export function Halftone({ className, style }: P) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="0 0 200 200" className={className} style={style} aria-hidden>
      <defs>
        <pattern id={`h${id}`} width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="3.2" fill="currentColor" /></pattern>
        <radialGradient id={`g${id}`} cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#000" /></radialGradient>
        <mask id={`m${id}`}><rect width="200" height="200" fill={`url(#g${id})`} /></mask>
      </defs>
      <rect width="200" height="200" fill={`url(#h${id})`} mask={`url(#m${id})`} />
    </svg>
  )
}

const starPath = (cx: number, cy: number, r: number) => Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.42 : r
  return `${i ? 'L' : 'M'}${(cx + Math.cos(a) * rr).toFixed(1)} ${(cy + Math.sin(a) * rr).toFixed(1)}`
}).join('') + 'Z'

/** Outlined stars with a white fill, scattered. */
export function StarField({ className, style, count = 5 }: P & { count?: number }) {
  const stars = [[30, 40, 22], [150, 30, 14], [170, 130, 20], [60, 150, 12], [105, 95, 9], [20, 110, 8]].slice(0, count)
  return (
    <svg viewBox="0 0 200 200" className={className} style={style} aria-hidden>
      {stars.map(([x, y, r], i) => <path key={i} d={starPath(x, y, r)} fill="var(--art-2, #fff)" stroke="currentColor" strokeWidth={r * 0.22} strokeLinejoin="round" />)}
    </svg>
  )
}

/** A rope-like swoosh. */
export function Swoosh({ className, style }: P) {
  return (
    <svg viewBox="0 0 400 120" className={className} style={style} preserveAspectRatio="none" aria-hidden>
      <path d="M-10 90 C 80 10, 160 130, 250 50 S 380 20, 420 70" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
      <path d="M-10 90 C 80 10, 160 130, 250 50 S 380 20, 420 70" fill="none" stroke="var(--art-2, #fff)" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 12" />
    </svg>
  )
}

/** A skyline of climbing walls: angled panels dotted with holds. */
export function Skyline({ className, style }: P) {
  const walls: [number, number, number, number][] = [[0, 70, 62, 46], [56, 38, 60, 60], [112, 84, 52, 70], [160, 22, 66, 40], [222, 58, 58, 76], [276, 44, 64, 30], [336, 76, 70, 58]]
  return (
    <svg viewBox="0 0 400 160" className={className} style={style} preserveAspectRatio="xMidYMax slice" aria-hidden>
      {walls.map(([x, top, w, lean], i) => {
        const tip = top + (i % 2 ? 18 : -6)
        return (
          <g key={i}>
            <path d={`M${x} 160 L${x} ${top} L${x + w * (lean / 100)} ${tip} L${x + w} ${top + 12} L${x + w} 160Z`} fill="currentColor" />
            {Array.from({ length: 7 }, (_, k) => {
              const hx = x + 8 + ((k * 23 + i * 11) % Math.max(10, w - 16)), hy = top + 26 + ((k * 31 + i * 17) % Math.max(20, 150 - top - 30))
              return <ellipse key={k} cx={hx} cy={hy} rx={3 + (k % 3)} ry={2.4 + ((k + i) % 2)} fill="var(--art-2, #fff)" opacity="0.9" transform={`rotate(${k * 40} ${hx} ${hy})`} />
            })}
          </g>
        )
      })}
    </svg>
  )
}

/** Chalk drips under a divider. */
export function ChalkDrip({ className, style }: P) {
  return (
    <svg viewBox="0 0 400 40" className={className} style={style} preserveAspectRatio="none" aria-hidden>
      <path d="M0 0H400V8H352c0 10-3 20-6 20s-5-10-5-20H228c0 16-3 30-7 30s-6-14-6-30H96c0 8-2 14-5 14s-5-6-5-14H0Z" fill="currentColor" />
    </svg>
  )
}

/** The marker scribble under the active tab. */
export function Scribble({ className, style }: P) {
  return (
    <svg viewBox="0 0 60 8" className={className} style={style} preserveAspectRatio="none" aria-hidden>
      <path d="M2 5 C 10 1, 16 7, 24 4 S 40 2, 46 5 58 3 58 3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

/** One background scene per screen. Decoration only: it sits behind every panel
 *  at low strength, and it never animates on a screen that plays video. */
export function Backdrop({ scene = 'rings' }: { scene?: 'rings' | 'skyline' | 'chalk' | 'plain' }) {
  if (scene === 'plain') return <div className="backdrop grain" aria-hidden />
  return (
    <div className="backdrop grain" aria-hidden>
      <Halftone style={{ width: '70vmin', top: '-12vmin', right: '-16vmin', opacity: 0.16 }} />
      {scene === 'rings' && <>
        <RingBurst className="drift" style={{ width: '46vmin', top: '6%', left: '-14vmin', opacity: 0.2 }} />
        <RingBurst className="drift b" rings={4} style={{ width: '30vmin', bottom: '20%', right: '-8vmin', opacity: 0.18 }} />
        <StarField className="drift b" style={{ width: '54vmin', top: '30%', right: '-6vmin', opacity: 0.3 }} />
      </>}
      {scene === 'skyline' && <>
        <RingBurst className="drift" style={{ width: '60vmin', top: '8%', right: '-18vmin', opacity: 0.18 }} />
        <StarField className="drift b" count={3} style={{ width: '40vmin', top: '10%', left: '-4vmin', opacity: 0.3 }} />
        <Skyline style={{ left: 0, right: 0, bottom: 0, width: '100%', height: '34%', opacity: 0.2 }} />
      </>}
      {scene === 'chalk' && <>
        <Halftone className="drift" style={{ width: '90vmin', bottom: '-20vmin', left: '-24vmin', opacity: 0.2 }} />
        <Swoosh className="drift b" style={{ width: '120%', left: '-10%', top: '34%', height: '18vmin', opacity: 0.18 }} />
        <StarField count={4} style={{ width: '50vmin', bottom: '18%', right: '-4vmin', opacity: 0.28 }} />
      </>}
    </div>
  )
}
