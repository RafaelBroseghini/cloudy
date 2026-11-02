// Pure timing for one strike: the clock mapping, the output latency, and the thunder start / skip decision.
//
// Time domains. A strike lives on one clock, chosen when it is created:
//  - "audio": the AudioContext render clock R (the clock `source.start(when)` takes). R(now) is extrapolated from
//    `getOutputTimestamp()` (smooth; `currentTime` ticks in render blocks) plus the output latency, because the
//    timestamp names the sample that is leaving the speaker now (R - latency).
//  - "perf": `performance.now() / 1000`, used while audio is locked or suspended. Flash only, no thunder.
// tStrike is the instant the flash peaks. Thunder is started at R = tStrike + d - L and so leaves the speaker
// when R reads tStrike + d: heard - flash peak = d for every L >= 0.

export type ClockDomain = 'audio' | 'perf'

/** Both readings at one instant: `audio` is null when the context is missing or not running. */
export interface Clocks {
  readonly audio: number | null
  readonly perf: number
}

export interface OutputTimestamp {
  readonly contextTime: number
  readonly performanceTime: number
}

/** Seconds of output latency to use: `outputLatency`, else `baseLatency`, else 0. Never negative or non-finite. */
export function latencyOf(ctx: { readonly outputLatency?: number; readonly baseLatency?: number }): number {
  const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const v = ok(ctx.outputLatency) ? ctx.outputLatency : ok(ctx.baseLatency) ? ctx.baseLatency : 0
  return Math.min(1, v)
}

/**
 * Render-clock now from an output timestamp: the heard-clock reading (`contextTime` plus time since `performanceTime`)
 * moved forward by the output latency. `perfNowMs` is `performance.now()`.
 */
export function renderNowFromTimestamp(ts: OutputTimestamp, perfNowMs: number, latency: number): number {
  return ts.contextTime + (perfNowMs - ts.performanceTime) / 1000 + latency
}

export type SkipReason = 'locked' | 'late' | 'not-loaded' | 'voice-cap'

export type ThunderPlan =
  | { readonly kind: 'play'; readonly startAt: number }
  | { readonly kind: 'skip'; readonly reason: SkipReason }

export interface ThunderEnv {
  /** Render clock now, or null when audio is locked. */
  readonly audioNow: number | null
  /** `ctx.currentTime`; a start before it would fire at once. */
  readonly currentTime: number
  readonly latency: number
  readonly loaded: boolean
  readonly voiceFree: boolean
}

/** When thunder must be started (render clock) for it to be heard `d` after the flash peak. */
export const thunderStart = (tStrike: number, d: number, latency: number): number => tStrike + d - latency

/** The moment thunder is heard, on the same clock as the flash. */
export const heardAt = (tStrike: number, d: number): number => tStrike + d

/** Play only if it can start on time; a strike whose moment has passed is skipped, never played late. */
export function planThunder(s: { readonly clock: ClockDomain; readonly tStrike: number; readonly d: number }, env: ThunderEnv): ThunderPlan {
  if (s.clock !== 'audio' || env.audioNow === null) return { kind: 'skip', reason: 'locked' }
  const startAt = thunderStart(s.tStrike, s.d, env.latency)
  if (heardAt(s.tStrike, s.d) <= env.audioNow || startAt < Math.max(env.audioNow, env.currentTime)) return { kind: 'skip', reason: 'late' }
  if (!env.loaded) return { kind: 'skip', reason: 'not-loaded' }
  if (!env.voiceFree) return { kind: 'skip', reason: 'voice-cap' }
  return { kind: 'play', startAt }
}
