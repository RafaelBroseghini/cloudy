import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { computeRestOffsets, shapeMatchNudge, type ShapeData } from './shapeMatch.ts'

function make(points: Array<[number, number]>, masses: number[]): ShapeData {
  const n = points.length
  const d: ShapeData = {
    px: Float64Array.from(points.map((p) => p[0])),
    py: Float64Array.from(points.map((p) => p[1])),
    mass: Float64Array.from(masses),
    qx: new Float64Array(n),
    qy: new Float64Array(n),
  }
  computeRestOffsets(
    points.map((_, i) => i),
    d,
  )
  return d
}

const pts = fc.array(fc.tuple(fc.double({ min: -5, max: 5, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true })), {
  minLength: 3,
  maxLength: 12,
})

describe('shape matching', () => {
  it('a rigid motion of the rest shape needs no correction', () => {
    fc.assert(
      fc.property(pts, fc.double({ min: -3, max: 3, noNaN: true }), fc.double({ min: -9, max: 9, noNaN: true }), fc.double({ min: -9, max: 9, noNaN: true }), (points, ang, tx, ty) => {
        const d = make(points, points.map(() => 1))
        const c = Math.cos(ang)
        const s = Math.sin(ang)
        // Rotate/translate about the centroid (rest offsets are relative to it).
        const cx = points.reduce((a, p) => a + p[0], 0) / points.length
        const cy = points.reduce((a, p) => a + p[1], 0) / points.length
        points.forEach((_, i) => {
          d.px[i] = cx + tx + c * (d.qx[i] ?? 0) - s * (d.qy[i] ?? 0)
          d.py[i] = cy + ty + s * (d.qx[i] ?? 0) + c * (d.qy[i] ?? 0)
        })
        const dvx = new Float64Array(points.length)
        const dvy = new Float64Array(points.length)
        shapeMatchNudge(points.map((_, i) => i), d, 0.1, 1 / 60, dvx, dvy)
        for (let i = 0; i < points.length; i++) {
          expect(Math.abs(dvx[i] ?? 0)).toBeLessThan(1e-6)
          expect(Math.abs(dvy[i] ?? 0)).toBeLessThan(1e-6)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('conserves linear momentum for any deformation and any masses', () => {
    fc.assert(
      fc.property(pts, fc.array(fc.double({ min: 0.1, max: 3, noNaN: true }), { minLength: 12, maxLength: 12 }), pts, (points, ms, jitter) => {
        const masses = points.map((_, i) => ms[i] ?? 1)
        const d = make(points, masses)
        points.forEach((_, i) => {
          d.px[i] = (d.px[i] ?? 0) + (jitter[i % jitter.length]?.[0] ?? 0) * 0.2
          d.py[i] = (d.py[i] ?? 0) + (jitter[i % jitter.length]?.[1] ?? 0) * 0.2
        })
        const dvx = new Float64Array(points.length)
        const dvy = new Float64Array(points.length)
        shapeMatchNudge(points.map((_, i) => i), d, 0.1, 1 / 60, dvx, dvy)
        let px = 0
        let py = 0
        let scale = 0
        points.forEach((_, i) => {
          px += (masses[i] ?? 0) * (dvx[i] ?? 0)
          py += (masses[i] ?? 0) * (dvy[i] ?? 0)
          scale += (masses[i] ?? 0) * (Math.abs(dvx[i] ?? 0) + Math.abs(dvy[i] ?? 0))
        })
        expect(Math.abs(px)).toBeLessThanOrEqual(1e-9 + 1e-9 * scale)
        expect(Math.abs(py)).toBeLessThanOrEqual(1e-9 + 1e-9 * scale)
      }),
      { numRuns: 100 },
    )
  })
})
