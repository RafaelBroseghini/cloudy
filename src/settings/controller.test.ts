// The controller on the real drive runner: what the harness and the future panel call.
import { describe, expect, it } from 'vitest'
import { createDriveRunner, resolve, steady, targetWeather, type P } from '../params/index.ts'
import { FIXED_DT } from '../sim/fixedStep.ts'
import { mulberry32, type SceneName } from '../sim/scene.ts'
import { WEATHER_BLEND_S, createSettingsController, layersOf, type SettingsController } from './controller.ts'
import { DEFAULT_SETTINGS, SCENE_BREEZE, layoutOf, type Settings } from './scenes.ts'
import { randomize } from './randomize.ts'
import { breezeSpeedOf, strikeRateOf } from './sliders.ts'

/** The default look: clear weather with only the scenes' calm breeze on top. */
const calmDefault = (): P => resolve({ sky: {}, user: { breezeSpeed: breezeSpeedOf(SCENE_BREEZE) } }, steady('clear'))

function setup(initial: Settings = DEFAULT_SETTINGS) {
  const sink = { setParams: () => {}, setWind: () => {} }
  const drive = createDriveRunner(sink, layersOf(initial), initial.weather)
  const spawned: SceneName[] = []
  const saved: Settings[] = []
  let cleared = 0
  const c: SettingsController = createSettingsController(
    initial,
    layoutOf(initial),
    {
      setLayers: (l) => drive.setLayers(l),
      setWeather: (w, s) => drive.setWeather(w, s),
      loadScene: (n) => void spawned.push(n),
      resolved: () => drive.drive.p,
      weather: () => targetWeather(drive.drive.weather),
    },
    { schedule: (s) => void saved.push(s), clear: () => void cleared++ },
  )
  const settle = (): void => {
    for (let i = 0; i < Math.ceil((WEATHER_BLEND_S + 1) / FIXED_DT); i++) drive.step(FIXED_DT)
  }
  return { c, drive, spawned, saved, settle, cleared: () => cleared, p: (): P => drive.drive.p }
}

describe('sliders', () => {
  it('setSlider raises the resolved value, marks the scene custom, saves, and respawns nothing', () => {
    const t = setup()
    expect(t.p().rainRate).toBe(0)
    t.c.setSlider('rain', 0.8)
    expect(t.p().rainRate).toBe(0.8)
    expect(t.c.get()).toEqual({ weather: 'clear', scene: 'custom', sliders: { breeze: SCENE_BREEZE, rain: 0.8 } })
    expect(t.saved.at(-1)).toEqual(t.c.get())
    expect(t.spawned).toEqual([])
  })

  it('clamps, ignores NaN, and clearSlider hands the field back to the scene and weather', () => {
    const t = setup()
    t.c.setSliders({ rain: 5, breeze: -2, depth: Number.NaN })
    expect(t.c.get().sliders).toEqual({ rain: 1, breeze: 0 })
    t.c.clearSlider('rain')
    t.c.clearSlider('breeze')
    expect(t.c.get().sliders).toEqual({})
    expect(t.p()).toEqual(resolve({ sky: {}, user: {} }, steady('clear')))
  })

  it('sliderState shows unset sliders where P puts them, and thunder disabled outside thunder weather', () => {
    const t = setup()
    let s = t.c.sliderState()
    expect(s.timeOfDay).toMatchObject({ set: false, enabled: true, word: 'Midday' })
    expect(s.thunder).toMatchObject({ set: false, enabled: false, word: 'Storm weather only' })
    expect(s.depth.value).toBeCloseTo(0.5, 9)
    t.c.setSlider('breeze', 0.9)
    s = t.c.sliderState()
    expect(s.breeze).toMatchObject({ value: 0.9, set: true, word: 'Gusty' })
    t.c.setWeatherPreset('thunder')
    expect(t.c.sliderState().thunder.enabled).toBe(true)
    t.settle()
    expect(t.c.sliderState().thunder).toMatchObject({ set: false, enabled: true })
    expect(t.c.sliderState().rain.value).toBeCloseTo(0.9, 9) // thunder weather's own rain
  })
})

describe('weather buttons', () => {
  it('change the weather only: blend 4 s, clear the rain and thunder overrides, keep the rest, never respawn', () => {
    const t = setup()
    t.c.setSliders({ rain: 0.2, thunder: 0.9, breeze: 0.7, timeOfDay: 0.78 })
    t.c.setWeatherPreset('rain')
    expect(t.c.get()).toEqual({ weather: 'rain', scene: 'custom', sliders: { breeze: 0.7, timeOfDay: 0.78 } })
    expect(t.drive.drive.weather.kind).toBe('transition')
    expect(targetWeather(t.drive.drive.weather)).toBe('rain')
    t.settle()
    expect(t.p().rainRate).toBe(0.7) // follows the weather again
    expect(t.p().breezeSpeed).toBeCloseTo(0.7 * 1.5, 9)
    expect(t.spawned).toEqual([])
    expect(t.saved.at(-1)?.weather).toBe('rain')
  })
})

describe('scenes', () => {
  it('sunset from sunny only changes the sky: same layout, no respawn; re-applying a scene respawns', () => {
    const t = setup()
    t.c.applyScene('sunset')
    expect(t.c.get()).toEqual({ weather: 'clear', scene: 'sunset', sliders: { timeOfDay: 0.78, breeze: SCENE_BREEZE } })
    expect(t.spawned).toEqual([])
    expect(t.p().skySunPosX).toBeGreaterThan(0.9)
    t.c.applyScene('sunset')
    expect(t.spawned).toEqual(['clear'])
  })

  it('rainy and storm blend the weather and respawn their layouts; lone respawns the lone cloud', () => {
    const t = setup()
    t.c.applyScene('rainy')
    expect(targetWeather(t.drive.drive.weather)).toBe('rain')
    t.c.applyScene('storm')
    expect(targetWeather(t.drive.drive.weather)).toBe('thunder')
    t.c.applyScene('lone')
    expect(t.spawned).toEqual(['rain', 'thunder', 'lone'])
    expect(t.c.layout()).toBe('lone')
    t.settle()
    expect(t.p().strikesEnabled).toBe(0)
  })

  it('sunny after anything resolves to exactly the default P, and clears every slider', () => {
    const t = setup()
    t.c.applyScene('storm')
    t.c.setSliders({ rain: 1, squish: 0, depth: 0, timeOfDay: 0.1 })
    t.c.applyScene('sunny')
    t.settle()
    expect(t.c.get()).toEqual({ weather: 'clear', scene: 'sunny', sliders: { breeze: SCENE_BREEZE } })
    expect(t.p()).toEqual(calmDefault())
  })

  it('a raw weather change (keys, harness) is followed by scene application even when settings say the same weather', () => {
    const t = setup()
    t.drive.setWeather('rain', 0)
    t.c.applyScene('sunny')
    expect(targetWeather(t.drive.drive.weather)).toBe('clear')
  })
})

describe('raw respawns', () => {
  it('noteLayout keeps the controller honest after a respawn outside it (dev panel, harness loadScene)', () => {
    const t = setup()
    t.c.noteLayout('m1')
    t.c.applyScene('sunset') // sunset wants the clear layout, but the clouds are m1 now
    expect(t.spawned).toEqual(['clear'])
  })
})

describe('randomize and reset', () => {
  it('applies a seeded roll: shuffled scene, all sliders set, weather blended, respawn only when the layout changes', () => {
    const t = setup()
    const z = t.c.randomize(mulberry32(7))
    expect(z).toEqual(randomize(mulberry32(7)))
    const s = t.c.get()
    expect(s.scene).toBe('shuffled')
    expect(s.weather).toBe(z.weather)
    expect(s.sliders).toEqual(z.sliders)
    expect(targetWeather(t.drive.drive.weather)).toBe(z.weather)
    expect(t.spawned).toEqual(z.sceneLayout === 'clear' ? [] : [z.sceneLayout])
    expect(t.c.layout()).toBe(z.sceneLayout)
    expect(t.saved.at(-1)).toEqual(s)
  })

  it('same seed, same sky', () => {
    const a = setup()
    const b = setup()
    a.c.randomize(mulberry32(99))
    b.c.randomize(mulberry32(99))
    expect(a.c.get()).toEqual(b.c.get())
  })

  it('reset goes back to sunny, respawns, and leaves nothing saved', () => {
    const t = setup()
    t.c.applyScene('storm')
    t.c.reset()
    expect(t.c.get()).toEqual(DEFAULT_SETTINGS)
    expect(t.spawned.at(-1)).toBe('clear')
    expect(t.cleared()).toBe(1)
    expect(t.saved.at(-1)?.scene).not.toBe('sunny') // the earlier storm save; reset itself saves nothing
    t.settle()
    expect(t.p()).toEqual(calmDefault())
  })
})

describe('thunder slider', () => {
  it('sets the strike rate but never enables strikes outside thunder weather', () => {
    const t = setup()
    t.c.setSlider('thunder', 1)
    t.settle()
    expect(t.p().strikeRate).toBe(strikeRateOf(1))
    expect(t.p().strikesEnabled).toBe(0)
    t.c.setWeatherPreset('thunder')
    t.settle()
    expect(t.p().strikesEnabled).toBe(1)
    expect(t.p().strikeRate).toBe(0.1) // the preset's: setWeatherPreset cleared the override
  })
})
