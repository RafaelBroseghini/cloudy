import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createFlow, curl, type FlowParams, type Vec2 } from './flow.ts'

const P: FlowParams = { speed: 0.2, angle: 0.3, turbulence: 0.2, scale: 6, rate: 0.1 }

function flowAt(p: FlowParams, seed = 7) {
  const f = createFlow(seed)
  f.setParams(p)
  return f
}

describe('flow', () => {
  it('turbulence is divergence-free: numerical divergence is ~0 next to the field gradient', () => {
    const f = flowAt({ ...P, speed: 0 })
    f.advance(5)
    const o: Vec2 = { x: 0, y: 0 }
    const u = (x: number, y: number): number => f.curlAt(x, y, o).x
    const v = (x: number, y: number): number => f.curlAt(x, y, o).y
    // A step different from the curl's own, so this checks the field and not the stencil.
    const h = 0.05
    fc.assert(
      fc.property(fc.double({ min: -9, max: 9, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true }), (x, y) => {
        const div = (u(x + h, y) - u(x - h, y)) / (2 * h) + (v(x, y + h) - v(x, y - h)) / (2 * h)
        // Gradient scale is turbulence / scale; require the divergence to be a tiny fraction of it.
        expect(Math.abs(div)).toBeLessThan(0.02 * (P.turbulence / P.scale) * 2.5)
      }),
      { numRuns: 200 },
    )
  })

  it('curl() of any smooth potential has zero divergence (stencil check)', () => {
    const psi = (x: number, y: number): number => Math.sin(1.3 * x) * Math.cos(0.7 * y) + 0.2 * x * y
    const o: Vec2 = { x: 0, y: 0 }
    const h = 1e-3
    const div = (x: number, y: number): number =>
      (curl(psi, x + h, y, h, { x: 0, y: 0 }).x - curl(psi, x - h, y, h, o).x) / (2 * h) +
      (curl(psi, x, y + h, h, { x: 0, y: 0 }).y - curl(psi, x, y - h, h, o).y) / (2 * h)
    expect(Math.abs(div(0.4, -0.9))).toBeLessThan(1e-3)
  })

  it('the curl noise has RMS speed equal to `turbulence`', () => {
    const f = flowAt({ ...P, speed: 0 })
    const o: Vec2 = { x: 0, y: 0 }
    let s = 0
    let n = 0
    for (let i = 0; i < 4000; i++) {
      f.curlAt(((i * 7919) % 400) / 10 - 20, ((i * 104729) % 300) / 10 - 15, o)
      s += o.x * o.x + o.y * o.y
      n++
    }
    expect(Math.sqrt(s / n)).toBeGreaterThan(0.2 * 0.85)
    expect(Math.sqrt(s / n)).toBeLessThan(0.2 * 1.15)
  })

  it('is deterministic per seed and evolves with sim time', () => {
    const a = flowAt(P)
    const b = flowAt(P)
    const c = flowAt(P, 8)
    const oa: Vec2 = { x: 0, y: 0 }
    const ob: Vec2 = { x: 0, y: 0 }
    const oc: Vec2 = { x: 0, y: 0 }
    a.sample(1, 2, oa)
    b.sample(1, 2, ob)
    c.sample(1, 2, oc)
    expect(oa).toEqual(ob)
    expect(oc).not.toEqual(oa)
    for (let i = 0; i < 600; i++) {
      a.advance(1 / 60)
      b.advance(1 / 60)
    }
    a.sample(1, 2, oa)
    b.sample(1, 2, ob)
    expect(oa).toEqual(ob)
    c.sample(1, 2, oc)
    expect(oa).not.toEqual(oc)
  })

  it('the air offset and phase integrate: 60 and 120 steps per second agree', () => {
    const a = flowAt(P)
    const b = flowAt(P)
    for (let i = 0; i < 600; i++) a.advance(1 / 60)
    for (let i = 0; i < 1200; i++) b.advance(1 / 120)
    expect(b.offset.x).toBeCloseTo(a.offset.x, 9)
    expect(b.offset.y).toBeCloseTo(a.offset.y, 9)
    expect(b.phase).toBeCloseTo(a.phase, 9)
    expect(a.offset.x).toBeCloseTo(P.speed * Math.cos(P.angle) * 10, 9)
  })

  it('changing the evolution rate or speed never jumps the field', () => {
    const f = flowAt(P)
    for (let i = 0; i < 6000; i++) f.advance(1 / 60)
    const before: Vec2 = { x: 0, y: 0 }
    const after: Vec2 = { x: 0, y: 0 }
    f.curlAt(3, -1, before)
    f.setParams({ ...P, rate: 0.9, speed: 1 })
    f.curlAt(3, -1, after)
    expect(after).toEqual(before)
  })

  it('zero turbulence is exactly the prevailing drift', () => {
    const f = flowAt({ ...P, turbulence: 0 })
    const o: Vec2 = { x: 9, y: 9 }
    f.sample(3, 4, o)
    expect(o.x).toBeCloseTo(P.speed * Math.cos(P.angle), 12)
    expect(o.y).toBeCloseTo(P.speed * Math.sin(P.angle), 12)
  })
})
