import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { WEATHER_STATES } from '../params/index.ts'
import { DEFAULT_SETTINGS, SCENE_IDS, type SceneRef, type Settings } from './scenes.ts'
import {
  SAVE_DELAY_MS,
  SETTINGS_VERSION,
  STORAGE_KEY,
  browserStorage,
  clearSavedSettings,
  createSaver,
  loadSettings,
  migrate,
  parseSettings,
  saveSettings,
  serializeSettings,
  type StorageLike,
  type Timers,
} from './storage.ts'
import { SLIDER_KEYS, type SliderKey, type SliderValues } from './sliders.ts'

const unit = fc.double({ min: 0, max: 1, noNaN: true }).map((v) => v + 0) // + 0: never -0 (JSON would write it as 0)
const sliders = fc.record(Object.fromEntries(SLIDER_KEYS.map((k) => [k, unit])) as Record<SliderKey, fc.Arbitrary<number>>, { requiredKeys: [] })
const scene = fc.constantFrom<SceneRef>(...SCENE_IDS, 'custom', 'shuffled')
const settings: fc.Arbitrary<Settings> = fc.record({ weather: fc.constantFrom(...WEATHER_STATES), scene, sliders })

const valid = (s: Settings): void => {
  expect(WEATHER_STATES).toContain(s.weather)
  expect([...SCENE_IDS, 'custom', 'shuffled']).toContain(s.scene)
  for (const [k, v] of Object.entries(s.sliders)) {
    expect(SLIDER_KEYS as readonly string[]).toContain(k)
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  }
}

describe('parseSettings', () => {
  it('any string loads to valid clamped settings or the defaults, and never throws', () => {
    fc.assert(fc.property(fc.string(), (raw) => valid(parseSettings(raw))))
    fc.assert(fc.property(fc.json(), (raw) => valid(parseSettings(raw))))
    fc.assert(fc.property(fc.anything(), (x) => valid(parseSettings(JSON.stringify(x)))))
    for (const raw of [null, undefined, '', '{', 'null', '[]', '42', '"x"', '{"version":1}', '{"version":1,"weather":"hail"}']) valid(parseSettings(raw))
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS)
  })

  it('save then load is the identity for valid settings', () => {
    fc.assert(fc.property(settings, (s) => {
      expect(parseSettings(serializeSettings(s))).toEqual(s)
    }))
  })

  it('drops unknown keys, at the top level and among the sliders', () => {
    fc.assert(
      fc.property(settings, fc.dictionary(fc.string({ minLength: 1 }).filter((k) => !['version', 'weather', 'scene', 'sliders'].includes(k)), fc.jsonValue()), (s, extra) => {
        const base = JSON.parse(serializeSettings(s)) as Record<string, unknown>
        const junkSliders = { ...(base.sliders as object), strikesEnabled: 1, k_s: 3, bogus: 0.5 }
        const raw = JSON.stringify({ ...extra, ...base, sliders: junkSliders })
        expect(parseSettings(raw)).toEqual(s)
      }),
    )
  })

  it('clamps out-of-range sliders to 0..1', () => {
    const raw = (sl: object): string => JSON.stringify({ version: 1, weather: 'rain', scene: 'custom', sliders: sl })
    expect(parseSettings(raw({ rain: 7, breeze: -3, depth: 0.25 })).sliders).toEqual({ rain: 1, breeze: 0, depth: 0.25 })
    expect(parseSettings('{"version":1,"weather":"rain","scene":"custom","sliders":{"rain":1e999,"breeze":-1e999}}').sliders).toEqual({ rain: 1, breeze: 0 })
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        const v = parseSettings(raw({ squish: x })).sliders.squish as number
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
        if (x >= 0 && x <= 1) expect(v).toBe(x + 0)
      }),
    )
  })

  it('a newer (or nonsense) version yields the defaults; the current one is read', () => {
    const rec = (version: unknown): string => JSON.stringify({ version, weather: 'rain', scene: 'rainy', sliders: { rain: 0.4 } })
    expect(parseSettings(rec(SETTINGS_VERSION)).weather).toBe('rain')
    for (const v of [SETTINGS_VERSION + 1, 2, 99, 0, -1, 1.5, '1', null, undefined, true]) expect(parseSettings(rec(v))).toEqual(DEFAULT_SETTINGS)
    fc.assert(fc.property(fc.integer({ min: SETTINGS_VERSION + 1, max: 1e9 }), (v) => {
      expect(parseSettings(rec(v))).toEqual(DEFAULT_SETTINGS)
    }))
  })

  it('an unknown scene id is kept as custom; an unknown weather or a non-number slider means defaults', () => {
    const rec = (o: object): string => JSON.stringify({ version: 1, weather: 'clear', scene: 'sunny', sliders: {}, ...o })
    expect(parseSettings(rec({ scene: 'volcano' })).scene).toBe('custom')
    expect(parseSettings(rec({ weather: 'hail' }))).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(rec({ sliders: { rain: 'lots' } }))).toEqual(DEFAULT_SETTINGS)
  })

  it('has a migrate seam that is a no-op for version 1', () => {
    const data = { version: 1, weather: 'rain', scene: 'custom', sliders: { rain: 0.5 } }
    expect(migrate(data, 1)).toBe(data)
  })
})

function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  }
}

describe('storage access', () => {
  it('loads, saves and clears through a storage source under the key "cloudy:settings"', () => {
    const st = memory()
    expect(STORAGE_KEY).toBe('cloudy:settings')
    expect(loadSettings(() => st)).toEqual(DEFAULT_SETTINGS) // missing key: defaults
    const s: Settings = { weather: 'thunder', scene: 'storm', sliders: { thunder: 0.4 } }
    expect(saveSettings(s, () => st)).toBe(true)
    expect(JSON.parse(st.data[STORAGE_KEY] as string)).toEqual({ version: 1, weather: 'thunder', scene: 'storm', sliders: { thunder: 0.4 } })
    expect(loadSettings(() => st)).toEqual(s)
    clearSavedSettings(() => st)
    expect(st.data[STORAGE_KEY]).toBeUndefined()
  })

  it('survives storage that is missing, blocked or throws on every call', () => {
    const boom = (): never => {
      throw new Error('blocked')
    }
    const sources = [() => null, () => undefined, boom, () => ({ getItem: boom, setItem: boom, removeItem: boom }), () => ({ getItem: () => 'x', setItem: boom, removeItem: boom })]
    for (const src of sources) {
      expect(loadSettings(src)).toEqual(DEFAULT_SETTINGS)
      expect(saveSettings({ ...DEFAULT_SETTINGS, weather: 'rain' }, src)).toBe(false)
      expect(() => clearSavedSettings(src)).not.toThrow()
      const saver = createSaver(src, { set: (fn) => fn(), clear: () => {} })
      expect(() => {
        saver.schedule(DEFAULT_SETTINGS)
        saver.flush()
      }).not.toThrow()
    }
  })

  it('reaches window.localStorage lazily and survives a getter that throws (or no window at all)', () => {
    expect(browserStorage()).toBeNull() // node: no window
    const w = globalThis as { window?: unknown }
    w.window = {
      get localStorage(): never {
        throw new Error('SecurityError')
      },
    }
    try {
      expect(browserStorage()).toBeNull()
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
      expect(saveSettings(DEFAULT_SETTINGS)).toBe(false)
      expect(() => clearSavedSettings()).not.toThrow()
    } finally {
      delete w.window
    }
  })
})

describe('debounced saver', () => {
  function fakeTimers(): Timers & { fire(): void; pending(): number } {
    const q = new Map<number, () => void>()
    let n = 0
    return {
      set: (fn) => {
        q.set(++n, fn)
        return n
      },
      clear: (h) => void q.delete(h as number),
      fire: () => [...q.values()].forEach((f) => f()) ?? q.clear(),
      pending: () => q.size,
    }
  }

  it('writes once, with the last value, after the delay', () => {
    const st = memory()
    const t = fakeTimers()
    const saver = createSaver(() => st, t)
    saver.schedule({ ...DEFAULT_SETTINGS, sliders: { rain: 0.1 } })
    saver.schedule({ ...DEFAULT_SETTINGS, sliders: { rain: 0.2 } })
    saver.schedule({ ...DEFAULT_SETTINGS, sliders: { rain: 0.3 } })
    expect(t.pending()).toBe(1)
    expect(st.data[STORAGE_KEY]).toBeUndefined()
    t.fire()
    expect((JSON.parse(st.data[STORAGE_KEY] as string) as { sliders: SliderValues }).sliders).toEqual({ rain: 0.3 })
    expect(SAVE_DELAY_MS).toBe(300)
  })

  it('flush writes a pending value now (page hide); cancel drops it; nothing pending writes nothing', () => {
    const st = memory()
    const t = fakeTimers()
    const saver = createSaver(() => st, t)
    saver.flush()
    expect(st.data[STORAGE_KEY]).toBeUndefined()
    saver.schedule({ ...DEFAULT_SETTINGS, weather: 'rain' })
    saver.flush()
    expect(loadSettings(() => st).weather).toBe('rain')
    expect(t.pending()).toBe(0)
    saver.schedule({ ...DEFAULT_SETTINGS, weather: 'thunder' })
    saver.cancel()
    t.fire()
    expect(loadSettings(() => st).weather).toBe('rain')
  })
})
