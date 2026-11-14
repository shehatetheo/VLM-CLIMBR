// The component kit. Each one is a thin wrapper over a material class in
// styles/metro.css, so the look lives in one place.
import { BarChart3, Compass, Settings, Upload } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { Scribble } from './art'

export { Backdrop, ChalkDrip, Halftone, RingBurst, Scribble, Skyline, StarField, Swoosh } from './art'

type Btn = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'chrome' | 'orange' | 'quiet'; size?: 'sm' | 'md' | 'lg'; wide?: boolean; round?: boolean }
export function GlossButton({ tone = 'primary', size = 'md', wide, round, className = '', ...p }: Btn) {
  return <button {...p} className={`gbtn ${tone === 'primary' ? '' : tone} ${size === 'md' ? '' : size} ${wide ? 'wide' : ''} ${round ? 'round' : ''} ${className}`} />
}

export function GlossPill({ dot, children, className = '', ...p }: HTMLAttributes<HTMLSpanElement> & { dot?: string }) {
  return <span {...p} className={`gpill ${className}`}>{dot && <i style={{ background: dot }} />}{children}</span>
}

export function ChromeFrame({ className = '', ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={`chrome ${className}`} />
}

export function GlassPanel({ className = '', ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={`glass ${className}`} />
}

export function SectionHeader({ title, sub, level = 2, onPanel, children }: { title: string; sub?: string; level?: 1 | 2; onPanel?: boolean; children?: ReactNode }) {
  const H = level === 1 ? 'h1' : 'h2'
  return (
    <div className={`sec-title ${onPanel ? 'on-panel' : ''}`}>
      <H>{title}</H>
      <div className="rule" />
      {sub && <p>{sub}</p>}
      {children}
    </div>
  )
}

export type ClimbStatus = 'sent' | 'unfinished' | 'unclear'
const STICKER: Record<ClimbStatus | 'example', string> = { sent: 'sent!', unfinished: 'so close', unclear: 'not sure', example: 'example' }
export function StickerBadge({ kind, className = '' }: { kind: ClimbStatus | 'example'; className?: string }) {
  return <span className={`sticker ${kind === 'sent' ? '' : kind} ${className}`}>{STICKER[kind]}</span>
}

/** The score in a chrome ring. Counts up once, then a gloss sweep crosses it. */
export function ScoreBadge({ value, size = 132, animate = true, label }: { value: number; size?: number; animate?: boolean; label?: string }) {
  const [shown, setShown] = useState(animate ? 0 : value)
  useEffect(() => {
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 900)
      setShown(Math.round(value * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, animate])
  const r = 41, C = 2 * Math.PI * r
  return (
    <div className="score-badge chrome" style={{ width: size, height: size }} role="img" aria-label={`${label ?? 'Coach Score'} ${value} out of 100`}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="7" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--primary-b)" strokeWidth="7" strokeLinecap="round" transform="rotate(-90 50 50)" strokeDasharray={C} strokeDashoffset={C * (1 - shown / 100)} />
      </svg>
      <b className="num">{shown}</b>
      {animate && <i className="sweep" />}
    </div>
  )
}

export type TabId = 'feed' | 'analyze' | 'climbs' | 'settings'
export const TABS: { id: TabId; label: string; href: string; icon: ReactNode }[] = [
  { id: 'feed', label: 'feed', href: '#/', icon: <Compass size={20} /> },
  { id: 'analyze', label: 'analyze', href: '#/analyze', icon: <Upload size={20} /> },
  { id: 'climbs', label: 'my climbs', href: '#/climbs', icon: <BarChart3 size={20} /> },
  { id: 'settings', label: 'settings', href: '#/settings', icon: <Settings size={20} /> },
]
/** The bottom bar, after the dashboard "blades": chrome, lowercase, thumb zone. */
export function BladeTabBar({ active, go }: { active: TabId | null; go: (href: string) => void }) {
  return (
    <nav className="blades" aria-label="Main">
      <div className="blades-bar chrome">
        {TABS.map((t) => (
          <button key={t.id} className={`blade ${active === t.id ? 'on' : ''}`} aria-current={active === t.id ? 'page' : undefined} onClick={() => go(t.href)}>
            {t.icon}<span>{t.label}</span>
            {active === t.id && <Scribble className="scribble" />}
          </button>
        ))}
      </div>
    </nav>
  )
}

/** The wordmark, exactly as supplied, at the size asked for. */
export function Logo({ height = 32, className = '' }: { height?: number; className?: string }) {
  return <img className={`logo ${className}`} src="/brand/logo-330.webp" srcSet="/brand/logo-330.webp 330w, /brand/logo-660.webp 660w, /brand/logo-990.webp 990w" sizes={`${Math.round(height * 1.79)}px`} alt="CLIMBR" style={{ height }} width={Math.round(height * 1.79)} height={height} />
}
