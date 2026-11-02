// The dice: one believable random sky, mirroring the approved mockup's shuffle(). Pure and deterministic for an rng;
// Math.random belongs at the call site only (`randomize(Math.random)` or `randomize(mulberry32(seed))`).
import { sceneForWeather, type WeatherState } from '../params/index.ts'
import type { SceneName } from '../sim/index.ts'
import type { Settings } from './scenes.ts'
import type { SliderKey } from './sliders.ts'

export type RandomWeather = Extract<WeatherState, 'clear' | 'rain' | 'thunder'>

export interface Randomized {
  readonly weather: RandomWeather
  /** Every slider is set (thunder is 0 unless the weather is thunder). */
  readonly sliders: Record<SliderKey, number>
  /** `lone` for one cloud, else the weather's own layout. */
  readonly sceneLayout: SceneName
}

export function randomize(rng: () => number): Randomized {
  const r = rng
  const t = r()
  const weather: RandomWeather = t < 0.5 ? 'clear' : t < 0.78 ? 'rain' : 'thunder'
  const timeOfDay = r() < 0.5 ? 0.35 + r() * 0.3 : r()
  const breeze = 0.05 + r() * 0.85
  const puffiness = 0.12 + r() * 0.85
  const rain = weather === 'clear' ? (r() < 0.25 ? r() * 0.3 : 0) : 0.3 + r() * 0.6
  const thunder = weather === 'thunder' ? 0.15 + r() * 0.75 : 0
  const depth = r()
  const squish = r()
  const clouds = 1 + Math.floor(r() * 3)
  return {
    weather,
    sliders: { timeOfDay, breeze, puffiness, rain, thunder, depth, squish },
    sceneLayout: clouds === 1 ? 'lone' : sceneForWeather(weather),
  }
}

export const settingsOfRandom = (z: Randomized): Settings => ({ weather: z.weather, scene: 'shuffled', sliders: { ...z.sliders } })
