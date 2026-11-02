import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FIELD_SPECS, defaultValues, resolve, srgbHexToLinear, steady, type FieldKey, type SkyLayer, type UserLayer, type WeatherState } from '../params/index.ts'
import { SKY_KEYS } from '../params/resolve.ts'
import { SKY_TIMES, skyLayerAt, timeOfDayFromSunX } from './timeOfDay.ts'
import {
  SLIDER_KEYS,
  THUNDER_DISABLED_WORD,
  skyLayerOf,
  sliderEnabled,
  sliderValuesOf,
  sliderWord,
  squishOf,
  userLayerOf,
  breezeSpeedOf,
  cumulusHeightOf,
  lumpStrengthOf,
  parallaxStrengthOf,
  rainRateOf,
  strikeRateOf,
  type SliderKey,
} from './sliders.ts'

const unit = fc.double({ min: 0, max: 1, noNaN: true })
const wild = fc.oneof(unit, fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 5, -5))
const resolveWith = (sliders: Parameters<typeof userLayerOf>[0], weather: WeatherState = 'clear') =>
  resolve({ sky: skyLayerOf(sliders), user: userLayerOf(sliders) }, steady(weather))

describe('time of day', () => {
  it('midday is today\'s look exactly (bit for bit)', () => {
    const d = defaultValues()
    const sky = skyLayerAt(0.5)
    for (const k of SKY_KEYS) expect(sky[k], k).toBe(d[k])
    expect(resolveWith({ timeOfDay: 0.5 })).toEqual(resolve({}, steady('clear')))
  })

  it('hits every keyframe exactly and is continuous between them', () => {
    const [dawn, , , sunset, dusk] = SKY_TIMES.map((t) => skyLayerAt(t))
    expect([dawn?.skyTopR, dawn?.skyTopG, dawn?.skyTopB]).toEqual([...srgbHexToLinear('#7a86c9')])
    expect([sunset?.skyHorizonR, sunset?.skyHorizonG, sunset?.skyHorizonB]).toEqual([...srgbHexToLinear('#ffb27a')])
    expect([dusk?.skyBottomR, dusk?.skyBottomG, dusk?.skyBottomB]).toEqual([...srgbHexToLinear('#f2a6b8')])
    fc.assert(
      fc.property(unit, (t) => {
        const a = skyLayerAt(t)
        const b = skyLayerAt(Math.min(1, t + 1e-6))
        for (const k of SKY_KEYS) expect(Math.abs((a[k] as number) - (b[k] as number))).toBeLessThan(1e-4)
      }),
    )
  })

  it('every value stays inside its field range, for any t', () => {
    fc.assert(
      fc.property(wild, (t) => {
        const sky = skyLayerAt(t)
        for (const k of SKY_KEYS) {
          expect(sky[k]).toBeGreaterThanOrEqual(FIELD_SPECS[k].min)
          expect(sky[k]).toBeLessThanOrEqual(FIELD_SPECS[k].max)
        }
      }),
    )
  })

  it('the sun climbs from the left and sets on the right: x strictly increasing, read back exactly', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const x = skyLayerAt(i / 100).skySunPosX as number
      expect(x).toBeGreaterThan(prev)
      prev = x
    }
    fc.assert(
      fc.property(unit, (t) => {
        expect(timeOfDayFromSunX(skyLayerAt(t).skySunPosX as number)).toBeCloseTo(t, 9)
      }),
    )
  })

  it('sunset and dusk are warm and purple, with the sun behind the clouds', () => {
    const noon = skyLayerAt(0.5)
    const sunset = skyLayerAt(0.78)
    const dusk = skyLayerAt(1)
    expect(sunset.skyHorizonR as number).toBeGreaterThan(sunset.skyHorizonB as number) // orange horizon
    expect(sunset.cloudLitB as number).toBeLessThan(noon.cloudLitB as number) // lit side warmer than white
    expect(dusk.skyTopB as number).toBeGreaterThan(dusk.skyTopG as number) // purple
    expect(sunset.skySunDepth as number).toBeLessThan(0)
    expect(dusk.skySunDepth as number).toBeLessThan(0)
    expect(noon.skySunDepth as number).toBeGreaterThan(0)
  })
})

describe('slider mappings', () => {
  const MAPS: Array<[string, (v: number) => number, FieldKey]> = [
    ['breeze', breezeSpeedOf, 'breezeSpeed'],
    ['puffiness lumps', lumpStrengthOf, 'volLumpStrength'],
    ['puffiness height', cumulusHeightOf, 'volHeightCumulus'],
    ['rain', rainRateOf, 'rainRate'],
    ['thunder', strikeRateOf, 'strikeRate'],
    ['depth', parallaxStrengthOf, 'parallaxStrength'],
    ['squish', squishOf, 'squish'],
  ]
  for (const [name, f, field] of MAPS) {
    it(`${name}: monotone, bounded by ${field}'s range, clamped for any input`, () => {
      const { min, max } = FIELD_SPECS[field]
      fc.assert(
        fc.property(wild, wild, (a, b) => {
          expect(f(a)).toBeGreaterThanOrEqual(min)
          expect(f(a)).toBeLessThanOrEqual(max)
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          if (!Number.isNaN(lo) && !Number.isNaN(hi)) expect(f(lo)).toBeLessThanOrEqual(f(hi))
        }),
      )
    })
  }

  it('the middle of the neutral sliders is today\'s value; squish 0.5 is exactly 1', () => {
    const d = defaultValues()
    expect(squishOf(0.5)).toBe(1)
    expect(parallaxStrengthOf(0.5)).toBe(d.parallaxStrength)
    expect(lumpStrengthOf(0.5)).toBeCloseTo(d.volLumpStrength, 12)
    expect(cumulusHeightOf(0.5)).toBeCloseTo(d.volHeightCumulus, 12)
    expect(squishOf(0)).toBe(0.6)
    expect(squishOf(1)).toBe(1.6)
  })

  it('sliders map only to bounded, non-interaction fields (squish via its multiplier)', () => {
    const u: UserLayer = userLayerOf({ breeze: 1, puffiness: 1, rain: 1, thunder: 1, depth: 1, squish: 1 })
    expect(Object.keys(u).sort()).toEqual(['breezeSpeed', 'parallaxStrength', 'rainRate', 'squish', 'strikeRate', 'volHeightCumulus', 'volLumpStrength'])
    expect(Object.keys(userLayerOf({}))).toEqual([])
    expect(Object.keys(skyLayerOf({}))).toEqual([])
  })

  it('layer types reject strike switches, interaction fields and cross-layer keys', () => {
    // @ts-expect-error strikesEnabled can never be set by a slider
    const a: UserLayer = { strikesEnabled: 1 }
    // @ts-expect-error raw interaction fields are not user fields
    const b: UserLayer = { k_s: 1 }
    // @ts-expect-error sky colours belong to the sky layer
    const c: UserLayer = { skyTopR: 1 }
    // @ts-expect-error the sky layer holds sky and lighting only
    const d: SkyLayer = { rainRate: 1 }
    // @ts-expect-error the merge gate is not a slider
    const e: UserLayer = { d_touch: 0.2 }
    // Smuggled past the types, they are still ignored.
    const p = resolve({ user: { ...a, ...b, ...c, ...e } as UserLayer, sky: d }, steady('clear'))
    expect(p).toEqual(resolve({}, steady('clear')))
  })
})

describe('slider state helpers', () => {
  it('thunder is enabled only in thunder weather', () => {
    for (const k of SLIDER_KEYS) {
      for (const w of ['clear', 'rain', 'thunder', 'tornado'] as const) expect(sliderEnabled(k, w)).toBe(k !== 'thunder' || w === 'thunder')
    }
  })

  it('a thunder slider with no strikes enabled changes no strikesEnabled', () => {
    expect(resolveWith({ thunder: 1 }, 'clear').strikesEnabled).toBe(0)
    expect(resolveWith({ thunder: 1 }, 'thunder').strikesEnabled).toBe(1)
    expect(resolveWith({ thunder: 1 }, 'thunder').strikeRate).toBe(strikeRateOf(1))
  })

  it('reads an unset slider back from P and a set one as set; roundtrips within epsilon', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLIDER_KEYS), unit, (key: SliderKey, v) => {
        const p = resolveWith({ [key]: v })
        expect(sliderValuesOf(p)[key]).toBeCloseTo(v, 9)
        expect(sliderValuesOf(resolve({}, steady('clear')), { [key]: v })[key]).toBe(v)
      }),
    )
  })

  it('with nothing set the sliders sit where the defaults and the weather put them', () => {
    const clear = sliderValuesOf(resolve({}, steady('clear')))
    expect(clear.timeOfDay).toBeCloseTo(0.5, 9)
    expect(clear.depth).toBeCloseTo(0.5, 9)
    expect(clear.squish).toBeCloseTo(0.5, 9)
    expect(clear.rain).toBe(0)
    expect(sliderValuesOf(resolve({}, steady('rain'))).rain).toBeCloseTo(0.7, 9)
    expect(sliderValuesOf(resolve({}, steady('thunder'))).thunder).toBeGreaterThan(0)
    for (const w of ['clear', 'rain', 'thunder', 'tornado'] as const) {
      for (const v of Object.values(sliderValuesOf(resolve({}, steady(w))))) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('words follow the mockup thresholds', () => {
    expect([0, 0.2, 0.5, 0.78, 1].map((v) => sliderWord('timeOfDay', v))).toEqual(['Dawn', 'Morning', 'Midday', 'Sunset', 'Dusk'])
    expect([0, 0.2, 0.5, 0.9].map((v) => sliderWord('breeze', v))).toEqual(['Still', 'Gentle', 'Brisk', 'Gusty'])
    expect([0, 0.4, 0.7, 0.95].map((v) => sliderWord('puffiness', v))).toEqual(['Wispy', 'Soft', 'Puffy', 'Billowy'])
    expect([0, 0.2, 0.5, 0.9].map((v) => sliderWord('rain', v))).toEqual(['Dry', 'Drizzle', 'Steady', 'Downpour'])
    expect([0, 0.3, 0.9].map((v) => sliderWord('thunder', v))).toEqual(['Rare', 'Occasional', 'Frequent'])
    expect([0, 0.4, 0.9].map((v) => sliderWord('depth', v))).toEqual(['Flat', 'Layered', 'Deep'])
    expect([0, 0.5, 1].map((v) => sliderWord('squish', v))).toEqual(['Firm', 'Springy', 'Marshmallow'])
    expect(THUNDER_DISABLED_WORD).toBe('Storm weather only')
  })
})
