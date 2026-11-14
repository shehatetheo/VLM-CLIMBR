// Optional interface sounds, synthesized: no files to load. Off by default
// (Settings → sounds). Nothing plays until the user has turned them on.
import { getPrefs } from './store'

let ctx: AudioContext | null = null
function tone(freq: number, to: number, ms: number, type: OscillatorType, gain: number) {
  if (!getPrefs().sounds) return
  try {
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(to, t + ms / 1000)
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + ms / 1000)
  } catch { /* no audio: stay silent */ }
}
export const click = () => tone(880, 520, 70, 'triangle', 0.08)
export const whoosh = () => tone(260, 720, 160, 'sine', 0.06)
export const pop = () => tone(520, 1040, 120, 'triangle', 0.09)
