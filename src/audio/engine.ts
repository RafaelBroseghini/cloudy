// Web Audio for thunder. Plain AudioContext, created on the first user gesture and never before.
// iOS: the context is left on the platform default category, so the silent switch is respected and other audio mixes.
// (This file must not touch the page-level audio session API; a test greps src/ for it.)
import {
  MAX_VOICES,
  latencyOf,
  renderNowFromTimestamp,
  thunderVoice,
  type Clocks,
  type Strike,
  type ThunderPort,
} from '../strikes/index.ts'
import { thunderUrls } from './manifest.ts'

export interface AudioReport {
  /** "none" until the first gesture creates the context; then the context state ("running", "suspended", ...). */
  state: string
  /** Seconds, or null before the context exists / when the browser does not report it. */
  outputLatency: number | null
}

type AudioCtor = typeof AudioContext

export interface AudioEngine {
  /** Create / resume the context. Must be called from a user-gesture handler. */
  unlock(): void
  clocks(): Clocks
  latency(): number
  currentTime(): number
  report(): AudioReport
  readonly thunder: ThunderPort
}

export function createAudioEngine(baseUrl: string): AudioEngine {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let buffers: AudioBuffer[] = []
  let voices = 0

  // Fetch the clip bytes now (no context needed); decode once when the context exists. Failure leaves the game silent.
  const dir = `${baseUrl}audio/`
  const raw: Promise<ArrayBuffer[]> = fetch(`${dir}thunder.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((m: unknown) =>
      Promise.all(
        thunderUrls(m, dir).map((u) =>
          fetch(u)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null),
        ),
      ),
    )
    .then((l) => l.filter((b): b is ArrayBuffer => b !== null))
    .catch(() => [])

  const decodeAll = async (c: AudioContext): Promise<void> => {
    const out: AudioBuffer[] = []
    for (const b of await raw) {
      try {
        out.push(await c.decodeAudioData(b.slice(0)))
      } catch {
        // a bad clip is skipped
      }
    }
    buffers = out
  }

  // Fallback clock when getOutputTimestamp is missing or empty: currentTime ticks in blocks, so add the time since it ticked.
  let lastCt = -1
  let lastCtPerf = 0

  const running = (): boolean => ctx !== null && ctx.state === 'running'

  function renderNow(c: AudioContext): number {
    const perfNow = performance.now()
    const latency = latencyOf(c)
    let t = c.currentTime
    if (c.currentTime !== lastCt) {
      lastCt = c.currentTime
      lastCtPerf = perfNow
    }
    const ts = typeof c.getOutputTimestamp === 'function' ? c.getOutputTimestamp() : null
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      t = renderNowFromTimestamp({ contextTime: ts.contextTime, performanceTime: ts.performanceTime }, perfNow, latency)
    } else {
      t += Math.min(0.1, Math.max(0, (perfNow - lastCtPerf) / 1000))
    }
    // The render clock is never behind the context's own.
    return Math.max(t, c.currentTime)
  }

  function unlock(): void {
    if (!ctx) {
      const Ctor: AudioCtor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
      if (!Ctor) return
      try {
        ctx = new Ctor()
      } catch {
        return
      }
      master = ctx.createGain()
      master.gain.value = 0.9
      master.connect(ctx.destination)
      void decodeAll(ctx)
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {})
  }

  const thunder: ThunderPort = {
    get loaded() {
      return buffers.length > 0
    },
    get voiceFree() {
      return voices < MAX_VOICES
    },
    start(strike: Strike, startAt: number): void {
      const c = ctx
      if (!c || !master || buffers.length === 0) return
      const v = thunderVoice(strike, buffers.length)
      const src = c.createBufferSource()
      src.buffer = buffers[v.file] ?? null
      src.playbackRate.value = v.rate
      const lp = c.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = v.lowpassHz
      const g = c.createGain()
      // A 15 ms ramp-in keeps a clip that starts mid-waveform from clicking.
      g.gain.setValueAtTime(0, startAt)
      g.gain.linearRampToValueAtTime(v.gain, startAt + 0.015)
      src.connect(lp).connect(g).connect(master)
      voices += 1
      src.onended = () => {
        voices -= 1
        src.disconnect()
        lp.disconnect()
        g.disconnect()
      }
      src.start(startAt)
    },
  }

  document.addEventListener('visibilitychange', () => {
    // Returning to the tab after the OS suspended or interrupted the context.
    if (!document.hidden && ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {})
  })

  return {
    unlock,
    clocks: () => ({ perf: performance.now() / 1000, audio: ctx && running() ? renderNow(ctx) : null }),
    latency: () => (ctx ? latencyOf(ctx) : 0),
    currentTime: () => (ctx ? ctx.currentTime : 0),
    report: () => ({
      state: ctx ? ctx.state : 'none',
      outputLatency: ctx && typeof ctx.outputLatency === 'number' && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : null,
    }),
    thunder,
  }
}

/** Create the context from the first gesture. iOS only counts touchend (not pointerdown) as activation for audio. */
export function installUnlock(engine: Pick<AudioEngine, 'unlock'>, target: Window = window): void {
  const events = ['pointerdown', 'touchend', 'keydown'] as const
  const handler = (): void => engine.unlock()
  // Kept for the session: a suspended / interrupted context is resumed by the next gesture too (cheap when running).
  for (const e of events) target.addEventListener(e, handler, { passive: true })
}
