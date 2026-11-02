// Seeded strike process, stepped in sim time (fixed steps), so a run replays for a seed and the harness can tick it.
// It emits events with no clock times; `makeStrike` stamps one with the clock when the game fires it.
import { createRng, type Rng } from './rng.ts'

export interface StrikeEvent {
  /** Light-to-sound delay (s): longer is further away. */
  readonly d: number
  /** 0..1, softer when distant. */
  readonly intensity: number
  /** Screen position of the strike, 0 (left) .. 1 (right). */
  readonly x: number
  /** Screen height of the glow, 0 (bottom) .. 1 (top). A strike that starts in a cloud moves it there (see anchor.ts). */
  readonly y: number
  /** 0..1 draws for the thunder file and its pitch. */
  readonly pick: number
  readonly pitch: number
}

/** The glow's default height: a little above the middle of the screen (what the composite always used). */
export const FLASH_Y = 0.55

export const D_MIN = 0.4
export const D_MAX = 3

/** Draw one strike: distance sets d and loudness. */
export function drawStrike(rnd: Rng): StrikeEvent {
  const far = rnd()
  const jitter = 0.85 + 0.15 * rnd()
  return {
    d: D_MIN + (D_MAX - D_MIN) * far,
    intensity: Math.min(1, Math.max(0.2, (1 - 0.6 * far) * jitter)),
    x: 0.1 + 0.8 * rnd(),
    y: FLASH_Y,
    pick: rnd(),
    pitch: rnd(),
  }
}

/**
 * Gaps between strikes are measured in "expected strikes": a strike fires when the integral of `rate` over time
 * reaches a threshold drawn as 0.35 + Exp(0.65) (mean 1, never clumped). So a rate change mid-wait, or a weather
 * blend, bends the wait smoothly, and the long-run rate is `rate`.
 */
const MIN_GAP = 0.35
const EXP_MEAN = 1 - MIN_GAP

export interface StrikeScheduler {
  /** Advance `dt` sim seconds with the resolved P.strikesEnabled / P.strikeRate. Returns the strikes that fire. */
  step(dt: number, enabled: boolean, rate: number): StrikeEvent[]
}

export function createStrikeScheduler(seed: number): StrikeScheduler {
  const rnd = createRng(seed)
  const threshold = (): number => MIN_GAP - EXP_MEAN * Math.log(1 - rnd())
  let need = threshold()
  let have = 0
  return {
    step(dt, enabled, rate) {
      const out: StrikeEvent[] = []
      if (!enabled || !(rate > 0) || !(dt > 0)) {
        if (!enabled) have = 0
        return out
      }
      have += rate * dt
      while (have >= need) {
        have -= need
        need = threshold()
        out.push(drawStrike(rnd))
      }
      return out
    },
  }
}
