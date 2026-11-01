import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createFixedStepper, FIXED_DT } from './fixedStep.ts'

describe('fixed step accumulator', () => {
  it('runs one step per 1/60 s regardless of how the time is sliced', () => {
    for (const hz of [30, 60, 120, 240]) {
      const s = createFixedStepper()
      let steps = 0
      for (let i = 0; i < hz * 5; i++) steps += s.advance(1 / hz, () => {})
      expect(steps).toBe(300)
    }
  })

  it('clamps steps per frame and drops the backlog', () => {
    const s = createFixedStepper(FIXED_DT, 3)
    expect(s.advance(10, () => {})).toBe(3)
    expect(s.advance(0, () => {})).toBe(0)
  })

  it('ignores negative, NaN and infinite-free garbage without throwing or running steps', () => {
    const s = createFixedStepper()
    expect(s.advance(-1, () => {})).toBe(0)
    expect(s.advance(Number.NaN, () => {})).toBe(0)
  })

  it('never runs more than maxSteps and total steps never exceed elapsed / dt', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 0.5, noNaN: true }), { maxLength: 60 }), (frames) => {
        const s = createFixedStepper(FIXED_DT, 5)
        let total = 0
        let elapsed = 0
        for (const f of frames) {
          const n = s.advance(f, () => {})
          expect(n).toBeLessThanOrEqual(5)
          total += n
          elapsed += f
        }
        expect(total * FIXED_DT).toBeLessThanOrEqual(elapsed + 1e-6)
      }),
      { numRuns: 100 },
    )
  })
})
