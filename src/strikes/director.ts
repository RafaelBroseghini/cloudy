// The strike director: scheduler -> strike records -> (flash, thunder). Pure; the clock, the audio and the reduced-motion
// query come in as ports, so tests run the exact path the game uses.
import { FULL_SHAPE, SOFT_SHAPE, STRIKE_LEAD } from './envelope.ts'
import { createRng } from './rng.ts'
import { drawStrike, createStrikeScheduler, type StrikeEvent } from './scheduler.ts'
import { flashAt, makeStrike, pruneStrikes, type FlashState, type Strike } from './strike.ts'
import { planThunder, type Clocks, type SkipReason } from './sync.ts'
import type { TransientLayer } from '../params/index.ts'

export interface ThunderPort {
  readonly loaded: boolean
  readonly voiceFree: boolean
  /** Start thunder for `strike` at render-clock `startAt`. */
  start(strike: Strike, startAt: number): void
}

export interface StrikePorts {
  clocks(): Clocks
  /** Seconds of output latency (0 when unknown). */
  latency(): number
  /** `ctx.currentTime`, 0 when there is no context. */
  currentTime(): number
  thunder: ThunderPort
  reducedMotion(): boolean
}

/** What the harness shows for a strike. */
export interface StrikeReport {
  readonly id: number
  readonly tStrike: number
  readonly clock: 'audio' | 'perf'
  readonly d: number
  readonly intensity: number
  readonly x: number
  /** The output latency the thunder start was shifted by (s). */
  readonly latency: number
  readonly scheduledThunderAt: number | null
  readonly skippedReason: SkipReason | null
}

export interface StrikeForce {
  intensity?: number
  d?: number
  x?: number
}

const MAX_DURATION = Math.max(FULL_SHAPE.duration, SOFT_SHAPE.duration)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function createStrikeDirector(seed: number, ports: StrikePorts) {
  const scheduler = createStrikeScheduler(seed)
  // Forced strikes draw from their own stream so poking the harness never changes the scheduled sequence.
  const forceRng = createRng((seed ^ 0x9e3779b9) >>> 0)
  let nextId = 1
  let active: Strike[] = []
  let count = 0
  let last: StrikeReport | null = null
  let hold: { strike: Strike; tau: number } | null = null

  const shape = () => (ports.reducedMotion() ? SOFT_SHAPE : FULL_SHAPE)

  function fire(e: StrikeEvent): StrikeReport {
    const now = ports.clocks()
    const strike = makeStrike(nextId++, e, now)
    const latency = ports.latency()
    const plan = planThunder(strike, {
      audioNow: now.audio,
      currentTime: ports.currentTime(),
      latency,
      loaded: ports.thunder.loaded,
      voiceFree: ports.thunder.voiceFree,
    })
    if (plan.kind === 'play') ports.thunder.start(strike, plan.startAt)
    active.push(strike)
    count += 1
    last = {
      id: strike.id,
      tStrike: strike.tStrike,
      clock: strike.clock,
      d: strike.d,
      intensity: strike.intensity,
      x: strike.x,
      latency,
      scheduledThunderAt: plan.kind === 'play' ? plan.startAt : null,
      skippedReason: plan.kind === 'skip' ? plan.reason : null,
    }
    return last
  }

  return {
    /** Once per fixed sim step with the resolved P.strikesEnabled / P.strikeRate. */
    step(dt: number, enabled: number, rate: number): void {
      for (const e of scheduler.step(dt, enabled >= 0.5, rate)) fire(e)
    },
    /** Fire a strike now (harness / debug); missing fields are drawn from a separate stream. */
    force(o: StrikeForce = {}): StrikeReport {
      const e = drawStrike(forceRng)
      return fire({
        ...e,
        intensity: o.intensity === undefined ? e.intensity : clamp(o.intensity, 0, 1),
        d: o.d === undefined ? e.d : Math.max(0, o.d),
        x: o.x === undefined ? e.x : clamp(o.x, 0, 1),
      })
    },
    /** Current flash (and where). Prunes finished strikes. */
    flash(): FlashState {
      if (hold) return flashAt([hold.strike], { audio: hold.strike.tStrike + hold.tau, perf: hold.strike.tStrike + hold.tau }, shape())
      const now = ports.clocks()
      active = pruneStrikes(active, now, MAX_DURATION)
      return flashAt(active, now, shape())
    },
    /** Debug: freeze the flash of the latest strike at `tau` seconds from its peak (null releases). */
    hold(tau: number | null): void {
      const s = active[active.length - 1]
      hold = tau === null || !s ? null : { strike: s, tau }
    },
    get count(): number {
      return count
    },
    get last(): StrikeReport | null {
      return last
    },
    lead: STRIKE_LEAD,
  }
}

export type StrikeDirector = ReturnType<typeof createStrikeDirector>

/** The transient layer a flash writes: post-FX only (the type has no interaction keys). */
export function flashLayer(f: FlashState): TransientLayer {
  return { fxFlash: f.value, fxFlashX: f.x }
}
