import { Film } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Player } from '../lib/player'
import type { Timeline } from '../lib/timeline'
import type { LimbKey, Session } from '../lib/types'
import { VideoOverlay } from './VideoOverlay'

/** The clip in a chrome bezel, with the live overlay on top. */
export function VideoStage({ session: s, player, tl, t, focusLimbs, focusHolds }: { session: Session; player: Player; tl: Timeline; t: number; focusLimbs?: LimbKey[]; focusHolds?: number[] }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    player.attachVideo(ref.current)
    return () => player.attachVideo(null)
  }, [player])
  const v = s.video
  const aspect = v?.width && v?.height ? v.width / v.height : null
  return (
    <div className="video-stage">
      <div className="video-frame chrome" style={{ aspectRatio: `${aspect ?? 9 / 16}`, ['--ar' as string]: aspect ?? 9 / 16 }}>
        <div className="video-glass">
          {v ? (
            <>
              <video ref={ref} poster={v.poster} muted playsInline preload="auto" className="video">
                <source src={v.src} type={v.src.endsWith('.webm') ? 'video/webm' : 'video/mp4'} />
                {v.webm && <source src={v.webm} type="video/webm" />}
              </video>
              <VideoOverlay session={s} tl={tl} t={t} focusLimbs={focusLimbs} focusHolds={focusHolds} />
            </>
          ) : s.wall ? (
            <img src={s.wall.src} className="video" alt="" />
          ) : (
            <div className="video-empty"><Film size={28} /><p>No video attached</p></div>
          )}
        </div>
      </div>
    </div>
  )
}
