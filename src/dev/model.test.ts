import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FIELD_KEYS, FIELD_SPECS, srgbHexToLinear } from '../params/index.ts'
import { buildRows, isClamped, linearToHex, overridesJson, stepFor } from './model.ts'

describe('dev panel model', () => {
  it('every field appears exactly once, as a slider or inside one colour', () => {
    const seen: string[] = []
    for (const g of buildRows()) {
      for (const r of g.rows) {
        if (r.kind === 'number') seen.push(r.key)
        else seen.push(...r.keys)
      }
    }
    expect(seen.sort()).toEqual([...FIELD_KEYS].sort())
  })

  it('colours are R/G/B triplets in one group; interaction has none', () => {
    const rows = buildRows()
    const colours = rows.flatMap((g) => g.rows.filter((r) => r.kind === 'color').map((r) => (r.kind === 'color' ? r.name : '')))
    expect(colours).toEqual(expect.arrayContaining(['skyTop', 'skyHorizon', 'skyBottom', 'skySun', 'cloudLit', 'cloudMid', 'cloudShade']))
    expect(rows.find((g) => g.group === 'interaction')?.rows.every((r) => r.kind === 'number')).toBe(true)
    expect(rows[0]?.group).toBe('interaction')
  })

  it('slider ranges and steps come from the spec', () => {
    for (const g of buildRows()) {
      for (const r of g.rows) {
        if (r.kind !== 'number') continue
        expect(r.min).toBe(FIELD_SPECS[r.key].min)
        expect(r.max).toBe(FIELD_SPECS[r.key].max)
        expect(r.step).toBeGreaterThan(0)
        if (FIELD_SPECS[r.key].kind === 'linear') expect((r.max - r.min) / r.step).toBeGreaterThanOrEqual(100)
      }
    }
    expect(stepFor(5, 400)).toBe(1)
    expect(stepFor(0, 1)).toBe(0.001)
  })

  it('linear -> hex is the inverse of hex -> linear', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(6, '0')}`
        const [r, g, b] = srgbHexToLinear(hex)
        expect(linearToHex(r, g, b)).toBe(hex)
      }),
    )
    expect(linearToHex(0, 0, 0)).toBe('#000000')
    expect(linearToHex(1, 1, 1)).toBe('#ffffff')
    expect(linearToHex(2, -1, 0)).toBe('#ff0000')
    expect(linearToHex(0.2159, 0.2159, 0.2159)).toBe("#808080") // mid grey is ~0.216 linear, not 0.5
  })

  it('overridesJson keeps only set keys, rounded', () => {
    expect(overridesJson({})).toBe('{}')
    expect(JSON.parse(overridesJson({ k_s: 70.123456789, skyTopR: 0.123456789 }))).toEqual({ k_s: 70.123, skyTopR: 0.12346 })
  })

  it('isClamped compares the stored override with the resolved value', () => {
    const p = { k_s: 70 } as never
    expect(isClamped({ k_s: 70 }, p, 'k_s')).toBe(false)
    expect(isClamped({ k_s: 80 }, p, 'k_s')).toBe(true)
    expect(isClamped({}, p, 'k_s')).toBe(false)
  })
})
