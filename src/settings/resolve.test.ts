// Settings through the real path: settings -> layers -> resolve (and the drive runner), against today's look.
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PARAM_KEYS, gateOrdered, defaultParams } from '../sim/params.ts'
import {
  FIELD_KEYS,
  FIELD_SPECS,
  WEATHER_STATES,
  createDriveRunner,
  defaultValues,
  type FieldKey,
  interactionOf,
  resolve,
  startTransition,
  steady,
  type P,
  type Weather,
  type WeatherState,
} from '../params/index.ts'
import { createParallax } from '../render/parallax.ts'
import { SCENES, DEFAULT_SETTINGS, SCENE_BREEZE, type Settings } from './scenes.ts'
import { layersOf } from './controller.ts'
import { SLIDER_KEYS, breezeSpeedOf, parallaxStrengthOf, skyLayerOf, squishOf, userLayerOf, type SliderKey, type SliderValues } from './sliders.ts'

const resolveSettings = (s: Settings, w: Weather): P => resolve(layersOf(s), w)
const inRange = (p: P): void => {
  for (const k of FIELD_KEYS) {
    expect(Number.isFinite(p[k]), k).toBe(true)
    expect(p[k], k).toBeGreaterThanOrEqual(FIELD_SPECS[k].min)
    expect(p[k], k).toBeLessThanOrEqual(FIELD_SPECS[k].max)
  }
  expect(gateOrdered(p)).toBe(true)
  expect(p.d_touch).toBeLessThan(p.d_release)
  expect(p.yieldStrain).toBeLessThan(p.splitStrain)
}
const at = (from: WeatherState, to: WeatherState, progress: number): Weather => {
  const w = startTransition(steady(from), to, 10)
  return w.kind === 'transition' ? { ...w, progress } : w
}
const WEATHERS: Weather[] = [...WEATHER_STATES.map((s) => steady(s)), at('clear', 'rain', 0.5), at('rain', 'thunder', 0.3), at('thunder', 'clear', 0.9)]

const M6_POST = new Set([
  'fxBloom', 'fxBloomThreshold', 'fxBloomRadius', 'fxGrade', 'fxContrast', 'fxSaturation', 'fxTemperature', 'fxLift',
  'fxShadowTintR', 'fxShadowTintG', 'fxShadowTintB', 'fxHighlightTintR', 'fxHighlightTintG', 'fxHighlightTintB',
])

describe('default settings', () => {
  // The snapshot is the resolved P taken from the code BEFORE settings existed; it must never be regenerated. The one exception
  // is the `volume` group: those fields drove the old 2.5D lighting and now drive the volumetric march (src/render/volume.ts),
  // so their old values are gone from the snapshot and the group is exempt below.
  const snapshot = JSON.parse(readFileSync(new URL('./p.snapshot.json', import.meta.url), 'utf8')) as Record<WeatherState, Record<string, number>>

  it('resolve to exactly the P of the game before settings existed (new fields at their defaults)', () => {
    for (const w of WEATHER_STATES) {
      const p = resolveSettings(DEFAULT_SETTINGS, steady(w)) as Record<string, number>
      const old = snapshot[w]
      // Exception, like `volume`: every scene (and so the default) opens on a calm breeze, so breezeSpeed is no longer the old value.
      for (const k of Object.keys(old)) expect(p[k], `${w}.${k}`).toBe(k === 'breezeSpeed' ? breezeSpeedOf(SCENE_BREEZE) : old[k])
      const added = Object.keys(p).filter((k) => !(k in old) && FIELD_SPECS[k as FieldKey].group !== 'volume')
      // M6's bloom and grade fields are new (they did not exist before settings); every old field above is unchanged.
      expect(added.filter((k) => !M6_POST.has(k)).sort()).toEqual(['parallaxStrength', 'squish'])
      expect(p.parallaxStrength).toBe(1)
      expect(p.squish).toBe(1)
    }
    expect(interactionOf(resolveSettings(DEFAULT_SETTINGS, steady('clear')))).toEqual(defaultParams())
  })

  it('building layers from no settings gives empty layers', () => {
    expect(layersOf({ ...DEFAULT_SETTINGS, sliders: {} })).toEqual({ sky: {}, user: {} })
  })

  it('the sunny scene is the default look; midday and a neutral squish/depth change nothing in the sim', () => {
    const sunny = SCENES.find((s) => s.id === 'sunny') as (typeof SCENES)[number]
    expect(resolveSettings({ weather: sunny.weather, scene: 'sunny', sliders: sunny.sliders }, steady('clear'))).toEqual(resolve({ sky: {}, user: { breezeSpeed: breezeSpeedOf(SCENE_BREEZE) } }, steady('clear')))
    expect(interactionOf(resolveSettings({ ...DEFAULT_SETTINGS, sliders: { squish: 0.5, timeOfDay: 0.5 } }, steady('rain')))).toEqual(
      interactionOf(resolve({}, steady('rain'))),
    )
  })
})

describe('weather mood on top of time of day', () => {
  it('a sunset under steady rain keeps rain\'s grey sky; clear shows the sunset; a blend moves between them', () => {
    const s: Settings = { weather: 'rain', scene: 'custom', sliders: { timeOfDay: 0.78 } }
    const rain = resolve({}, steady('rain'))
    expect(resolveSettings(s, steady('rain')).skyTopR).toBe(rain.skyTopR)
    expect(resolveSettings(s, steady('rain')).skyHorizonB).toBe(rain.skyHorizonB)
    const sunsetClear = resolveSettings(s, steady('clear'))
    expect(sunsetClear.skyTopR).toBe(skyLayerOf({ timeOfDay: 0.78 }).skyTopR)
    const mid = resolveSettings(s, at('clear', 'rain', 0.5))
    const [lo, hi] = [Math.min(rain.skyHorizonR, sunsetClear.skyHorizonR), Math.max(rain.skyHorizonR, sunsetClear.skyHorizonR)]
    expect(mid.skyHorizonR).toBeGreaterThan(lo)
    expect(mid.skyHorizonR).toBeLessThan(hi)
  })

  it('the sun still leans the light in rain (the presets leave its position alone)', () => {
    const s: Settings = { weather: 'rain', scene: 'custom', sliders: { timeOfDay: 0 } }
    expect(resolveSettings(s, steady('rain')).skySunPosX).toBe(skyLayerOf({ timeOfDay: 0 }).skySunPosX)
  })

  it('other sliders win over the weather, and unset ones follow it', () => {
    expect(resolveSettings({ ...DEFAULT_SETTINGS, sliders: { rain: 0.2 } }, steady('rain')).rainRate).toBe(0.2)
    expect(resolveSettings(DEFAULT_SETTINGS, steady('rain')).rainRate).toBe(0.7)
  })
})

describe('sweeps', () => {
  const extremes = (): SliderValues[] => {
    const out: SliderValues[] = [{}]
    for (const k of SLIDER_KEYS) for (const v of [0, 1]) out.push({ [k]: v })
    out.push(Object.fromEntries(SLIDER_KEYS.map((k) => [k, 0])), Object.fromEntries(SLIDER_KEYS.map((k) => [k, 1])))
    out.push(Object.fromEntries(SLIDER_KEYS.map((k, i) => [k, i % 2])), Object.fromEntries(SLIDER_KEYS.map((k, i) => [k, 1 - (i % 2)])))
    return out
  }

  it('every scene resolves inside every range at every slider extreme, one at a time and all together', () => {
    for (const scene of SCENES) {
      for (const ext of extremes()) {
        for (const w of WEATHERS) {
          inRange(resolveSettings({ weather: scene.weather, scene: scene.id, sliders: { ...scene.sliders, ...ext } }, w))
        }
      }
    }
  })

  it('any slider vector (wild values included) resolves inside all ranges, in any weather', () => {
    const wild = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.double(), fc.constantFrom(Number.NaN, 2, -1))
    const vec = fc.record(Object.fromEntries(SLIDER_KEYS.map((k) => [k, wild])) as Record<SliderKey, fc.Arbitrary<number>>, { requiredKeys: [] })
    fc.assert(
      fc.property(vec, fc.constantFrom(...WEATHERS), (sliders, w) => {
        const p = resolve({ sky: skyLayerOf(sliders), user: userLayerOf(sliders) }, w)
        inRange(p)
      }),
    )
  })

  it('squish keeps GateOrdered, leaves the cursor, gate and type fields alone, and is monotone in softness', () => {
    const base = resolve({}, steady('clear'))
    let prev: P | null = null
    for (let i = 0; i <= 20; i++) {
      const p = resolveSettings({ ...DEFAULT_SETTINGS, sliders: { squish: i / 20 } }, steady('clear'))
      inRange(p)
      for (const k of PARAM_KEYS) {
        if (!['k_s', 'c', 'yieldStrain', 'splitStrain'].includes(k)) expect(p[k], k).toBe(base[k])
      }
      if (prev) {
        expect(p.k_s).toBeLessThanOrEqual(prev.k_s) // squishier = softer
        expect(p.splitStrain).toBeGreaterThanOrEqual(prev.splitStrain)
      }
      prev = p
    }
    // Its reach is narrow: 0.6x..1.6x.
    expect(resolveSettings({ ...DEFAULT_SETTINGS, sliders: { squish: 1 } }, steady('clear')).k_s).toBeCloseTo(base.k_s / 1.6, 9)
    expect(resolveSettings({ ...DEFAULT_SETTINGS, sliders: { squish: 0 } }, steady('clear')).k_s).toBeCloseTo(base.k_s / 0.6, 9)
  })

  it('squish does not override a dev override of an interaction field, and a dev squish still works', () => {
    const layers = { ...layersOf({ ...DEFAULT_SETTINGS, sliders: { squish: 1 } }), dev: { k_s: 100 } }
    expect(resolve(layers, steady('clear')).k_s).toBe(100)
    expect(resolve({ dev: { squish: 1.6 } }, steady('clear')).k_s).toBeCloseTo(defaultValues().k_s / 1.6, 9)
  })

  it('reaches the sim only through the drive: squish and weather together stay in range mid-blend', () => {
    const sink = { setParams: () => {}, setWind: () => {} }
    const run = createDriveRunner(sink, layersOf({ ...DEFAULT_SETTINGS, sliders: { squish: 0, rain: 1, breeze: 1 } }), 'thunder')
    run.setWeather('clear', 2)
    for (let i = 0; i < 200; i++) {
      run.step(1 / 60)
      inRange(run.drive.p)
      expect(run.drive.interaction.d_touch).toBeLessThan(run.drive.interaction.d_release)
    }
  })
})

describe('depth', () => {
  const settle = (strength: number): ReturnType<typeof createParallax> => {
    const p = createParallax({ strength })
    p.setTarget({ x: 1, y: -1 })
    for (let i = 0; i < 1200; i++) p.step(1 / 60)
    return p
  }

  it('depth 0 means no parallax movement at all; 0.5 is today\'s', () => {
    const flat = settle(parallaxStrengthOf(0))
    expect(Math.abs(flat.offset.x)).toBe(0)
    expect(Math.abs(flat.offset.y)).toBe(0)
    const normal = settle(parallaxStrengthOf(0.5))
    const old = createParallax()
    old.setTarget({ x: 1, y: -1 })
    for (let i = 0; i < 1200; i++) old.step(1 / 60)
    expect(normal.offset).toEqual(old.offset)
  })

  it('scales the cursor shift and the sway, and eases when changed', () => {
    const p = createParallax({ maxSway: 0 })
    p.setTarget({ x: 1, y: 0 })
    for (let i = 0; i < 600; i++) p.step(1 / 60)
    const full = p.offset.x
    p.setStrength(0)
    p.step(1 / 60)
    expect(p.offset.x).toBeGreaterThan(0) // eased, no jump
    expect(p.offset.x).toBeLessThan(full)
    for (let i = 0; i < 600; i++) p.step(1 / 60)
    expect(p.offset.x).toBe(0)
    const sway = createParallax({ strength: 0 })
    const swayFull = createParallax()
    let m = 0
    for (let i = 0; i < 6000; i++) {
      sway.step(1 / 60)
      swayFull.step(1 / 60)
      m = Math.max(m, Math.abs(swayFull.offset.x))
      expect(Math.abs(sway.offset.x)).toBe(0)
    }
    expect(m).toBeGreaterThan(0)
  })

  it('the field reaches the renderer\'s look keys', () => {
    expect(squishOf(0.5)).toBe(1)
    const p = resolveSettings({ ...DEFAULT_SETTINGS, sliders: { depth: 0 } }, steady('clear'))
    expect(p.parallaxStrength).toBe(0)
  })
})
