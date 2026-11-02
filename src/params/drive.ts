// The per-step weather drive main.ts runs: advance the weather, resolve P, and say whether the sim's interaction
// params changed. Pure (no three, no DOM), so tests run the exact path the game uses.
import { PARAM_KEYS, type Params } from '../sim/params.ts'
import type { FlowParams } from '../sim/flow.ts'
import type { Wind } from '../sim/sim.ts'
import type { SceneName } from '../sim/scene.ts'
import { FIELD_KEYS, clampField, type FieldKey, type Layer } from './fields.ts'
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

/** Swap in a whole `Layers` (scene/user/dev/transient). */
export function setDriveLayers(d: Drive, layers: Layers): DriveStep {
  return next(d, d.weather, layers)
}

/**
 * Add dev overrides (any field). Values are clamped into the field's range as they are stored; non-finite values and
 * unknown keys are dropped. Setting what is already set changes nothing. (The gate gap `d_touch < d_release` is
 * enforced when P resolves, so a dev layer can never break it.)
 */
export function setDriveDev(d: Drive, partial: Layer): DriveStep {
  const dev: Layer = { ...d.layers.dev }
  let changed = false
  for (const k of FIELD_KEYS) {
    const v = partial[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const c = clampField(k, v)
    if (dev[k] !== c) {
      dev[k] = c
      changed = true
    }
  }
  return changed ? next(d, d.weather, { ...d.layers, dev }) : next(d, d.weather, d.layers)
}

/** Remove dev overrides for `keys` (all of them when omitted); those fields fall back to the layers below. */
export function clearDriveDev(d: Drive, keys?: readonly FieldKey[]): DriveStep {
  const cur = d.layers.dev
  if (!cur) return next(d, d.weather, d.layers)
  const dev: Layer = { ...cur }
  let changed = false
  for (const k of keys ?? (Object.keys(cur) as FieldKey[])) {
    if (k in dev) {
      delete dev[k]
      changed = true
    }
  }
  return changed ? next(d, d.weather, { ...d.layers, dev }) : next(d, d.weather, d.layers)
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
  /** Ambient breeze for blobs (null while both the drift and the turbulence are zero). Optional so test sinks can omit it. */
  setBreeze?(b: FlowParams | null): void
}

/** The breeze for the sim from P, or null when there is neither drift nor turbulence. */
export function breezeOf(p: P): FlowParams | null {
  if (p.breezeSpeed === 0 && p.turbulence === 0) return null
  return { speed: p.breezeSpeed, angle: p.breezeAngle, turbulence: p.turbulence, scale: p.turbulenceScale, rate: p.turbulenceTime }
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
    sink.setBreeze?.(breezeOf(drive.p))
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
    /** Replace the named layers; layers not named keep their value (so a strike's transient cannot wipe the dev layer). */
    setLayers(l: Layers): void {
      push(setDriveLayers(drive, { ...drive.layers, ...l }))
    },
    /** Dev layer: see `setDriveDev`. */
    setDev(partial: Layer): void {
      push(setDriveDev(drive, partial))
    },
    clearDev(keys?: readonly FieldKey[]): void {
      push(clearDriveDev(drive, keys))
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

/**
 * The scene the game opens with for a weather: its cloud mix (clear = cumulus and a thin stratus, rain = stratus sheets,
 * thunder = storm towers, tornado = a bit of everything). Switching weather later does not respawn clouds.
 */
export function sceneForWeather(w: WeatherState): SceneName {
  return w === 'tornado' ? 'mixed' : w
}

/** The `?weather=` state, or null when the param is absent or unknown (so saved settings can tell "absent" from "clear"). */
export function parseWeatherParamOpt(search: string): WeatherState | null {
  const v = new URLSearchParams(search).get('weather')
  return v === 'clear' || v === 'rain' || v === 'thunder' || v === 'tornado' ? v : null
}

export function parseWeatherParam(search: string): WeatherState {
  return parseWeatherParamOpt(search) ?? 'clear'
}

/** The weather state that is steady now, or the one a blend is heading to. */
export function targetWeather(w: Weather): WeatherState {
  return w.kind === 'steady' ? w.state : w.to
}
