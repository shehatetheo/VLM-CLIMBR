import { Globe, Lock, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudEnabled, saveClimb, setVisibility, sharedMessage } from '../lib/cloud'
import { saveSession } from '../lib/store'
import type { Session } from '../lib/types'
import { GlossButton, SectionHeader } from '../ui'
import { toast } from './Toast'

/** After the results: the climb is saved online (private), and can then be
 *  shared to the feed. Private is the default; sharing is always a choice. */
export function CloudSave({ session: s, onUpdate }: { session: Session; onUpdate: (s: Session) => void }) {
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'failed'>(s.cloudId ? 'saved' : 'idle')
  const [progress, setProgress] = useState(0)
  const [shared, setShared] = useState<'private' | 'review' | 'feed'>('private')
  const started = useRef(false)
  const local = s.kind === 'live' && !s.id.startsWith('c-')

  const save = useCallback(async () => {
    setPhase('saving'); setProgress(0)
    try {
      const cloudId = await saveClimb(s, setProgress)
      const next = { ...s, cloudId }
      await saveSession(next)
      onUpdate(next)
      setPhase('saved')
    } catch (e) {
      setPhase('failed')
      toast((e as Error).message, 'warn')
    }
  }, [s, onUpdate])
  // A freshly analyzed climb saves itself once.
  useEffect(() => {
    if (!cloudEnabled || !local || s.cloudId || started.current) return
    started.current = true
    save()
  }, [local, s.cloudId, save])

  const share = async (v: 'private' | 'public') => {
    if (!s.cloudId) return
    try {
      const approved = await setVisibility(s.cloudId, v)
      setShared(v === 'private' ? 'private' : approved ? 'feed' : 'review')
      toast(v === 'public' ? sharedMessage(approved) : 'Kept private.')
    } catch (e) { toast((e as Error).message, 'warn') }
  }

  if (!local) return null
  return (
    <section className="panel cloud-save" aria-label="Save and share">
      <SectionHeader onPanel title="share it?" sub="private unless you say so. anyone can report a shared climb, and reported ones are hidden." />
      {!cloudEnabled && <p className="muted">Sharing is not switched on yet. Your climb is saved on this device.</p>}
      {phase === 'saving' && (
        <div className="progress-capsule" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <i style={{ width: `${Math.max(6, progress * 100)}%` }} /><span>saving your climb… {Math.round(progress * 100)}%</span>
        </div>
      )}
      {phase === 'failed' && <GlossButton tone="chrome" onClick={save}><RotateCcw size={16} /> try saving again</GlossButton>}
      {phase === 'saved' && (
        <div className="share-row">
          <GlossButton onClick={() => share('public')} disabled={shared !== 'private'}><Globe size={16} /> {shared === 'feed' ? 'in the feed' : shared === 'review' ? 'in review' : 'share to feed'}</GlossButton>
          <GlossButton tone="chrome" onClick={() => share('private')}><Lock size={16} /> keep private</GlossButton>
        </div>
      )}
    </section>
  )
}
