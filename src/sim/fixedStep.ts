// Fixed-timestep accumulator. The sim never reads wall-clock time: callers pass elapsed seconds.

export const FIXED_DT = 1 / 60
export const MAX_STEPS_PER_FRAME = 5

/** Slack so that two 1/120 s frames reliably make one 1/60 s step despite float rounding. */
const EPS = 1e-9

export interface FixedStepper {
  /** Add elapsed seconds, run `step` for each whole fixed step due (at most `maxSteps`), return how many ran. */
  advance(elapsedSeconds: number, step: () => void): number
  reset(): void
}

export function createFixedStepper(dt = FIXED_DT, maxSteps = MAX_STEPS_PER_FRAME): FixedStepper {
  let acc = 0
  return {
    advance(elapsedSeconds, step) {
      if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) acc += elapsedSeconds
      let n = 0
      while (acc >= dt - EPS && n < maxSteps) {
        acc -= dt
        step()
        n++
      }
      // Spiral-of-death guard: drop the backlog instead of carrying it into later frames.
      if (acc >= dt - EPS) acc = 0
      if (acc < 0) acc = 0
      return n
    },
    reset() {
      acc = 0
    },
  }
}
