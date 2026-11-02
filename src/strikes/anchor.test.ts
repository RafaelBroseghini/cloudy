import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BLOB, BLOB_STRIDE, createBlobBuffer } from '../sim/blobBuffer.ts'
import { summarizeClouds, type CloudSummary } from '../sim/cloudInfo.ts'
import { createSim } from '../sim/index.ts'
import { sceneSpec } from '../sim/scene.ts'
import { anchorStrike, nimbusAnchors, type StrikeAnchor } from './anchor.ts'
import { createStrikeDirector, flashLayer, type StrikePorts } from './director.ts'
import { drawStrike, FLASH_Y } from './scheduler.ts'
import { createRng } from './rng.ts'
import { FIXED_DT } from '../sim/fixedStep.ts'

const cloud = (type: CloudSummary['type'], x0: number, x1: number, y0 = -1, y1 = 3): CloudSummary => ({
  id: 1, x: (x0 + x1) / 2, y: (y0 + y1) / 2, blobs: 10, type, x0, x1, y0, y1,
})

describe('strike anchors', () => {
  it('only cumulonimbus clouds on screen anchor a strike, in the middle of their width', () => {
    const a = nimbusAnchors([cloud('cumulus', -5, -2), cloud('cumulonimbus', 2, 6), cloud('stratus', -1, 1)], 16, 10)
    expect(a).toHaveLength(1)
    // x 2..6 of a 16 wide view: core is the middle 60% (2.8..5.2).
    expect(a[0]?.x0).toBeCloseTo(2.8 / 16 + 0.5, 9)
    expect(a[0]?.x1).toBeCloseTo(5.2 / 16 + 0.5, 9)
    // Glow 40% up the cloud: y = -1 + 0.4 * 4 = 0.6 of a 10 high view.
    expect(a[0]?.y).toBeCloseTo(0.6 / 10 + 0.5, 9)
    // Wholly off screen: no anchor.
    expect(nimbusAnchors([cloud('cumulonimbus', 20, 24)], 16, 10)).toEqual([])
  })

  it('moves any strike inside one of the anchors, and leaves it alone when there are none', () => {
    const anchors: StrikeAnchor[] = [{ x0: 0.2, x1: 0.3, y: 0.4 }, { x0: 0.7, x1: 0.85, y: 0.6 }]
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), (seed) => {
        const e = drawStrike(createRng(seed))
        const m = anchorStrike(e, anchors)
        expect(anchors.some((a) => m.x >= a.x0 && m.x <= a.x1 && m.y === a.y)).toBe(true)
        // Nothing else about the strike changes, so thunder and the flash keep their own draws.
        expect({ ...m, x: 0, y: 0 }).toEqual({ ...e, x: 0, y: 0 })
        expect(anchorStrike(e, [])).toBe(e)
        expect(e.y).toBe(FLASH_Y)
      }),
    )
  })

  const ports = (anchors: readonly StrikeAnchor[]): StrikePorts => ({
    clocks: () => ({ audio: null, perf: 100 }),
    latency: () => 0,
    currentTime: () => 0,
    thunder: { loaded: true, voiceFree: true, start: () => {} },
    reducedMotion: () => false,
    anchors: () => anchors,
  })

  it('scheduled and forced strikes start in the cumulonimbus; an explicit x still wins; the replay is unchanged', () => {
    const anchors: StrikeAnchor[] = [{ x0: 0.55, x1: 0.65, y: 0.42 }]
    const withA = createStrikeDirector(5, ports(anchors))
    const without = createStrikeDirector(5, ports([]))
    for (let i = 0; i < 60 * 120; i++) {
      withA.step(FIXED_DT, 1, 0.2)
      without.step(FIXED_DT, 1, 0.2)
    }
    expect(withA.count).toBeGreaterThan(5)
    expect(withA.count).toBe(without.count)
    const last = withA.last
    expect(last?.x).toBeGreaterThanOrEqual(0.55)
    expect(last?.x).toBeLessThanOrEqual(0.65)
    expect(last?.y).toBe(0.42)
    expect(last?.d).toBe(without.last?.d)
    expect(last?.intensity).toBe(without.last?.intensity)

    const f = withA.force()
    expect(f.x).toBeGreaterThanOrEqual(0.55)
    expect(f.x).toBeLessThanOrEqual(0.65)
    expect(withA.force({ x: 0.1 }).x).toBe(0.1)
    expect(withA.force({ x: 0.1 }).y).toBe(FLASH_Y)
    // The flash glow follows the strike.
    withA.hold(0)
    expect(flashLayer(withA.flash()).fxFlashY).toBe(FLASH_Y)
  })

  it('in the thunder scene, a strike lands inside a cumulonimbus', async () => {
    const sim = await createSim()
    try {
      const W = 16
      sim.loadScene(sceneSpec('thunder', W, 10), W, 10)
      const buf = createBlobBuffer()
      const clouds = summarizeClouds(buf, sim.writeBlobs(buf))
      const towers = clouds.filter((c) => c.type === 'cumulonimbus')
      expect(towers.length).toBeGreaterThanOrEqual(1)
      expect(buf.length).toBeGreaterThanOrEqual(BLOB_STRIDE * sim.snapshot().blobs)
      expect(buf[BLOB.alive]).toBe(1)
      const dir = createStrikeDirector(11, ports(nimbusAnchors(clouds, W, 10)))
      for (let i = 0; i < 40; i++) {
        const r = dir.force()
        const wx = (r.x - 0.5) * W
        expect(towers.some((c) => wx >= c.x0 && wx <= c.x1)).toBe(true)
        const wy = (r.y - 0.5) * 10
        expect(towers.some((c) => wy >= c.y0 && wy <= c.y1)).toBe(true)
      }
    } finally {
      sim.dispose()
    }
  })
})
