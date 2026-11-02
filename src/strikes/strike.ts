// The strike record: one object feeds the flash and the thunder, so they cannot drift apart.
import { STRIKE_LEAD, flashEnvelope, FULL_SHAPE, type FlashShape } from './envelope.ts'
import { FLASH_Y, type StrikeEvent } from './scheduler.ts'
import type { ClockDomain, Clocks } from './sync.ts'

export interface Strike extends StrikeEvent {
  readonly id: number
  /** The flash peak instant, on `clock`: `STRIKE_LEAD` ahead of the clock when the strike was created. */
  readonly tStrike: number
  readonly clock: ClockDomain
}

/** Stamp an event with the clock: the audio clock when it is running, else the performance clock. */
export function makeStrike(id: number, e: StrikeEvent, now: Clocks): Strike {
  const audio = now.audio !== null
  return { ...e, id, clock: audio ? 'audio' : 'perf', tStrike: (audio ? now.audio : now.perf) + STRIKE_LEAD }
}

/** tau for one strike at `now`, or null when its clock is not available (audio went away). */
export function strikeTau(s: Strike, now: Clocks): number | null {
  const t = s.clock === 'audio' ? now.audio : now.perf
  return t === null ? null : t - s.tStrike
}

export interface FlashState {
  /** 0..1 */
  readonly value: number
  /** Screen x (0..1) of the strongest active strike. */
  readonly x: number
  /** Screen y (0 bottom .. 1 top) of its glow. */
  readonly y: number
}

export const NO_FLASH: FlashState = { value: 0, x: 0.5, y: FLASH_Y }

/** Strongest `intensity * E(tau)` over the strikes (flashes do not stack past 1). */
export function flashAt(strikes: readonly Strike[], now: Clocks, shape: FlashShape = FULL_SHAPE): FlashState {
  let best: FlashState = NO_FLASH
  for (const s of strikes) {
    const tau = strikeTau(s, now)
    if (tau === null) continue
    const v = s.intensity * flashEnvelope(tau, shape)
    if (v > best.value) best = { value: v, x: s.x, y: s.y }
  }
  return best
}

/** Strikes still worth evaluating: not past the end of either shape's envelope, and on an available clock. */
export function pruneStrikes(strikes: readonly Strike[], now: Clocks, maxDuration: number): Strike[] {
  return strikes.filter((s) => {
    const tau = strikeTau(s, now)
    return tau !== null && tau < maxDuration
  })
}
