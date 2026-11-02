import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resolve } from '../params/index.ts'
import { MAX_BLOBS } from '../sim/blobBuffer.ts'
import { buildLayout, mulberry32, sceneSpec } from '../sim/scene.ts'
import { FIELD_KEYS, FIELD_SPECS, steady } from '../params/index.ts'
import { gateOrdered } from '../sim/params.ts'
import { layersOf } from './controller.ts'
import { randomize, settingsOfRandom } from './randomize.ts'
import { SLIDER_KEYS } from './sliders.ts'

const seed = fc.integer({ min: 0, max: 2 ** 32 - 1 })

describe('randomize', () => {
  it('is deterministic for a seed and covers different skies across seeds', () => {
    fc.assert(fc.property(seed, (s) => {
      expect(randomize(mulberry32(s))).toEqual(randomize(mulberry32(s)))
    }))
    const distinct = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(randomize(mulberry32(i)))))
    expect(distinct.size).toBeGreaterThan(40)
  })

  it('keeps every value in the mockup\'s ranges, and thunder above 0 only in thunder weather', () => {
    fc.assert(
      fc.property(seed, (s) => {
        const z = randomize(mulberry32(s))
        const v = z.sliders
        for (const k of SLIDER_KEYS) {
          expect(v[k]).toBeGreaterThanOrEqual(0)
          expect(v[k]).toBeLessThanOrEqual(1)
        }
        expect(v.breeze).toBeGreaterThanOrEqual(0.05)
        expect(v.breeze).toBeLessThanOrEqual(0.9)
        expect(v.puffiness).toBeGreaterThanOrEqual(0.12)
        expect(v.puffiness).toBeLessThanOrEqual(0.97)
        if (z.weather === 'thunder') {
          expect(v.thunder).toBeGreaterThanOrEqual(0.15)
          expect(v.thunder).toBeLessThanOrEqual(0.9)
        } else expect(v.thunder).toBe(0)
        if (z.weather === 'clear') expect(v.rain).toBeLessThanOrEqual(0.3)
        else {
          expect(v.rain).toBeGreaterThanOrEqual(0.3)
          expect(v.rain).toBeLessThanOrEqual(0.9)
        }
        expect(['lone', z.weather]).toContain(z.sceneLayout)
      }),
    )
  })

  it('rolls weather about 50 / 28 / 22 %, the sun near midday about half the time, and one cloud about a third of the time', () => {
    const n = 4000
    const rolls = Array.from({ length: n }, (_, i) => randomize(mulberry32(i * 7919 + 1)))
    const share = (f: (z: (typeof rolls)[number]) => boolean): number => rolls.filter(f).length / n
    expect(share((z) => z.weather === 'clear')).toBeCloseTo(0.5, 1)
    expect(share((z) => z.weather === 'rain')).toBeCloseTo(0.28, 1)
    expect(share((z) => z.weather === 'thunder')).toBeCloseTo(0.22, 1)
    expect(share((z) => z.sceneLayout === 'lone')).toBeCloseTo(1 / 3, 1)
  })

  it('every roll resolves inside all field ranges with d_touch < d_release, in its own weather', () => {
    fc.assert(
      fc.property(seed, (s) => {
        const z = randomize(mulberry32(s))
        const p = resolve(layersOf(settingsOfRandom(z)), steady(z.weather))
        for (const k of FIELD_KEYS) {
          expect(p[k]).toBeGreaterThanOrEqual(FIELD_SPECS[k].min)
          expect(p[k]).toBeLessThanOrEqual(FIELD_SPECS[k].max)
        }
        expect(gateOrdered(p)).toBe(true)
        expect(p.yieldStrain).toBeLessThan(p.splitStrain)
        expect(p.strikesEnabled).toBe(z.weather === 'thunder' ? 1 : 0)
      }),
    )
  })

  it('spawns of the chosen layout stay separated, inside the view and under MAX_BLOBS, at phone and desktop sizes', () => {
    const views = [[390, 844], [1280, 800], [844, 390]] as const
    const layouts = new Set(Array.from({ length: 200 }, (_, i) => randomize(mulberry32(i)).sceneLayout))
    expect([...layouts].sort()).toEqual(['clear', 'lone', 'rain', 'thunder'])
    for (const name of layouts) {
      for (const [pw, ph] of views) {
        const W = (10 * pw) / ph
        const spec = sceneSpec(name, W, 10)
        const layout = buildLayout(spec)
        expect(layout.blobs.length).toBeLessThanOrEqual(MAX_BLOBS)
        expect(layout.blobs.length).toBe(spec.clouds.reduce((a, c) => a + c.blobs, 0))
        for (const b of layout.blobs) {
          expect(Math.abs(b.x) + b.radius).toBeLessThan(W / 2)
          expect(Math.abs(b.y) + b.radius).toBeLessThan(5)
        }
        for (let i = 0; i < layout.blobs.length; i++) {
          for (let j = i + 1; j < layout.blobs.length; j++) {
            const a = layout.blobs[i]
            const b = layout.blobs[j]
            if (!a || !b || a.cloud === b.cloud) continue
            // Default d_release 0.6: separate clouds start well clear of it, so none merge on their own.
            expect(Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius, `${name} ${pw}x${ph}`).toBeGreaterThan(0.8)
          }
        }
      }
    }
  })
})
