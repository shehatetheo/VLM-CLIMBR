// Development only: report anything that runs off the side of the screen.
// Loaded from main.tsx behind import.meta.env.DEV, so none of it ships.
//
// After each render settles it logs every element that is wider than the
// viewport or sticks out past its right or left edge, unless an ancestor
// scrolls sideways on purpose (the limb timeline, for one).

function scrollsSideways(el: Element): boolean {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX
    if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true
  }
  return false
}

export function findOverflow(): { el: Element; why: string }[] {
  const vw = document.documentElement.clientWidth
  const out: { el: Element; why: string }[] = []
  if (document.documentElement.scrollWidth > vw) out.push({ el: document.documentElement, why: `page scrolls sideways: ${document.documentElement.scrollWidth}px > ${vw}px` })
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue // an <svg> clips its own drawing
    if (el.closest('.backdrop')) continue // decoration, clipped by its own layer
    const own = cs.overflowX === 'auto' || cs.overflowX === 'scroll' // a box that scrolls sideways on purpose is not a bug
    if (el.scrollWidth > vw) { if (!own && !scrollsSideways(el)) out.push({ el, why: `content ${el.scrollWidth}px wide in a ${vw}px viewport` }); continue }
    if ((r.right > vw + 1 || r.left < -1) && !scrollsSideways(el)) out.push({ el, why: `box ${Math.round(r.left)}…${Math.round(r.right)}px, viewport 0…${vw}px` })
  }
  return out
}

export function watchOverflow() {
  let timer = 0, last = ''
  const run = () => {
    const found = findOverflow()
    const key = found.map((f) => `${f.el.tagName}.${f.el.className}|${f.why}`).join('\n')
    if (key === last) return
    last = key
    if (!found.length) return
    console.groupCollapsed(`%c[overflow] ${found.length} element${found.length > 1 ? 's' : ''} off-screen at ${document.documentElement.clientWidth}px`, 'color:#f5b84a')
    for (const f of found) console.warn(f.why, f.el)
    console.groupEnd()
  }
  const later = () => { clearTimeout(timer); timer = window.setTimeout(run, 400) }
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  window.addEventListener('resize', later)
  later()
  ;(window as unknown as { __climbrOverflow: typeof findOverflow }).__climbrOverflow = findOverflow
}
