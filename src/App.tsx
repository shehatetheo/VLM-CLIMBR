import { SearchX } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Toaster } from './components/Toast'
import { health as fetchHealth, loadExample, type Health } from './lib/api'
import { whoosh } from './lib/sound'
import { getPrefs, loadSession } from './lib/store'
import type { Session } from './lib/types'
import { Backdrop, BladeTabBar, EmptyIcon, TABS, type TabId } from './ui'
import { AdminView } from './views/AdminView'
import { FeedView } from './views/FeedView'
import { ImportView } from './views/ImportView'
import { MyClimbsView } from './views/MyClimbsView'
import { Onboarding } from './views/Onboarding'
import { SessionView } from './views/SessionView'
import { SettingsView } from './views/SettingsView'

type Route = { name: TabId } | { name: 'welcome' } | { name: 'admin' } | { name: 'session'; id: string; results?: boolean }

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  if (h.startsWith('welcome')) return { name: 'welcome' }
  if (h.startsWith('admin')) return { name: 'admin' }
  if (h.startsWith('analyze') || h.startsWith('import')) return { name: 'analyze' }
  if (h.startsWith('climbs')) return { name: 'climbs' }
  if (h.startsWith('settings')) return { name: 'settings' }
  if (h.startsWith('session/')) {
    const [id, view] = h.slice(8).split('/')
    return { name: 'session', id: decodeURIComponent(id), results: view === 'results' || view === 'feedback' }
  }
  return { name: 'feed' }
}
const isTab = (r: Route): r is { name: TabId } => TABS.some((t) => t.id === r.name)
const SCENE: Record<TabId, 'rings' | 'skyline' | 'chalk'> = { feed: 'rings', analyze: 'chalk', climbs: 'skyline', settings: 'rings' }

export default function App() {
  const [route, setRoute] = useState<Route>(() => (getPrefs().onboarded || location.hash ? parse(location.hash) : { name: 'welcome' }))
  const [sessions, setSessions] = useState<Record<string, Session>>({})
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Tabs slide sideways like blades: the direction follows their order in the bar.
  const last = useRef(0)
  const index = isTab(route) ? TABS.findIndex((t) => t.id === route.name) : last.current
  const dir = index >= last.current ? 1 : -1
  useEffect(() => { last.current = index }, [index])

  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  useEffect(() => {
    fetchHealth().then(setHealth)
    loadExample().then((s) => setSessions((m) => ({ ...m, [s.id]: s }))).catch((e) => setError(String(e)))
  }, [])

  const go = useCallback((hash: string) => {
    whoosh()
    if (location.hash === hash) setRoute(parse(hash))
    else location.hash = hash
  }, [])
  const addSession = useCallback((s: Session) => setSessions((m) => ({ ...m, [s.id]: s })), [])

  // A climb opened by link loads on demand: from this device, or from the cloud.
  useEffect(() => {
    if (route.name !== 'session' || sessions[route.id] || route.id.startsWith('example')) return
    setError(null)
    const id = route.id
    const load = id.startsWith('c-') ? import('./lib/cloud').then((m) => m.loadCloudSession(id.slice(2))) : loadSession(id)
    load.then((s) => (s ? addSession({ ...s, id }) : setError('We could not find that climb.'))).catch(() => setError('We could not load that climb. Check your connection and try again.'))
  }, [route, sessions, addSession])

  const active = route.name === 'session' ? sessions[route.id] : undefined
  const example = sessions['example-green-vb'] ?? null

  if (route.name === 'welcome') return <div className="app"><Onboarding key="welcome" onDone={(to) => go(to)} /><Toaster /></div>
  if (route.name === 'admin') return <div className="app"><AdminView go={go} /><Toaster /></div>

  return (
    <div className="app">
      <div className={`shell ${route.name === 'session' ? 'in-session' : ''}`}>
        <Backdrop scene={isTab(route) ? SCENE[route.name] : 'plain'} />
        <main className="main">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            {isTab(route) ? (
              <motion.div key={route.name} className="blade-page" custom={dir} initial={{ x: `${dir * 28}%`, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: `${dir * -28}%`, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }}>
                {route.name === 'feed' && <FeedView example={example} go={go} />}
                {route.name === 'analyze' && <ImportView health={health} onHealth={setHealth} onSession={(s) => { addSession(s); go(`#/session/${encodeURIComponent(s.id)}/results`) }} />}
                {route.name === 'climbs' && <MyClimbsView example={example} go={go} />}
                {route.name === 'settings' && <SettingsView health={health} onHealth={setHealth} go={go} />}
              </motion.div>
            ) : active ? (
              <motion.div key={`s-${active.id}`} className="blade-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                <SessionView session={active} health={health} onUpdate={addSession} go={go} initialTab={route.name === 'session' && route.results ? 'results' : 'replay'} />
              </motion.div>
            ) : (
              <motion.div key="loading" className="loading-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {error ? <div className="empty"><EmptyIcon icon={SearchX} /><h3>hmm</h3><p>{error}</p><button className="gbtn chrome" onClick={() => go('#/climbs')}>back to my climbs</button></div> : <div className="spinner" />}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
        <BladeTabBar active={isTab(route) ? route.name : null} go={go} />
      </div>
      <Toaster />
    </div>
  )
}
