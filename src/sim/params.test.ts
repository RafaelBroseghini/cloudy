import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PARAM_KEYS, PARAM_SPECS, clampParams, defaultParams, gateOrdered, type Params } from './params.ts'

const wild = fc.oneof(
  fc.double({ noNaN: false }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, -1e300, 1e300, 0, -0),
  fc.double({ min: -5, max: 50 }),
)
const partialParams = fc.record(Object.fromEntries(PARAM_KEYS.map((k) => [k, wild])) as Record<keyof Params, fc.Arbitrary<number>>, {
  requiredKeys: [],
})

describe('params', () => {
  it('defaults sit inside their ranges and satisfy the gate order', () => {
    const d = defaultParams()
    for (const k of PARAM_KEYS) {
      expect(d[k]).toBeGreaterThanOrEqual(PARAM_SPECS[k].min)
      expect(d[k]).toBeLessThanOrEqual(PARAM_SPECS[k].max)
    }
    expect(gateOrdered(d)).toBe(true)
    expect(d.yieldStrain).toBeLessThan(d.splitStrain)
  })

  it('GateOrdered: d_touch < d_release for any clamped params, and every field is in range', () => {
    fc.assert(
      fc.property(partialParams, (partial) => {
        const p = clampParams(partial)
        expect(gateOrdered(p)).toBe(true)
        for (const k of PARAM_KEYS) {
          expect(Number.isFinite(p[k])).toBe(true)
          expect(p[k]).toBeGreaterThanOrEqual(PARAM_SPECS[k].min)
          expect(p[k]).toBeLessThanOrEqual(PARAM_SPECS[k].max)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('declared ranges for the two gates are disjoint, so the order holds before any repair', () => {
    expect(PARAM_SPECS.d_touch.max).toBeLessThan(PARAM_SPECS.d_release.min)
  })

  it('clamping is idempotent', () => {
    fc.assert(
      fc.property(partialParams, (partial) => {
        const once = clampParams(partial)
        expect(clampParams(once)).toEqual(once)
      }),
      { numRuns: 100 },
    )
  })

  it('a linear blend of two valid parameter sets stays valid', () => {
    fc.assert(
      fc.property(partialParams, partialParams, fc.double({ min: 0, max: 1, noNaN: true }), (a, b, s) => {
        const pa = clampParams(a)
        const pb = clampParams(b)
        const mixed = {} as Partial<Params>
        for (const k of PARAM_KEYS) mixed[k] = (1 - s) * pa[k] + s * pb[k]
        const p = clampParams(mixed)
        expect(gateOrdered(p)).toBe(true)
        // Blending inside a convex range needs no repair beyond the gate margin.
        for (const k of PARAM_KEYS) if (k !== 'd_touch') expect(p[k]).toBeCloseTo(mixed[k] as number, 9)
      }),
      { numRuns: 100 },
    )
  })
})
