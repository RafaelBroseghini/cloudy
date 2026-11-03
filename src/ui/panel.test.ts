// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeatherState } from '../params/index.ts'
import {
  DEFAULT_SETTINGS,
  SLIDER_KEYS,
  THUNDER_DISABLED_WORD,
  settingsOfScene,
  sliderEnabled,
  sliderWord,
  type SceneId,
  type Settings,
  type SliderKey,
  type SliderState,
} from '../settings/index.ts'
import { createSkyPanel, type SkyPanel, type SkyPanelHost } from './panel.ts'

// A fake host with the controller's observable behaviour: it records calls and keeps a little state.
function makeHost(initial: Settings = DEFAULT_SETTINGS) {
  let settings = initial
  let weather: WeatherState = initial.weather
  let resolved = {}
  const calls: unknown[][] = []
  const host: SkyPanelHost = {
    settings: () => settings,
    weather: () => weather,
    resolved: () => resolved,
    sliderState() {
      const out = {} as Record<SliderKey, SliderState>
      for (const k of SLIDER_KEYS) {
        const v = settings.sliders[k] ?? 0.5
        const enabled = sliderEnabled(k, weather)
        out[k] = { value: v, set: settings.sliders[k] !== undefined, enabled, word: enabled ? sliderWord(k, v) : THUNDER_DISABLED_WORD }
      }
      return out
    },
    setSlider(k, v) {
      calls.push(['setSlider', k, v])
      settings = { ...settings, scene: 'custom', sliders: { ...settings.sliders, [k]: v } }
    },
    clearSlider(k) {
      calls.push(['clearSlider', k])
      const { [k]: _gone, ...rest } = settings.sliders
      settings = { ...settings, scene: 'custom', sliders: rest }
    },
    applyScene(id: SceneId) {
      calls.push(['applyScene', id])
      settings = settingsOfScene(id)
      weather = settings.weather
    },
    setWeatherPreset(state) {
      calls.push(['setWeatherPreset', state])
      settings = { ...settings, weather: state, scene: 'custom' }
      weather = state
    },
    randomize() {
      calls.push(['randomize'])
      settings = { weather: 'thunder', scene: 'shuffled', sliders: { timeOfDay: 0.8, thunder: 0.4 } }
      weather = 'thunder'
    },
    reset() {
      calls.push(['reset'])
      settings = DEFAULT_SETTINGS
      weather = 'clear'
    },
  }
  return { host, calls, setExternalWeather: (w: WeatherState) => (weather = w), bump: () => void (resolved = {}) }
}

let panel: SkyPanel | undefined
const mount = (h = makeHost(), opts: { narrow?: boolean } = {}) => {
  const store = new Map<string, string>()
  panel = createSkyPanel(h.host, {
    loadMotion: () => Promise.resolve(null),
    reducedMotion: () => true,
    narrow: () => opts.narrow ?? false,
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }),
  })
  return { ...h, panel, store }
}
const q = <T extends Element>(sel: string): T => {
  const e = document.querySelector<T>(sel)
  if (!e) throw new Error(`missing ${sel}`)
  return e
}

afterEach(() => {
  panel?.dispose()
  panel = undefined
})

describe('Sky panel DOM', () => {
  it('builds seven real range inputs, labelled, with the word as aria-valuetext', () => {
    mount()
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    expect(inputs).toHaveLength(7)
    for (const i of inputs) {
      expect(document.querySelector(`label[for="${i.id}"]`)).not.toBeNull()
      expect(i.getAttribute('aria-valuetext')).toBeTruthy()
    }
    expect(q<HTMLInputElement>('[data-slider="timeOfDay"]').getAttribute('aria-valuetext')).toBe('Midday')
  })

  it('the thunder slider is disabled with "Storm weather only" outside thunder, live inside', () => {
    const h = mount()
    const t = q<HTMLInputElement>('[data-slider="thunder"]')
    expect(t.disabled).toBe(true)
    expect(t.getAttribute('aria-valuetext')).toBe('Storm weather only')
    h.setExternalWeather('thunder') // keys 1..4 move the weather without the panel's help
    h.panel.sync()
    expect(t.disabled).toBe(false)
    expect(t.getAttribute('aria-valuetext')).toBe('Frequent')
  })

  it('a pebble click calls setWeatherPreset and the pebble shows pressed', () => {
    const h = mount()
    q<HTMLButtonElement>('[data-weather-btn="rain"]').click()
    expect(h.calls).toEqual([['setWeatherPreset', 'rain']])
    expect(q('[data-weather-btn="rain"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-weather-btn="clear"]').getAttribute('aria-pressed')).toBe('false')
    expect(q('#sky-panel').getAttribute('data-weather')).toBe('rain')
  })

  it('Tornado is a disabled pebble and does nothing', () => {
    const h = mount()
    const b = q<HTMLButtonElement>('[data-weather-btn="tornado"]')
    expect(b.disabled).toBe(true)
    expect(b.title).toBe('Coming last')
    b.click()
    expect(h.calls).toEqual([])
  })

  it('a scene chip applies the scene and takes the pressed state', () => {
    const h = mount()
    q<HTMLButtonElement>('[data-scene="sunset"]').click()
    expect(h.calls).toEqual([['applyScene', 'sunset']])
    expect(q('[data-scene="sunset"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-scene="sunny"]').getAttribute('aria-pressed')).toBe('false')
  })

  it('a slider input calls setSlider with its key and value, and the subtitle says custom', () => {
    const h = mount()
    const rain = q<HTMLInputElement>('[data-slider="rain"]')
    rain.value = '0.8'
    rain.dispatchEvent(new Event('input', { bubbles: true }))
    expect(h.calls).toEqual([['setSlider', 'rain', 0.8]])
    expect(q('.sky-sub').textContent).toBe('Midday · clear · custom')
    expect(rain.getAttribute('aria-valuetext')).toBe('Downpour')
  })

  it('the dice call randomize and repaint from what came back (thunder tint, thunder slider live)', () => {
    const h = mount()
    q<HTMLButtonElement>('.sky-dice').click()
    expect(h.calls).toEqual([['randomize']])
    expect(q('#sky-panel').getAttribute('data-weather')).toBe('thunder')
    expect(q('.sky-sub').textContent).toBe('Sunset · thunder · shuffled')
    expect(q<HTMLInputElement>('[data-slider="thunder"]').disabled).toBe(false)
  })

  it('reset calls the controller', () => {
    const h = mount()
    q<HTMLButtonElement>('.sky-reset').click()
    expect(h.calls).toEqual([['reset']])
  })

  it('double-clicking a slider name unsets it', () => {
    const h = mount()
    q('label[for="sky-s-breeze"]').dispatchEvent(new Event('dblclick'))
    expect(h.calls).toEqual([['clearSlider', 'breeze']])
  })

  it('the fold toggles aria-expanded and the body, remembered on desktop', () => {
    const h = mount()
    const fold = q<HTMLButtonElement>('.sky-fold')
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    fold.click()
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.getAttribute('aria-label')).toBe('Expand sky panel')
    expect(q('#sky-body').hasAttribute('hidden')).toBe(true)
    expect(q('#sky-panel').getAttribute('data-open')).toBe('false')
    expect(h.panel.isOpen()).toBe(false)
    expect(h.store.get('cloudy:ui')).toBe('{"open":false}')
    fold.click()
    expect(fold.getAttribute('aria-expanded')).toBe('true')
  })

  it('dragging the header folds and unfolds it; a press without moving does nothing', () => {
    const h = mount()
    const title = q<HTMLElement>('.sky-title')
    const pe = (type: string, y: number, target: EventTarget) =>
      target.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, clientX: 50, clientY: y }))
    const drag = (from: EventTarget, dy: number) => {
      pe('pointerdown', 300, from)
      for (let i = 1; i <= 5; i++) pe('pointermove', 300 + (dy * i) / 5, window)
      pe('pointerup', 300 + dy, window)
    }
    pe('pointerdown', 300, title)
    pe('pointermove', 303, window) // under the slop: still a press
    pe('pointerup', 303, window)
    expect(h.panel.isOpen()).toBe(true)
    drag(title, 200)
    expect(h.panel.isOpen()).toBe(false)
    expect(q('.sky-fold').getAttribute('aria-expanded')).toBe('false')
    drag(title, -200)
    expect(h.panel.isOpen()).toBe(true)
    // A drag that starts on the fold button swallows the click that follows it, so the panel does not toggle back.
    const fold = q<HTMLButtonElement>('.sky-fold')
    drag(fold, 200)
    fold.click()
    expect(h.panel.isOpen()).toBe(false)
    fold.click()
    expect(h.panel.isOpen()).toBe(true)
  })

  it('a phone starts folded, and does not remember', () => {
    const h = mount(makeHost(), { narrow: true })
    expect(h.panel.isOpen()).toBe(false)
    expect(q('.sky-fold').getAttribute('aria-expanded')).toBe('false')
    h.panel.setOpen(true)
    expect(h.store.size).toBe(0)
  })

  it('sync repaints on an external weather change and skips the work when nothing changed', () => {
    const h = mount()
    const spy = vi.spyOn(h.host, 'sliderState')
    h.panel.sync()
    expect(spy).not.toHaveBeenCalled()
    h.setExternalWeather('rain')
    h.panel.sync()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(q('.sky-sub').textContent).toBe('Midday · rain · custom')
    h.bump()
    h.panel.sync()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('report mirrors the panel for the harness', () => {
    const h = mount()
    const r = h.panel.report()
    expect(r).toMatchObject({ ready: true, open: true, weather: 'clear', scene: 'sunny' })
    expect(r.sliders).toHaveLength(7)
    expect(r.sliders.find((s) => s.key === 'thunder')).toMatchObject({ disabled: true, word: 'Storm weather only' })
  })
})
