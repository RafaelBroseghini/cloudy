import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { WEATHER_STATES } from '../params/index.ts'
import { DEFAULT_SETTINGS, SCENES, SCENE_IDS, SLIDER_KEYS, sliderEnabled, sliderWord, THUNDER_DISABLED_WORD, type SliderKey, type SliderState } from '../settings/index.ts'
import { SLIDER_UI, WEATHER_UI, panelView, subtitleOf } from './model.ts'
import { sceneThumbBackground } from './thumb.ts'
import { initialOpen, parseOpen, saveOpen, UI_KEY } from './uiState.ts'

const sliders = (weather: (typeof WEATHER_STATES)[number], v = 0.5): Record<SliderKey, SliderState> => {
  const out = {} as Record<SliderKey, SliderState>
  for (const k of SLIDER_KEYS) {
    const enabled = sliderEnabled(k, weather)
    out[k] = { value: v, set: false, enabled, word: enabled ? sliderWord(k, v) : THUNDER_DISABLED_WORD }
  }
  return out
}

describe('panelView', () => {
  it('shows the time word, the weather and which weather pebble is pressed', () => {
    const v = panelView({ weather: 'rain', settings: { weather: 'rain', scene: 'rainy', sliders: {} }, sliders: sliders('rain') })
    expect(v.subtitle).toBe('Midday · rain')
    expect(v.pebbles.filter((p) => p.pressed).map((p) => p.state)).toEqual(['rain'])
    expect(v.scenes.filter((s) => s.pressed).map((s) => s.id)).toEqual(['rainy'])
  })

  it('tornado is a disabled pebble, the rest are live', () => {
    const v = panelView({ weather: 'clear', settings: DEFAULT_SETTINGS, sliders: sliders('clear') })
    expect(v.pebbles.map((p) => [p.state, p.disabled])).toEqual([['clear', false], ['rain', false], ['thunder', false], ['tornado', true]])
    expect(WEATHER_UI.find((w) => w.soon)?.state).toBe('tornado')
  })

  it('the thunder slider is disabled (by the flag, not the word) outside thunder weather', () => {
    for (const w of WEATHER_STATES) {
      const row = panelView({ weather: w, settings: { ...DEFAULT_SETTINGS, weather: w }, sliders: sliders(w) }).sliders.find((r) => r.key === 'thunder')
      expect(row?.disabled).toBe(w !== 'thunder')
      expect(row?.word).toBe(w === 'thunder' ? 'Frequent' : 'Storm weather only')
    }
  })

  it('adds custom and shuffled to the subtitle, and treats a weather moved behind the settings as custom', () => {
    const base = { weather: 'clear', sliders: sliders('clear') } as const
    expect(panelView({ ...base, settings: { weather: 'clear', scene: 'custom', sliders: {} } }).subtitle).toBe('Midday · clear · custom')
    expect(panelView({ ...base, settings: { weather: 'clear', scene: 'shuffled', sliders: {} } }).subtitle).toBe('Midday · clear · shuffled')
    const keys = panelView({ weather: 'thunder', settings: { weather: 'clear', scene: 'sunny', sliders: {} }, sliders: sliders('thunder') })
    expect(keys.scene).toBe('custom')
    expect(keys.scenes.some((s) => s.pressed)).toBe(false)
    expect(keys.subtitle).toBe('Midday · thunder · custom')
  })

  it('has one row per slider, in the mockup order, with a label each', () => {
    const v = panelView({ weather: 'clear', settings: DEFAULT_SETTINGS, sliders: sliders('clear') })
    expect(v.sliders.map((r) => r.key)).toEqual(['timeOfDay', 'breeze', 'puffiness', 'rain', 'thunder', 'depth', 'squish'])
    expect(v.sliders.map((r) => r.label)).toEqual(['Sun height', 'Breeze', 'Puffiness', 'Rain', 'Thunder', 'Depth', 'Squish'])
    for (const k of SLIDER_KEYS) expect(SLIDER_UI[k].key).toBe(k)
  })

  it('percent follows value, and at most one scene is pressed for any input', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WEATHER_STATES), fc.constantFrom(...SCENE_IDS, 'custom' as const, 'shuffled' as const), fc.double({ min: 0, max: 1, noNaN: true }), (weather, scene, v) => {
        const view = panelView({ weather, settings: { weather: 'clear', scene, sliders: {} }, sliders: sliders(weather, v) })
        expect(view.scenes.filter((s) => s.pressed).length).toBeLessThanOrEqual(1)
        expect(view.pebbles.filter((p) => p.pressed)).toHaveLength(1)
        for (const r of view.sliders) expect(r.percent).toBeCloseTo(v * 100, 9)
      }),
    )
  })
})

describe('subtitleOf', () => {
  it('has no suffix for a preset scene', () => {
    expect(subtitleOf('Sunset', 'clear', 'sunset')).toBe('Sunset · clear')
  })
})

describe('sceneThumbBackground', () => {
  it('one puff for the lone cloud, three otherwise, and every scene gets a sky gradient', () => {
    for (const s of SCENES) {
      const css = sceneThumbBackground(s)
      expect(css).toContain('linear-gradient(180deg')
      expect((css.match(/radial-gradient/g) ?? []).length).toBe(s.layout === 'lone' ? 1 : 3)
    }
  })
  it('sunset and storm skies differ from the sunny one', () => {
    const by = (id: string) => sceneThumbBackground(SCENES.find((s) => s.id === id)!)
    expect(by('sunset')).not.toBe(by('sunny'))
    expect(by('storm')).not.toBe(by('rainy'))
  })
})

describe('uiState', () => {
  const store = (initial?: string) => {
    const m = new Map<string, string>(initial === undefined ? [] : [[UI_KEY, initial]])
    return { m, source: () => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }) }
  }
  it('parses only a boolean open', () => {
    expect(parseOpen('{"open":false}')).toBe(false)
    expect(parseOpen('{"open":"no"}')).toBeNull()
    expect(parseOpen('nope')).toBeNull()
    expect(parseOpen(null)).toBeNull()
  })
  it('opens by default on desktop, remembers the choice, and a phone always starts folded', () => {
    expect(initialOpen(false, store().source)).toBe(true)
    const s = store()
    saveOpen(false, s.source)
    expect(initialOpen(false, s.source)).toBe(false)
    saveOpen(true, s.source)
    expect(initialOpen(true, s.source)).toBe(false)
  })
  it('survives blocked storage', () => {
    const blocked = () => {
      throw new Error('blocked')
    }
    expect(initialOpen(false, blocked)).toBe(true)
    expect(() => saveOpen(true, blocked)).not.toThrow()
  })
})
