// The Sky panel's view-model: pure functions from the settings model to what the panel shows. No DOM, so node tests cover
// every word, flag and label; panel.ts only paints the result.
import type { WeatherState } from '../params/index.ts'
import { SCENES, SLIDER_KEYS, type SceneId, type SceneRef, type Settings, type SliderKey, type SliderState } from '../settings/index.ts'
import type { IconName } from './icons.ts'

export interface WeatherUi {
  readonly state: WeatherState
  readonly label: string
  readonly icon: IconName
  /** Not playable yet: shown disabled ("Coming last"). */
  readonly soon: boolean
}
export const WEATHER_UI: readonly WeatherUi[] = [
  { state: 'clear', label: 'Clear', icon: 'sun', soon: false },
  { state: 'rain', label: 'Rain', icon: 'rain', soon: false },
  { state: 'thunder', label: 'Thunder', icon: 'bolt', soon: false },
  { state: 'tornado', label: 'Tornado', icon: 'tornado', soon: true },
]

export interface SliderUi {
  readonly key: SliderKey
  readonly label: string
  readonly icon: IconName
  /** Track fill colour (the sun slider paints the whole track in sky colours instead). */
  readonly fill?: string
  /** CSS paint laid over the fill: wind streaks, rain streaks, the violet-to-gold bolt. */
  readonly pattern?: string
  /** The sky-coloured time-of-day track. */
  readonly sky?: boolean
}
export const SLIDER_UI: Record<SliderKey, SliderUi> = {
  timeOfDay: { key: 'timeOfDay', label: 'Sun height', icon: 'sun', sky: true },
  breeze: {
    key: 'breeze',
    label: 'Breeze',
    icon: 'wind',
    fill: '#7fbdf0',
    pattern: 'repeating-linear-gradient(0deg, rgba(255,255,255,.6) 0 1px, transparent 1px 4px)',
  },
  puffiness: { key: 'puffiness', label: 'Puffiness', icon: 'cloud', fill: '#9ccaf5' },
  rain: {
    key: 'rain',
    label: 'Rain',
    icon: 'rain',
    fill: '#5f8fc9',
    pattern: 'repeating-linear-gradient(105deg, rgba(255,255,255,.65) 0 1.5px, transparent 1.5px 7px)',
  },
  thunder: { key: 'thunder', label: 'Thunder', icon: 'bolt', fill: '#9a86e0', pattern: 'linear-gradient(90deg, #8d7bd6, #ffcf5a)' },
  depth: { key: 'depth', label: 'Depth', icon: 'layers', fill: '#8ab6e8' },
  squish: { key: 'squish', label: 'Squish', icon: 'blob', fill: '#a7cdf2' },
}

export interface SliderRowView {
  readonly key: SliderKey
  readonly label: string
  /** Effective 0..1 position. */
  readonly value: number
  /** 0..100, for the track fill. */
  readonly percent: number
  readonly word: string
  readonly disabled: boolean
  readonly set: boolean
}

export interface PanelView {
  readonly weather: WeatherState
  /** The scene to show as chosen: `custom` when the weather was moved by keys, the harness or the dev panel behind the settings' back. */
  readonly scene: SceneRef
  /** `<time word> · <weather>` plus ` · custom` or ` · shuffled`. */
  readonly subtitle: string
  readonly pebbles: readonly { state: WeatherState; pressed: boolean; disabled: boolean }[]
  readonly scenes: readonly { id: SceneId; pressed: boolean }[]
  readonly sliders: readonly SliderRowView[]
}

export interface PanelInput {
  /** The weather the game is on (or blending toward), which is not always `settings.weather` (keys 1..4 change it raw). */
  readonly weather: WeatherState
  readonly settings: Settings
  readonly sliders: Record<SliderKey, SliderState>
}

export function subtitleOf(timeWord: string, weather: WeatherState, scene: SceneRef): string {
  return `${timeWord} · ${weather}${scene === 'custom' ? ' · custom' : scene === 'shuffled' ? ' · shuffled' : ''}`
}

export function panelView({ weather, settings, sliders }: PanelInput): PanelView {
  const scene: SceneRef = weather !== settings.weather ? 'custom' : settings.scene
  return {
    weather,
    scene,
    subtitle: subtitleOf(sliders.timeOfDay.word, weather, scene),
    pebbles: WEATHER_UI.map((w) => ({ state: w.state, pressed: w.state === weather, disabled: w.soon })),
    scenes: SCENES.map((s) => ({ id: s.id, pressed: s.id === scene })),
    sliders: SLIDER_KEYS.map((key) => {
      const s = sliders[key]
      return {
        key,
        label: SLIDER_UI[key].label,
        value: s.value,
        percent: s.value * 100,
        // The thunder slider's word is "Storm weather only" while it is off; the flag, not the word, says whether it is live.
        word: s.word,
        disabled: !s.enabled,
        set: s.set,
      }
    }),
  }
}

/** What `__GAME__.ui()` reports. */
export interface UiReport {
  /** The panel has been built (it is created after the game is ready). */
  readonly ready: boolean
  /** Unfolded (true) or the small "Sky" pill (false). */
  readonly open: boolean
  readonly weather: WeatherState
  readonly scene: SceneRef
  readonly subtitle: string
  readonly sliders: readonly SliderRowView[]
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000

export const reportOf = (view: PanelView, open: boolean): UiReport => ({
  ready: true,
  open,
  weather: view.weather,
  scene: view.scene,
  subtitle: view.subtitle,
  sliders: view.sliders.map((s) => ({ ...s, value: round3(s.value), percent: round3(s.percent) })),
})
