// The settings controller: holds the current settings and turns every change into drive calls (layers, weather blend,
// cloud respawn) and a debounced save. Pure TypeScript over an injected host, so tests run the exact path the game does.
//
// Only this API persists. Raw `setWeather`, `loadScene` and keys 1..4 never touch storage.
import type { P, SkyLayer, UserLayer, WeatherState } from '../params/index.ts'
import type { SceneName } from '../sim/index.ts'
import { SCENES, DEFAULT_SETTINGS, layoutOf, settingsOfScene, type SceneId, type Settings } from './scenes.ts'
import { randomize as rollDice, settingsOfRandom, type Randomized } from './randomize.ts'
import {
  SLIDER_KEYS,
  THUNDER_DISABLED_WORD,
  clamp01,
  sliderEnabled,
  sliderValuesOf,
  sliderWord,
  skyLayerOf,
  userLayerOf,
  type SliderKey,
  type SliderValues,
} from './sliders.ts'

/** Seconds of weather blend when a scene or weather button changes the weather. */
export const WEATHER_BLEND_S = 4

/** The two layers settings own in `Layers`: time of day below the weather, the other sliders above it. */
export interface SettingsLayers {
  readonly sky: SkyLayer
  readonly user: UserLayer
}
export const layersOf = (s: Settings): SettingsLayers => ({ sky: skyLayerOf(s.sliders), user: userLayerOf(s.sliders) })

/** What the controller drives (main.ts wires it to the drive runner and the sim). */
export interface SettingsHost {
  setLayers(l: SettingsLayers): void
  setWeather(state: WeatherState, seconds: number): void
  /** Respawn the clouds with a named layout. */
  loadScene(name: SceneName): void
  /** The resolved P right now (to show unset sliders where the scene and weather put them). */
  resolved(): P
  /** The weather state now steady or being blended toward. */
  weather(): WeatherState
}

export interface Persistence {
  /** Debounced write. */
  schedule(s: Settings): void
  /** Forget the saved settings (reset). */
  clear(): void
}

export interface SliderState {
  /** Effective 0..1 position: the set value, else read back from the resolved P. */
  readonly value: number
  readonly set: boolean
  readonly enabled: boolean
  /** The friendly word; while the thunder slider is disabled, "Storm weather only". */
  readonly word: string
}

export interface SettingsController {
  get(): Settings
  /** The layout the clouds were last spawned with. */
  layout(): SceneName
  /** Tell the controller the clouds were respawned outside it (harness `loadScene`, dev panel), so a later scene compares against the right layout. */
  noteLayout(name: SceneName): void
  setSlider(key: SliderKey, v: number): void
  setSliders(partial: SliderValues): void
  /** Unset a slider: it follows the scene and weather again. */
  clearSlider(key: SliderKey): void
  /** A weather button: changes the weather only (4 s blend) and clears the rain and thunder overrides so they follow it. */
  setWeatherPreset(state: WeatherState): void
  /** Weather blend + sliders + clouds respawned (re-applying the current scene respawns too, so it works as "reset scene"). */
  applyScene(id: SceneId): void
  /** The dice. Respawns the clouds when the layout changes. Returns what was rolled. */
  randomize(rng: () => number): Randomized
  /** Back to the defaults (sunny), clouds respawned, saved settings forgotten. */
  reset(): void
  sliderState(): Record<SliderKey, SliderState>
}

export function createSettingsController(initial: Settings, initialLayout: SceneName, host: SettingsHost, persist: Persistence): SettingsController {
  let settings = initial
  let layout = initialLayout

  interface Effects {
    /** Blend the weather to `next.weather` (the weather buttons, scenes and the dice; a slider move leaves a raw weather change alone). */
    readonly weather?: boolean
    /** Respawn the clouds with this layout (else they stay). */
    readonly respawn?: SceneName
    /** Write the settings after the debounce (default true). */
    readonly save?: boolean
  }
  const commit = (next: Settings, fx: Effects = {}): void => {
    settings = next
    host.setLayers(layersOf(next))
    if (fx.weather) host.setWeather(next.weather, WEATHER_BLEND_S)
    if (fx.respawn !== undefined) {
      layout = fx.respawn
      host.loadScene(fx.respawn)
    }
    if (fx.save !== false) persist.schedule(next)
  }

  const withSliders = (patch: SliderValues): Settings => {
    const sliders: SliderValues = { ...settings.sliders }
    for (const k of SLIDER_KEYS) {
      const v = patch[k]
      if (v !== undefined && !Number.isNaN(v)) sliders[k] = clamp01(v)
    }
    return { ...settings, scene: 'custom', sliders }
  }

  return {
    get: () => settings,
    layout: () => layout,
    noteLayout(name) {
      layout = name
    },
    setSlider(key, v) {
      commit(withSliders({ [key]: v }))
    },
    setSliders(partial) {
      commit(withSliders(partial))
    },
    clearSlider(key) {
      const sliders: SliderValues = { ...settings.sliders }
      delete sliders[key]
      commit({ ...settings, scene: 'custom', sliders })
    },
    setWeatherPreset(state) {
      const sliders: SliderValues = { ...settings.sliders }
      delete sliders.rain
      delete sliders.thunder
      commit({ weather: state, scene: 'custom', sliders }, { weather: true })
    },
    applyScene(id) {
      const def = SCENES.find((s) => s.id === id)
      if (!def) return
      const again = settings.scene === id
      commit(settingsOfScene(id), { weather: true, respawn: again || def.layout !== layout ? def.layout : undefined })
    },
    randomize(rng) {
      const z = rollDice(rng)
      commit(settingsOfRandom(z), { weather: true, respawn: z.sceneLayout !== layout ? z.sceneLayout : undefined })
      return z
    },
    reset() {
      commit(DEFAULT_SETTINGS, { weather: true, respawn: layoutOf(DEFAULT_SETTINGS), save: false })
      persist.clear() // a reset leaves nothing saved (the next boot starts from the defaults)
    },
    sliderState() {
      const weather = host.weather()
      const values = sliderValuesOf(host.resolved(), settings.sliders)
      const out = {} as Record<SliderKey, SliderState>
      for (const k of SLIDER_KEYS) {
        const enabled = sliderEnabled(k, weather)
        out[k] = {
          value: values[k],
          set: settings.sliders[k] !== undefined,
          enabled,
          word: enabled ? sliderWord(k, values[k]) : THUNDER_DISABLED_WORD,
        }
      }
      return out
    },
  }
}
