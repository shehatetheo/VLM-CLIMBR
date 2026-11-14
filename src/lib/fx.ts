// Touch feedback for the common buttons: a soft ripple of light spreads from
// where the finger landed. One listener for the whole app, so every button
// gets it without a wrapper. Skipped when the system asks for less motion.
const TARGETS = '.gbtn, .btn, .row, .theme, .feed-rail button, .grades button, .tab, .blade'

export function installRipples() {
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)')
  document.addEventListener('pointerdown', (e) => {
    if (calm.matches || e.button > 0) return
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(TARGETS)
    if (!el || (el as HTMLButtonElement).disabled) return
    const box = el.getBoundingClientRect()
    const size = Math.hypot(box.width, box.height) * 2
    const clip = document.createElement('span')
    clip.className = 'fx-ripple'
    const dot = document.createElement('i')
    dot.style.width = dot.style.height = `${size}px`
    dot.style.left = `${e.clientX - box.left - size / 2}px`
    dot.style.top = `${e.clientY - box.top - size / 2}px`
    clip.appendChild(dot)
    el.appendChild(clip)
    dot.addEventListener('animationend', () => clip.remove(), { once: true })
    setTimeout(() => clip.remove(), 1000) // in case the animation never ran
  }, { passive: true })
}
