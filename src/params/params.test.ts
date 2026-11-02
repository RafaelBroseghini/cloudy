import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PARAM_KEYS, defaultParams, gateOrdered } from '../sim/params.ts'
import { FIELD_KEYS, FIELD_SPECS, defaultValues, type FieldKey, type Layer } from './fields.ts'
import { clearDriveDev, createDrive, createDriveRunner, setDriveDev } from './drive.ts'
import { WEATHER_KEYS, WEATHER_PRESETS } from './presets.ts'
import {
  SKY_KEYS,
  TRANSIENT_KEYS,
  USER_KEYS,
  interactionOf,
  resolve,
  type P,
  type TransientLayer,
  type UserLayer,
} from './resolve.ts'
import {
  WEATHER_STATES,
  advanceWeather,
  startTransition,
  stateWeights,
  steady,
  weatherLayer,
  type Weather,
  type WeatherState,
} from './weather.ts'

const state = fc.constantFrom(...WEATHER_STATES)
const unit = fc.double({ min: 0, max: 1, noNaN: true })
const wild = fc.oneof(
  fc.double(),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, 1e300, -1e300, 0, -0),
  fc.double({ min: -5, max: 50 }),
)
const layerOf = (keys: readonly FieldKey[]): fc.Arbitrary<Layer> =>
  fc.record(Object.fromEntries(keys.map((k) => [k, wild])) as Record<FieldKey, fc.Arbitrary<number>>, { requiredKeys: [] })
const anyLayer = layerOf(FIELD_KEYS)

/** A transition frozen at a given progress, built the way startTransition would from steady. */
const at = (from: WeatherState, to: WeatherState, progress: number): Weather => {
  const w = startTransition(steady(from), to, 10)
  return w.kind === 'transition' ? { ...w, progress } : w
}

/** Random weather reached by a script of start/advance operations. */
type Op = { start: WeatherState; seconds: number } | { dt: number }
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ start: state, seconds: fc.double({ min: 0.1, max: 20, noNaN: true }) }),
  fc.record({ dt: fc.double({ min: 0, max: 8, noNaN: true }) }),
)
const run = (ops: Op[], w: Weather = steady('clear')): Weather =>
  ops.reduce((acc, o) => ('start' in o ? startTransition(acc, o.start, o.seconds) : advanceWeather(acc, o.dt)), w)
const anyWeather = fc.array(op, { maxLength: 12 }).map((ops) => run(ops))

const inRange = (p: P): void => {
  for (const k of FIELD_KEYS) {
    expect(Number.isFinite(p[k])).toBe(true)
    expect(p[k]).toBeGreaterThanOrEqual(FIELD_SPECS[k].min)
    expect(p[k]).toBeLessThanOrEqual(FIELD_SPECS[k].max)
  }
}

describe('spec table', () => {
  it('defaults are in range and interaction defaults match the sim', () => {
    const d = defaultValues()
    for (const k of FIELD_KEYS) {
      expect(d[k]).toBeGreaterThanOrEqual(FIELD_SPECS[k].min)
      expect(d[k]).toBeLessThanOrEqual(FIELD_SPECS[k].max)
    }
    expect(interactionOf(resolve({}, steady('clear')))).toEqual(defaultParams())
  })

  it('user and sky keys are continuous non-interaction fields; transient keys are lighting or postfx only', () => {
    for (const k of [...USER_KEYS, ...SKY_KEYS]) {
      expect(FIELD_SPECS[k].kind).toBe('linear')
      expect(FIELD_SPECS[k].group).not.toBe('interaction')
      expect((PARAM_KEYS as readonly string[]).includes(k)).toBe(false)
    }
    for (const k of TRANSIENT_KEYS) expect(['lighting', 'postfx']).toContain(FIELD_SPECS[k].group)
    expect(TRANSIENT_KEYS.length).toBeGreaterThan(0)
  })

  it('raw preset values are in range before any clamping, keep yield < split, and leave cursor and gate fields alone', () => {
    for (const st of WEATHER_STATES) {
      const preset = WEATHER_PRESETS[st]
      for (const k of FIELD_KEYS) {
        const v = preset[k]
        if (v === undefined) continue
        expect(v, `${st}.${k}`).toBeGreaterThanOrEqual(FIELD_SPECS[k].min)
        expect(v, `${st}.${k}`).toBeLessThanOrEqual(FIELD_SPECS[k].max)
      }
      const p = { ...defaultValues(), ...preset }
      expect(p.yieldStrain).toBeLessThan(p.splitStrain)
      for (const k of ['m_c', 'k_p', 'c_p', 'cursorMaxSpeed', 'd_touch', 'd_release', 'tau'] as const) expect(preset[k]).toBeUndefined()
    }
  })

  it('presets move feel in the intended direction', () => {
    const d = defaultParams()
    const rain = WEATHER_PRESETS.rain
    expect(rain.k_r).toBeGreaterThan(d.k_r)
    expect(rain.k_s).toBeLessThan(d.k_s)
    expect(rain.creep).toBeGreaterThan(d.creep)
    expect(rain.rainRate).toBeCloseTo(0.7)
    expect(WEATHER_PRESETS.thunder.k_s).toBeGreaterThan(d.k_s)
    expect(WEATHER_PRESETS.thunder.splitStrain).toBeLessThan(d.splitStrain)
    expect(WEATHER_PRESETS.thunder.strikeRate).toBeGreaterThan(0)
    expect(WEATHER_PRESETS.tornado.k_s).toBeLessThan(d.k_s)
    expect(WEATHER_PRESETS.tornado.vortexStrength).toBeGreaterThan(0)
    expect(WEATHER_PRESETS.tornado.skyTopG).toBeGreaterThan(WEATHER_PRESETS.tornado.skyTopR ?? 0)
  })
})

describe('blending', () => {
  it('returns the endpoints exactly at s=0 and s=1', () => {
    fc.assert(
      fc.property(state, state, (a, b) => {
        expect(weatherLayer(at(a, b, 0))).toEqual(weatherLayer(steady(a)))
        expect(weatherLayer(at(a, b, 1))).toEqual(weatherLayer(steady(b)))
      }),
    )
  })

  it('weights sum to 1 and every resolved field stays in range for any s and any pair', () => {
    fc.assert(
      fc.property(state, state, unit, (a, b, s) => {
        const w = at(a, b, s)
        const sum = Object.values(stateWeights(w)).reduce((x, y) => x + y, 0)
        expect(sum).toBeCloseTo(1, 12)
        inRange(resolve({}, w))
      }),
    )
  })

  it('GateOrdered: d_touch < d_release for every resolved P, mid-blend included', () => {
    fc.assert(
      fc.property(anyWeather, anyLayer, (w, scene) => {
        const p = resolve({ scene }, w)
        expect(gateOrdered(p)).toBe(true)
        expect(gateOrdered(interactionOf(p))).toBe(true)
      }),
    )
  })

  it('step fields hold the from value until the blend ends', () => {
    expect(FIELD_SPECS.strikesEnabled.kind).toBe('step')
    fc.assert(
      fc.property(state, state, fc.double({ min: 0, max: 0.999999, noNaN: true }), (a, b, s) => {
        const pre = (st: WeatherState) => resolve({}, steady(st)).strikesEnabled
        expect(resolve({}, at(a, b, s)).strikesEnabled).toBe(pre(a))
        const done = advanceWeather(at(a, b, s), 1000)
        expect(resolve({}, done).strikesEnabled).toBe(pre(b))
      }),
    )
  })

  it('step fields keep the from value through a retarget', () => {
    const w1 = advanceWeather(startTransition(steady('thunder'), 'rain', 10), 9)
    const w2 = startTransition(w1, 'clear', 10)
    expect(resolve({}, w1).strikesEnabled).toBe(1)
    expect(resolve({}, advanceWeather(w2, 9)).strikesEnabled).toBe(1)
    expect(resolve({}, advanceWeather(w2, 10)).strikesEnabled).toBe(0)
  })
})

describe('layer order', () => {
  it('later layer wins; unset fields fall through', () => {
    fc.assert(
      // squish is a multiplier on other fields, so it is left out here (src/settings tests it)
      fc.property(layerOf(FIELD_KEYS.filter((k) => !WEATHER_KEYS.includes(k) && k !== 'squish')), (scene) => {
        const base = resolve({}, steady('rain'))
        const p = resolve({ scene }, steady('rain'))
        for (const k of FIELD_KEYS) {
          const v = scene[k]
          if (v !== undefined && Number.isFinite(v)) {
            const spec = FIELD_SPECS[k]
            expect(p[k]).toBe(Math.min(spec.max, Math.max(spec.min, v)))
          } else expect(p[k]).toBe(base[k])
        }
      }),
    )
    const rain = WEATHER_PRESETS.rain
    // weather beats scene; user beats weather; transient beats weather; scene beats defaults
    expect(resolve({ scene: { rainRate: 0.2, skySunPosX: 0.3 } }, steady('rain')).rainRate).toBe(rain.rainRate)
    expect(resolve({ scene: { skySunPosX: 0.3 } }, steady('rain')).skySunPosX).toBe(0.3)
    expect(resolve({ user: { rainRate: 0.1 } }, steady('rain')).rainRate).toBe(0.1)
    expect(resolve({ transient: { lightGain: 5 } }, steady('rain')).lightGain).toBe(5)
    expect(resolve({}, steady('rain')).lightGain).toBe(rain.lightGain)
  })

  it('a scene layer shows through where weather leaves a field unset, and blends from it', () => {
    const scene: Layer = { rainRate: 0.4, skySunPosX: 0.5 }
    expect(resolve({ scene }, steady('clear')).rainRate).toBe(0.4)
    const mid = resolve({ scene }, at('clear', 'rain', 0.5)).rainRate
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(0.7)
  })

  it('wild layer values still resolve inside every range', () => {
    fc.assert(
      fc.property(anyLayer, anyLayer, anyLayer, anyWeather, (scene, user, transient, w) => {
        inRange(resolve({ scene, user: user as UserLayer, transient: transient as TransientLayer }, w))
      }),
    )
  })

  it('a transient layer never changes interaction fields (even when smuggled past the types)', () => {
    fc.assert(
      fc.property(anyWeather, anyLayer, (w, transient) => {
        const without = resolve({}, w)
        const withT = resolve({ transient: transient as TransientLayer }, w)
        expect(interactionOf(withT)).toEqual(interactionOf(without))
        for (const k of FIELD_KEYS) {
          if (!(TRANSIENT_KEYS as readonly FieldKey[]).includes(k)) expect(withT[k]).toBe(without[k])
        }
      }),
    )
  })

  it('the transient type rejects interaction fields at compile time', () => {
    // @ts-expect-error k_s is an interaction field, not allowed in TransientLayer
    const bad: TransientLayer = { k_s: 1 }
    const ok: TransientLayer = { fxFlash: 1, lightAmbient: 0.5 }
    // @ts-expect-error rainRate is a weather field, not allowed in TransientLayer
    const bad2: TransientLayer = { rainRate: 1 }
    // @ts-expect-error d_touch is an interaction field, not a slider key
    const bad3: UserLayer = { d_touch: 1 }
    expect(resolve({ transient: ok }, steady('clear')).fxFlash).toBe(1)
    expect(interactionOf(resolve({ transient: bad }, steady('clear')))).toEqual(defaultParams())
    expect(bad2).toBeDefined()
    expect(bad3).toBeDefined()
  })

  it('interactionOf returns exactly the sim params keys', () => {
    expect(Object.keys(interactionOf(resolve({}, at('rain', 'thunder', 0.3)))).sort()).toEqual([...PARAM_KEYS].sort())
  })
})

describe('transitions', () => {
  it('OneTransition: at most one transition, progress in [0,1], duration > 0', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        let w: Weather = steady('clear')
        for (const o of ops) {
          w = 'start' in o ? startTransition(w, o.start, o.seconds) : advanceWeather(w, o.dt)
          if (w.kind === 'transition') {
            expect(w.progress).toBeGreaterThanOrEqual(0)
            expect(w.progress).toBeLessThan(1)
            expect(w.duration).toBeGreaterThan(0)
          }
          inRange(resolve({}, w))
        }
      }),
    )
  })

  it('TransitionCompletes: advancing by at least the duration reaches steady `to`', () => {
    fc.assert(
      fc.property(state, state, fc.double({ min: 0.01, max: 30, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (a, b, secs, extra) => {
        const w = startTransition(steady(a), b, secs)
        const done = advanceWeather(w, secs + extra)
        expect(done).toEqual(steady(b))
      }),
    )
    // retargeted blends too
    const w = startTransition(advanceWeather(startTransition(steady('clear'), 'rain', 4), 1), 'tornado', 3)
    expect(advanceWeather(w, 3)).toEqual(steady('tornado'))
  })

  it('small steps always finish, and bad dt or zero seconds never produce NaN progress', () => {
    let w = startTransition(steady('clear'), 'thunder', 2)
    for (let i = 0; i < 10 && w.kind === 'transition'; i++) w = advanceWeather(w, 1 / 60 + i * 0.1)
    for (let i = 0; i < 1000 && w.kind === 'transition'; i++) w = advanceWeather(w, 1 / 60)
    expect(w).toEqual(steady('thunder'))
    const t = startTransition(steady('clear'), 'rain', 5)
    expect(advanceWeather(t, Number.NaN)).toEqual(t)
    expect(advanceWeather(t, -3)).toEqual(t)
    expect(startTransition(t, 'tornado', 0)).toEqual(steady('tornado'))
    expect(startTransition(steady('clear'), 'rain', Number.NaN)).toEqual(steady('rain'))
  })

  it('restarting the same target keeps the running blend; steady to same state is a no-op', () => {
    const t = advanceWeather(startTransition(steady('clear'), 'rain', 5), 2)
    expect(startTransition(t, 'rain', 99)).toBe(t)
    const s = steady('rain')
    expect(startTransition(s, 'rain', 3)).toBe(s)
  })

  it('retargeting mid-blend has no value jump', () => {
    fc.assert(
      fc.property(anyWeather, state, fc.double({ min: 0.1, max: 20, noNaN: true }), anyLayer, (w, to, secs, scene) => {
        const before = resolve({ scene }, w)
        const after = resolve({ scene }, startTransition(w, to, secs))
        for (const k of FIELD_KEYS) {
          const range = FIELD_SPECS[k].max - FIELD_SPECS[k].min
          expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(1e-9 * range)
        }
      }),
    )
  })

  it('retargeting continues smoothly afterwards (no jump within a small step)', () => {
    const w1 = advanceWeather(startTransition(steady('clear'), 'thunder', 10), 4)
    const w2 = startTransition(w1, 'tornado', 10)
    const a = resolve({}, w2)
    const b = resolve({}, advanceWeather(w2, 0.01))
    for (const k of FIELD_KEYS) {
      const range = FIELD_SPECS[k].max - FIELD_SPECS[k].min
      expect(Math.abs(b[k] - a[k])).toBeLessThan(0.01 * range)
    }
  })
})

describe('dev layer', () => {
  const rain = WEATHER_PRESETS.rain

  it('wins over weather and user, for any field including interaction', () => {
    const p = resolve({ user: { rainRate: 0.1 }, dev: { rainRate: 0.9, k_s: 123, skyTopR: 0.2 } }, steady('rain'))
    expect(p.rainRate).toBe(0.9)
    expect(p.k_s).toBe(123)
    expect(p.skyTopR).toBe(0.2)
    expect(p.k_r).toBe(rain.k_r)
  })

  it('persists across weather changes; the rest follows the blend', () => {
    const dev: Layer = { k_s: 111, skyTopB: 0.7 }
    for (const w of [steady('clear'), steady('thunder'), at('rain', 'tornado', 0.4), at('clear', 'rain', 0.9)]) {
      const p = resolve({ dev }, w)
      expect(p.k_s).toBe(111)
      expect(p.skyTopB).toBe(0.7)
    }
    const a = resolve({ dev }, at('clear', 'rain', 0.3))
    const b = resolve({ dev }, at('clear', 'rain', 0.6))
    expect(b.rainRate).toBeGreaterThan(a.rainRate)
  })

  it('clearing a dev key falls back to the weather value', () => {
    const w = at('clear', 'rain', 0.5)
    const base = resolve({}, w)
    const withDev = resolve({ dev: { rainRate: 0.01, k_s: 20 } }, w)
    expect(withDev.rainRate).toBe(0.01)
    let d = createDrive({}, 'clear')
    d = setDriveDev(d, { rainRate: 0.01, k_s: 20 }).drive
    expect(d.p.rainRate).toBe(0.01)
    const cleared = clearDriveDev(d, ['rainRate']).drive
    expect(cleared.layers.dev).toEqual({ k_s: 20 })
    expect(cleared.p.rainRate).toBe(resolve({}, cleared.weather).rainRate)
    expect(cleared.p.k_s).toBe(20)
    expect(clearDriveDev(cleared).drive.layers.dev).toEqual({})
    expect(clearDriveDev(cleared).drive.p).toEqual(resolve({}, cleared.weather))
    expect(base.rainRate).toBeGreaterThan(0.01)
  })

  it('setDriveDev clamps into range, drops junk, and is a no-op when nothing changes', () => {
    const d = createDrive({}, 'clear')
    const s = setDriveDev(d, { fxExposure: 99, rainRate: Number.NaN, lightGain: -4 })
    expect(s.drive.layers.dev).toEqual({ fxExposure: FIELD_SPECS.fxExposure.max, lightGain: FIELD_SPECS.lightGain.min })
    const again = setDriveDev(s.drive, { fxExposure: 99 })
    expect(again.changed).toBe(false)
    expect(again.drive).toBe(s.drive)
    expect(clearDriveDev(s.drive, ['rainRate']).changed).toBe(false)
  })

  it('wild dev layers still resolve in range and keep d_touch < d_release', () => {
    fc.assert(
      fc.property(anyWeather, anyLayer, anyLayer, (w, dev, transient) => {
        const p = resolve({ dev, transient: transient as TransientLayer }, w)
        inRange(p)
        expect(gateOrdered(p)).toBe(true)
        expect(gateOrdered(interactionOf(p))).toBe(true)
      }),
    )
    // The ranges alone allow d_touch above d_release; the clamp restores the order.
    const p = resolve({ dev: { d_touch: FIELD_SPECS.d_touch.max, d_release: FIELD_SPECS.d_release.min } }, steady('clear'))
    expect(gateOrdered(p)).toBe(true)
  })

  it('a transient layer still cannot touch interaction fields, with or without a dev layer', () => {
    fc.assert(
      fc.property(anyWeather, anyLayer, anyLayer, (w, dev, transient) => {
        const without = resolve({ dev }, w)
        const withT = resolve({ dev, transient: transient as TransientLayer }, w)
        expect(interactionOf(withT)).toEqual(interactionOf(without))
        for (const k of FIELD_KEYS) {
          if (!(TRANSIENT_KEYS as readonly FieldKey[]).includes(k)) expect(withT[k]).toBe(without[k])
        }
      }),
    )
  })

  it('transient wins over dev on the lighting and post-FX fields it sets', () => {
    expect(resolve({ dev: { fxFlash: 0.2, lightGain: 1 }, transient: { fxFlash: 0.8 } }, steady('clear')).fxFlash).toBe(0.8)
    expect(resolve({ dev: { fxFlash: 0.2, lightGain: 1 }, transient: { fxFlash: 0.8 } }, steady('clear')).lightGain).toBe(1)
  })

  it('the runner keeps the dev layer when the strike flash swaps the transient layer', () => {
    const r = createDriveRunner({ setParams: () => {}, setWind: () => {} }, {}, 'clear')
    r.setDev({ k_s: 99 })
    r.setLayers({ transient: { fxFlash: 0.5 } })
    expect(r.drive.p.k_s).toBe(99)
    expect(r.drive.p.fxFlash).toBe(0.5)
    r.clearDev()
    expect(r.drive.p.k_s).toBe(resolve({}, steady('clear')).k_s)
  })
})
