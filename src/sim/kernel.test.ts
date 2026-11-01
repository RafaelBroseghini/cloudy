import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { stepCursor, type CursorParams } from './cursor.ts'
import { blobDensity, dragForce, influenceRadius, kernelW } from './kernel.ts'

const nonNeg = fc.double({ min: 0, max: 100, noNaN: true })
const vel = fc.double({ min: -50, max: 50, noNaN: true })

describe('density kernel', () => {
  it('W(0) = 1, W(q >= 1) = 0, values in [0, 1] and non-increasing in q', () => {
    expect(kernelW(0)).toBe(1)
    expect(kernelW(1)).toBe(0)
    expect(kernelW(3)).toBe(0)
    fc.assert(
      fc.property(fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        expect(kernelW(lo)).toBeGreaterThanOrEqual(kernelW(hi))
        expect(kernelW(lo)).toBeLessThanOrEqual(1)
        expect(kernelW(hi)).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('a blob contributes nothing beyond its influence radius', () => {
    expect(blobDensity(1, influenceRadius(0.5) + 1e-9, 0.5)).toBe(0)
    expect(blobDensity(2, 0, 0.5)).toBe(2)
  })
})

describe('drag', () => {
  it('is zero at zero density', () => {
    fc.assert(
      fc.property(nonNeg, vel, vel, (kr, vx, vy) => {
        const f = dragForce(kr, 0, vx, vy)
        expect(f.x).toBe(0)
        expect(f.y).toBe(0)
      }),
    )
  })

  it('opposes velocity (never does positive work)', () => {
    fc.assert(
      fc.property(nonNeg, nonNeg, vel, vel, (kr, rho, vx, vy) => {
        const f = dragForce(kr, rho, vx, vy)
        expect(f.x * vx + f.y * vy).toBeLessThanOrEqual(0)
        // parallel to v
        expect(Math.abs(f.x * vy - f.y * vx)).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(f.x * vy)))
      }),
    )
  })

  it('magnitude is non-decreasing in density', () => {
    fc.assert(
      fc.property(nonNeg, nonNeg, nonNeg, vel, vel, (kr, r1, r2, vx, vy) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1]
        const a = dragForce(kr, lo, vx, vy)
        const b = dragForce(kr, hi, vx, vy)
        expect(Math.hypot(b.x, b.y)).toBeGreaterThanOrEqual(Math.hypot(a.x, a.y) - 1e-12)
      }),
    )
  })
})

describe('cursor step', () => {
  const P: CursorParams = { k_r: 80, m_c: 1, k_p: 220, c_p: 24, cursorMaxSpeed: 28 }
  const dt = 1 / 60

  it('with no pull, density drag only slows the cursor, more so in denser air, and never flips its direction', () => {
    fc.assert(
      fc.property(nonNeg, nonNeg, vel, vel, (r1, r2, vx, vy) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1]
        const s = { x: 1, y: 2, vx, vy }
        const ptr = { kind: 'present', x: 1, y: 2 } as const
        const a = stepCursor(s, ptr, P, lo, dt)
        const b = stepCursor(s, ptr, P, hi, dt)
        const speed = Math.hypot(vx, vy)
        expect(Math.hypot(a.vx, a.vy)).toBeLessThanOrEqual(Math.min(speed, P.cursorMaxSpeed) + 1e-9)
        expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(Math.hypot(a.vx, a.vy) + 1e-9)
        expect(b.vx * vx + b.vy * vy).toBeGreaterThanOrEqual(-1e-12)
      }),
    )
  })

  it('an absent pointer stops the cursor in place', () => {
    const next = stepCursor({ x: 3, y: 4, vx: 5, vy: 6 }, { kind: 'absent' }, P, 7, dt)
    expect(next).toEqual({ x: 3, y: 4, vx: 0, vy: 0 })
  })

  it('respects the speed cap', () => {
    fc.assert(
      fc.property(vel, vel, fc.double({ min: -100, max: 100, noNaN: true }), (vx, vy, px) => {
        const n = stepCursor({ x: 0, y: 0, vx, vy }, { kind: 'present', x: px, y: -px }, P, 0, dt)
        expect(Math.hypot(n.vx, n.vy)).toBeLessThanOrEqual(P.cursorMaxSpeed + 1e-9)
      }),
    )
  })

  it('takes no wind input: the signature has no wind parameter (structural independence)', () => {
    expect(stepCursor.length).toBe(5)
  })
})
