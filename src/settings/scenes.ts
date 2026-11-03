// Preset scenes and the settings record they produce. Pure.
//
// A scene = weather + slider values + a sim layout. Applying one transitions the weather (the usual 4 s blend) AND
// respawns the clouds with the scene's layout (a plain weather change or slider move never respawns).
import { sceneForWeather, type WeatherState } from '../params/index.ts'
import type { SceneName } from '../sim/index.ts'
import type { SliderValues } from './sliders.ts'

export const SCENE_IDS = ['sunny', 'lone', 'sunset', 'dusk', 'rainy', 'storm'] as const
export type SceneId = (typeof SCENE_IDS)[number]
/** Which scene the settings are on: a preset, or what the player made of it (`custom`) or the dice rolled (`shuffled`). */
export type SceneRef = SceneId | 'custom' | 'shuffled'

export interface Settings {
  readonly weather: WeatherState
  readonly scene: SceneRef
  /** Only the sliders the player (or a scene) has set; the rest follow the scene and weather. */
  readonly sliders: SliderValues
}

export interface SceneDef {
  readonly id: SceneId
  readonly name: string
  readonly weather: WeatherState
  /** Only the sliders the scene sets (every scene sets the breeze; sunset and dusk also the time of day); every other slider is cleared. */
  readonly sliders: SliderValues
  /** The sim layout the scene respawns the clouds with. */
  readonly layout: SceneName
}

/** Every scene opens nearly windless; the player raises it with the Breeze slider. */
export const SCENE_BREEZE = 0.05

export const SCENES: readonly SceneDef[] = [
  { id: 'sunny', name: 'Sunny', weather: 'clear', sliders: { breeze: SCENE_BREEZE }, layout: 'clear' },
  { id: 'lone', name: 'Lone cloud', weather: 'clear', sliders: { timeOfDay: 0.46, breeze: SCENE_BREEZE }, layout: 'lone' },
  { id: 'sunset', name: 'Sunset', weather: 'clear', sliders: { timeOfDay: 0.78, breeze: SCENE_BREEZE }, layout: 'clear' },
  { id: 'dusk', name: 'Purple dusk', weather: 'clear', sliders: { timeOfDay: 0.97, breeze: SCENE_BREEZE }, layout: 'clear' },
  { id: 'rainy', name: 'Rainy', weather: 'rain', sliders: { breeze: SCENE_BREEZE }, layout: 'rain' },
  { id: 'storm', name: 'Storm', weather: 'thunder', sliders: { breeze: SCENE_BREEZE }, layout: 'thunder' },
]

export const sceneDef = (id: SceneId): SceneDef => SCENES.find((s) => s.id === id) as SceneDef

/** What the game opens with when nothing is saved: the sunny scene (today's look). */
export const DEFAULT_SETTINGS: Settings = { weather: 'clear', scene: 'sunny', sliders: { breeze: SCENE_BREEZE } }

export const settingsOfScene = (id: SceneId): Settings => {
  const s = sceneDef(id)
  return { weather: s.weather, scene: s.id, sliders: { ...s.sliders } }
}

/**
 * The cloud layout to open with for saved settings. Storage has no layout field, so it is derived: a preset scene's own
 * layout, else the weather's (a shuffled or customised lone cloud comes back as the weather's layout).
 */
export function layoutOf(s: Settings): SceneName {
  return (SCENE_IDS as readonly string[]).includes(s.scene) ? sceneDef(s.scene as SceneId).layout : sceneForWeather(s.weather)
}
