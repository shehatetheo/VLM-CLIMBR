import { Dices, Moon, Sun, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConnectKey } from '../components/ConnectKey'
import { toast } from '../components/Toast'
import type { Health } from '../lib/api'
import { cloudEnabled, ensureUser, renameMe } from '../lib/cloud'
import { randomUsername } from '../lib/names'
import { click } from '../lib/sound'
import { applyTheme, getPrefs, setPrefs, type Mode, type Theme } from '../lib/store'
import { GlossButton, Logo, SectionHeader } from '../ui'

const THEMES: { id: Theme; name: string; sub: string; swatch: string }[] = [
  { id: 'lime', name: 'lime', sub: 'the classic', swatch: 'linear-gradient(180deg, #a6e86c, #4fa62a)' },
  { id: 'sunset', name: 'sunset', sub: 'orange glow', swatch: 'linear-gradient(180deg, #ffb347, #f07a00)' },
  { id: 'midnight', name: 'midnight', sub: 'navy and silver', swatch: 'linear-gradient(180deg, #2f4a7d, #0b1730)' },
]

export function SettingsView({ health, onHealth, go }: { health: Health | null; onHealth: (h: Health) => void; go: (h: string) => void }) {
  const [prefs, setLocal] = useState(getPrefs())
  const [username, setUsername] = useState(prefs.username ?? '')
  const update = (p: Partial<ReturnType<typeof getPrefs>>) => { setPrefs(p); setLocal(getPrefs()) }
  useEffect(() => {
    if (prefs.username) return
    // Every device gets a fun name; no real names anywhere.
    ensureUser().then((me) => { const name = me?.username ?? randomUsername(); update({ username: name }); setUsername(name) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shuffle = async () => {
    const name = randomUsername()
    setUsername(name)
    update({ username: name })
    click()
    if (cloudEnabled) renameMe(name).catch((e) => toast((e as Error).message, 'warn'))
  }
  const theme = prefs.theme ?? 'lime'
  const mode: Mode = prefs.mode ?? 'dark'
  const setMode = (m: Mode) => { update({ mode: m }); applyTheme(theme, m); click() }

  return (
    <section className="screen">
      <div className="wrap">
        <div className="page-head"><Logo height={32} /></div>
        <SectionHeader level={1} title="settings" />

        <div className="panel">
          <SectionHeader onPanel title="you" sub="a random name, so nobody sees your real one." />
          <div className="name-row">
            <b className="name">{username || '…'}</b>
            <GlossButton tone="chrome" size="sm" onClick={shuffle}><Dices size={16} /> new name</GlossButton>
          </div>
        </div>

        <div className="panel">
          <SectionHeader onPanel title="look" sub="dark or light, then pick your color." />
          <button className={`switch mode-switch ${mode === 'dark' ? 'on' : ''}`} role="switch" aria-checked={mode === 'dark'} onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>
            {mode === 'dark' ? <Moon size={18} /> : <Sun size={18} />}<span>{mode === 'dark' ? 'dark mode' : 'light mode'}</span><i />
          </button>
          <div className="themes" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme ${theme === t.id ? 'on' : ''}`} onClick={() => { update({ theme: t.id }); applyTheme(t.id, mode); click() }}>
                <i style={{ background: t.swatch }} />
                <b>{t.name}</b>
                <span>{t.sub}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <SectionHeader onPanel title="sounds" sub="little clicks and whooshes. off unless you turn them on." />
          <button className={`switch ${prefs.sounds ? 'on' : ''}`} role="switch" aria-checked={Boolean(prefs.sounds)} onClick={() => { update({ sounds: !prefs.sounds }); setTimeout(click, 30) }}>
            {prefs.sounds ? <Volume2 size={18} /> : <VolumeX size={18} />}<span>{prefs.sounds ? 'sounds on' : 'sounds off'}</span><i />
          </button>
        </div>

        <div className="panel">
          <SectionHeader onPanel title="the coach" sub={health?.connected ? 'connected and ready to analyze.' : 'the analysis needs a key before it can run.'} />
          {health?.ok ? (health.connected ? <p className="fine">Your clip is read by two vision models: one finds the holds, one follows your body.</p> : <ConnectKey health={health} onConnected={onHealth} />) : <p className="muted">{health === null ? 'Checking…' : 'The CLIMBR server is not reachable right now.'}</p>}
        </div>

        <div className="panel">
          <SectionHeader onPanel title="about" />
          <div className="rows">
            <button className="row" onClick={() => go('#/welcome')}><span className="grow"><b>replay the intro</b><span>how to film and what you get</span></span></button>
          </div>
          <p className="fine">No location is stored or shown. Videos you save are private unless you share them to the feed.</p>
          <p className="fine">Example footage: jeremyipark/vision-demos (Apache-2.0). Typeface: Selawik (SIL OFL).</p>
        </div>
      </div>
    </section>
  )
}
