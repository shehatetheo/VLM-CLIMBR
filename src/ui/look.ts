// The current look, read live from <html data-theme data-mode>: Settings
// changes those attributes in place, and anything drawn in the theme's color
// (the logo, the 3D art) follows at once.
import { useSyncExternalStore } from 'react'

const watch = (on: () => void) => {
  const mo = new MutationObserver(on)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] })
  return () => mo.disconnect()
}

export type LookTheme = 'lime' | 'sunset' | 'midnight'
export function useLook() {
  const theme = useSyncExternalStore(watch, () => document.documentElement.dataset.theme ?? 'lime') as LookTheme
  const mode = useSyncExternalStore(watch, () => document.documentElement.dataset.mode ?? 'dark')
  return { theme: (['lime', 'sunset', 'midnight'].includes(theme) ? theme : 'lime') as LookTheme, mode }
}
