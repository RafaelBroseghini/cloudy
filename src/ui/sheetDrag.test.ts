import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dragExtent, FLING_SPEED, releaseOpen, SNAP_FRACTION } from './sheetDrag.ts'

const full = fc.double({ min: 50, max: 900, noNaN: true })
const dy = fc.double({ min: -2000, max: 2000, noNaN: true })

describe('sheet drag', () => {
  it('follows the pointer 1:1 inside 0..full, both ways', () => {
    expect(dragExtent(true, 400, 0)).toBe(400)
    expect(dragExtent(true, 400, 150)).toBe(250)
    expect(dragExtent(false, 400, 0)).toBe(0)
    expect(dragExtent(false, 400, -150)).toBe(150)
    fc.assert(
      fc.property(fc.boolean(), full, dy, (open, f, d) => {
        const e = dragExtent(open, f, d)
        expect(e).toBeGreaterThanOrEqual(0)
        expect(e).toBeLessThanOrEqual(f)
      }),
    )
  })

  it('dragging the wrong way does nothing (an open panel pulled up stays fully open)', () => {
    expect(dragExtent(true, 400, -80)).toBe(400)
    expect(dragExtent(false, 400, 80)).toBe(0)
    expect(releaseOpen(true, 400, -80, 0)).toBe(true)
    expect(releaseOpen(false, 400, 80, 0)).toBe(false)
  })

  it('a slow release snaps to the other state only past the threshold', () => {
    const t = 400 * SNAP_FRACTION
    expect(releaseOpen(true, 400, t - 1, 0)).toBe(true)
    expect(releaseOpen(true, 400, t + 1, 0)).toBe(false)
    expect(releaseOpen(false, 400, -(t - 1), 0)).toBe(false)
    expect(releaseOpen(false, 400, -(t + 1), 0)).toBe(true)
  })

  it('a flick wins over the distance, in either direction', () => {
    fc.assert(
      fc.property(fc.boolean(), full, dy, (open, f, d) => {
        expect(releaseOpen(open, f, d, -FLING_SPEED)).toBe(true)
        expect(releaseOpen(open, f, d, FLING_SPEED)).toBe(false)
      }),
    )
  })
})
