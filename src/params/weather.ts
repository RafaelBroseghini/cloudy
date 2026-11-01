// Weather state machine and the blended weather layer.
import { FIELD_SPECS, defaultValues, type Layer, type Values } from './fields.ts'
import { WEATHER_KEYS, WEATHER_PRESETS } from './presets.ts'

export const WEATHER_STATES = ['clear', 'rain', 'thunder', 'tornado'] as const
export type WeatherState = (typeof WEATHER_STATES)[number]
export type StateWeights = Readonly<Record<WeatherState, number>>

/**
 * `fromWeights` is the snapshot that makes retargeting continuous: the mix of presets being left, summing to 1.
 * It is one-hot on `from` for a transition begun from a steady state.
 * `from` keeps naming the state whose step-kind values are held until the end of the blend.
 */
export type Weather =
  | { readonly kind: 'steady'; readonly state: WeatherState }
  | {
      readonly kind: 'transition'
      readonly from: WeatherState
      readonly to: WeatherState
      /** 0..1; reaching 1 collapses to steady. */
      readonly progress: number
      /** Seconds, > 0. */
      readonly duration: number
      readonly fromWeights: StateWeights
    }

function oneHot(s: WeatherState): StateWeights {
  return { clear: +(s === 'clear'), rain: +(s === 'rain'), thunder: +(s === 'thunder'), tornado: +(s === 'tornado') }
}

export const steady = (state: WeatherState): Weather => ({ kind: 'steady', state })

/** Blend weight: smoothstep of progress, so a transition eases in and out. */
export function smooth(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return p * p * (3 - 2 * p)
}

/** Weights over the presets for the current moment (always sums to 1). */
export function stateWeights(w: Weather): StateWeights {
  if (w.kind === 'steady') return oneHot(w.state)
  const s = smooth(w.progress)
  const out = { clear: 0, rain: 0, thunder: 0, tornado: 0 }
  for (const k of WEATHER_STATES) out[k] = (1 - s) * w.fromWeights[k] + (k === w.to ? s : 0)
  return out
}

/**
 * Begin blending toward `to` over `seconds`. From mid-blend, the new transition starts from a snapshot of the
 * current weights (`fromWeights`), so the blended values do not jump. A request for the target already
 * being approached is ignored (the running blend keeps its duration). `seconds <= 0` switches at once.
 */
export function startTransition(w: Weather, to: WeatherState, seconds: number): Weather {
  if (w.kind === 'steady' ? w.state === to : w.to === to) return w
  if (!(seconds > 0)) return steady(to)
  if (w.kind === 'steady') return { kind: 'transition', from: w.state, to, progress: 0, duration: seconds, fromWeights: oneHot(w.state) }
  return { kind: 'transition', from: w.from, to, progress: 0, duration: seconds, fromWeights: stateWeights(w) }
}

/** Advance by dt seconds. Reaching progress 1 returns steady `to`. Negative or NaN dt counts as 0. */
export function advanceWeather(w: Weather, dt: number): Weather {
  if (w.kind === 'steady') return w
  const d = dt > 0 ? dt : 0
  const progress = w.progress + d / w.duration
  if (!(w.duration > 0) || progress >= 1) return steady(w.to)
  return { ...w, progress }
}

const presetValue = (state: WeatherState, key: keyof Values, base: Values): number => WEATHER_PRESETS[state][key] ?? base[key]

/**
 * The blended weather layer: P(s) = sum_i w_i * preset_i, with s = smoothstep(progress) (see `stateWeights`).
 * It covers exactly WEATHER_KEYS. A preset that leaves a key unset contributes `base[key]` (the value from the
 * layers below, default: field defaults), so a scene layer below still shows through. "step" fields hold the
 * `from` preset value until the transition ends.
 */
export function weatherLayer(w: Weather, base: Values = defaultValues()): Layer {
  const weights = stateWeights(w)
  const held = w.kind === 'steady' ? w.state : w.progress >= 1 ? w.to : w.from
  const out: Layer = {}
  for (const k of WEATHER_KEYS) {
    if (FIELD_SPECS[k].kind === 'step') {
      out[k] = presetValue(held, k, base)
      continue
    }
    let v = 0
    for (const st of WEATHER_STATES) v += weights[st] * presetValue(st, k, base)
    out[k] = v
  }
  return out
}
