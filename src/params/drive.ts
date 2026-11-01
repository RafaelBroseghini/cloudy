// The per-step weather drive main.ts runs: advance the weather, resolve P, and say whether the sim's interaction
// params changed. Pure (no three, no DOM), so tests run the exact path the game uses.
import { PARAM_KEYS, type Params } from '../sim/params.ts'
import type { Wind } from '../sim/sim.ts'
import { interactionOf, resolve, type Layers, type P } from './resolve.ts'
import { advanceWeather, startTransition, steady, type Weather, type WeatherState } from './weather.ts'

export interface Drive {
  readonly layers: Layers
  readonly weather: Weather
  /** Resolved parameters for `weather` (re-resolved only when the weather or the layers change). */
  readonly p: P
  /** `interactionOf(p)`: what the sim should be running. */
  readonly interaction: Params
}

export interface DriveStep {
  readonly drive: Drive
  /** True when `drive.interaction` differs from the previous step's: the caller then calls `sim.setParams`. */
  readonly interactionChanged: boolean
  /** True when any resolved field may differ: the caller then pushes the look. */
  readonly changed: boolean
}

function make(layers: Layers, weather: Weather): Drive {
  const p = resolve(layers, weather)
  return { layers, weather, p, interaction: interactionOf(p) }
}

export function createDrive(layers: Layers, initial: WeatherState): Drive {
  return make(layers, steady(initial))
}

export function sameInteraction(a: Params, b: Params): boolean {
  for (const k of PARAM_KEYS) if (a[k] !== b[k]) return false
  return true
}

function next(prev: Drive, weather: Weather, layers: Layers): DriveStep {
  if (weather === prev.weather && layers === prev.layers) return { drive: prev, interactionChanged: false, changed: false }
  const drive = make(layers, weather)
  const interactionChanged = !sameInteraction(prev.interaction, drive.interaction)
  // Keep the previous interaction object when nothing changed, so identity also says "unchanged".
  return { drive: interactionChanged ? drive : { ...drive, interaction: prev.interaction }, interactionChanged, changed: true }
}

/** One tick of weather time. Steady weather costs nothing (no resolve). Call once per fixed sim step, with FIXED_DT. */
export function stepDrive(d: Drive, dt: number): DriveStep {
  return next(d, advanceWeather(d.weather, dt), d.layers)
}

/** Begin a blend to `to` over `seconds` (0 = at once). Asking for the state already being approached changes nothing. */
export function setDriveWeather(d: Drive, to: WeatherState, seconds: number): DriveStep {
  return next(d, startTransition(d.weather, to, seconds), d.layers)
}

/** Swap the scene/user/transient layers (M5 sliders, M3 strikes). */
export function setDriveLayers(d: Drive, layers: Layers): DriveStep {
  return next(d, d.weather, layers)
}

/**
 * Units/s^2 of blob acceleration per unit of windX / windY. A full-strength field would sweep every cloud into the view
 * edge within seconds (uniform drift, containment is the only brake), so this keeps tornado's 1.6 to a steady lean.
 */
export const WIND_ACCEL_GAIN = 0.2

/** Blob wind acceleration (units/s^2) from P. It reaches blobs only (`sim.setWind`); the cursor equation never sees it. */
export function windOf(p: P): { readonly x: number; readonly y: number } {
  return { x: p.windX * WIND_ACCEL_GAIN, y: p.windY * WIND_ACCEL_GAIN }
}

/** The slice of the sim the drive writes to (`Sim` satisfies it). */
export interface DriveSink {
  setParams(p: Params): void
  setWind(w: Wind | null): void
}

/**
 * Stateful wrapper main.ts runs. `step(dt)` once per fixed sim step, so weather time and sim time stay in lockstep
 * and a run is the same at any display rate. The sink is touched only when something changed: `setParams` only when an
 * interaction field differs, `setWind` only when P changed (and `null` while the wind is zero).
 */
export function createDriveRunner(sink: DriveSink, layers: Layers, initial: WeatherState) {
  let drive = createDrive(layers, initial)
  let wind = windOf(drive.p)
  const windFn: Wind = () => wind
  const sync = (): void => {
    wind = windOf(drive.p)
    sink.setWind(wind.x === 0 && wind.y === 0 ? null : windFn)
  }
  sink.setParams(drive.interaction)
  sync()
  const push = (s: DriveStep): void => {
    drive = s.drive
    if (s.interactionChanged) sink.setParams(drive.interaction)
    if (s.changed) sync()
  }
  return {
    get drive(): Drive {
      return drive
    },
    step(dt: number): void {
      push(stepDrive(drive, dt))
    },
    setWeather(to: WeatherState, seconds: number): void {
      push(setDriveWeather(drive, to, seconds))
    },
    setLayers(l: Layers): void {
      push(setDriveLayers(drive, l))
    },
  }
}

export type WeatherReport =
  | { readonly kind: 'steady'; readonly state: WeatherState; readonly progress: 1 }
  | { readonly kind: 'transition'; readonly from: WeatherState; readonly to: WeatherState; readonly progress: number }

/** What the harness shows: a steady state counts as fully arrived (progress 1). */
export function reportWeather(w: Weather): WeatherReport {
  return w.kind === 'steady'
    ? { kind: 'steady', state: w.state, progress: 1 }
    : { kind: 'transition', from: w.from, to: w.to, progress: w.progress }
}

export function parseWeatherParam(search: string): WeatherState {
  const v = new URLSearchParams(search).get('weather')
  return v === 'rain' || v === 'thunder' || v === 'tornado' ? v : 'clear'
}
