import { MotionConfig } from 'framer-motion'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/open-sans'
import './styles/legacy.css'
import './styles/metro.css'
import './styles/screens.css'
import './styles/motion.css'
import App from './App'
import { installRipples } from './lib/fx'
import { applyTheme } from './lib/store'

applyTheme()
installRipples()
// Development only: log anything that runs off the side of the screen.
if (import.meta.env.DEV) import('./lib/devOverflow').then((m) => m.watchOverflow())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honors the system's "reduce motion" setting for every animation. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)
