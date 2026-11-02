// Flash envelope E(tau), tau = t - tStrike (seconds). Game feel: a fast rise, one or two flickers, a short afterglow.
//
// The flash PEAK is at tau = 0, i.e. at tStrike: the rise happens in [-attack, 0]. That pins the record's time to the
// moment the flash looks brightest, so (heard thunder) - (flash peak) = d exactly, for any output latency. The strike
// is created `STRIKE_LEAD` seconds ahead of the clock, so the rise (attack <= STRIKE_LEAD) is never in the past.

/** A strike is stamped this far ahead of the clock at creation, so the rise before the peak is still to come. */
export const STRIKE_LEAD = 0.1

export interface Pulse {
  /** Peak time relative to tStrike (s). */
  readonly at: number
  /** Rise time before the peak (s), smoothstep. */
  readonly attack: number
  readonly amp: number
  /** Exponential decay time constant after the peak (s). */
  readonly decay: number
}

export interface FlashShape {
  readonly pulses: readonly Pulse[]
  /** Slow glow under the pulses, as a fraction of the main peak (decays with `glowDecay`). */
  readonly glow: number
  readonly glowDecay: number
  /** The envelope is exactly 0 from here on (the tail is faded out over its last 0.4 s). */
  readonly duration: number
  /** Rise time of the main pulse (the first one; it peaks at tau = 0 with value 1 x gain). */
  readonly attack: number
  /** Overall scale, 1 for the full shape. */
  readonly gain: number
}

export const FULL_SHAPE: FlashShape = {
  pulses: [
    { at: 0, attack: 0.04, amp: 1, decay: 0.09 },
    { at: 0.12, attack: 0.025, amp: 0.7, decay: 0.12 },
    { at: 0.27, attack: 0.04, amp: 0.4, decay: 0.15 },
  ],
  glow: 0.3,
  glowDecay: 0.45,
  duration: 2,
  attack: 0.04,
  gain: 1,
}

/** prefers-reduced-motion: one slow, dimmer swell, no flicker. */
export const SOFT_SHAPE: FlashShape = {
  pulses: [{ at: 0, attack: 0.1, amp: 1, decay: 0.4 }],
  glow: 0,
  glowDecay: 0.45,
  duration: 2,
  attack: 0.1,
  gain: 0.45,
}

const smooth = (u: number): number => {
  const x = Math.min(1, Math.max(0, u))
  return x * x * (3 - 2 * x)
}

/** E(tau) in [0, shape.gain]; 0 before the first rise and after `duration`; max (= gain) at tau = 0. */
export function flashEnvelope(tau: number, shape: FlashShape = FULL_SHAPE): number {
  if (!Number.isFinite(tau) || tau >= shape.duration || tau <= -shape.attack) return 0
  let e = 0
  for (const p of shape.pulses) {
    const rise = smooth((tau - (p.at - p.attack)) / p.attack)
    const fall = tau > p.at ? Math.exp(-(tau - p.at) / p.decay) : 1
    e = Math.max(e, p.amp * rise * fall)
  }
  const first = shape.pulses[0]
  if (first && shape.glow > 0) {
    const rise = smooth((tau + first.attack) / first.attack)
    e = Math.max(e, shape.glow * rise * (tau > 0 ? Math.exp(-tau / shape.glowDecay) : 1))
  }
  const tail = 1 - smooth((tau - (shape.duration - 0.4)) / 0.4)
  return e * tail * shape.gain
}

/** The envelope's peak instant relative to tStrike. */
export const FLASH_PEAK_TAU = 0
