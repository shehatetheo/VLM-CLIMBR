import { useState } from 'react'
import { toast } from '../components/Toast'
import { GlossButton, SectionHeader } from '../ui'

interface Pending { id: string; title: string; username: string; status: string; coach_score: number; reports: number; created_at: string; videoUrl: string | null }

/** Moderation, at /#/admin. The password is checked on the server (api/admin),
 *  never here: this page holds no secret and can do nothing without it. */
export function AdminView({ go }: { go: (h: string) => void }) {
  const [password, setPassword] = useState('')
  const [items, setItems] = useState<Pending[] | null>(null)
  const [busy, setBusy] = useState(false)

  const call = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password }, body: JSON.stringify(body) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error ?? `Failed (${res.status})`)
    return j
  }
  const load = async () => {
    setBusy(true)
    try { setItems((await call({ action: 'list' })).items) } catch (e) { toast((e as Error).message, 'warn') } finally { setBusy(false) }
  }
  const review = async (id: string, approve: boolean) => {
    try { await call({ action: 'review', id, approve }); setItems((xs) => xs?.filter((x) => x.id !== id) ?? null); toast(approve ? 'Approved' : 'Rejected') } catch (e) { toast((e as Error).message, 'warn') }
  }

  return (
    <section className="screen admin">
      <div className="wrap">
        <SectionHeader level={1} title="review" sub="shared climbs waiting for approval, and reported ones." />
        {items === null ? (
          <form className="panel" onSubmit={(e) => { e.preventDefault(); load() }}>
            <label className="field"><span>Admin password</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
            <div className="admin-actions"><GlossButton disabled={!password || busy}>{busy ? 'checking…' : 'open the queue'}</GlossButton><GlossButton type="button" tone="quiet" onClick={() => go('#/')}>back</GlossButton></div>
          </form>
        ) : items.length === 0 ? (
          <div className="empty"><h3>all caught up</h3><p>Nothing is waiting for review.</p><GlossButton tone="chrome" onClick={load}>refresh</GlossButton></div>
        ) : items.map((c) => (
          <div key={c.id} className="panel admin-item">
            {c.videoUrl ? <video src={c.videoUrl} controls playsInline muted preload="metadata" /> : <p className="muted">The video could not be loaded.</p>}
            <div>
              <b>{c.title}</b>
              <p className="fine">{c.username} · score {c.coach_score} · {c.status} · {new Date(c.created_at).toLocaleString()}{c.reports ? ` · ${c.reports} report${c.reports > 1 ? 's' : ''}` : ''}</p>
              <div className="admin-actions"><GlossButton onClick={() => review(c.id, true)}>approve</GlossButton><GlossButton tone="orange" onClick={() => review(c.id, false)}>reject</GlossButton></div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
