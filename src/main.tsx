import { MotionConfig } from 'framer-motion'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import App from './App'

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
