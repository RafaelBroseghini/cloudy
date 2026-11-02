// Saved settings: versioned JSON in localStorage under "cloudy:settings".
//
// Read pipeline (never throws; defaults are a normal outcome): read the string -> JSON.parse -> version check (newer
// than we know: defaults) -> migrate -> validate with Valibot (unknown keys dropped) -> clamp every slider to 0..1.
// Write: debounced, and every storage access is in try/catch (private mode, blocked storage, Safari's 7-day wipe).
import * as v from 'valibot'
import { WEATHER_STATES } from '../params/index.ts'
import { DEFAULT_SETTINGS, SCENE_IDS, type Settings } from './scenes.ts'
import { SLIDER_KEYS, clamp01, type SliderKey, type SliderValues } from './sliders.ts'

export const STORAGE_KEY = 'cloudy:settings'
export const SETTINGS_VERSION = 1
export const SAVE_DELAY_MS = 300

/** The slice of `Storage` we use. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
/** Looks the storage up on every call, inside try/catch by the caller: the `localStorage` getter itself can throw. */
export type StorageSource = () => StorageLike | null | undefined

/** The browser's localStorage, or null when it is missing or blocked. Never reached at module load. */
export const browserStorage: StorageSource = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const sliderEntries = Object.fromEntries(SLIDER_KEYS.map((k) => [k, v.number()])) as Record<SliderKey, v.NumberSchema<undefined>>

// `object` drops unknown keys. An unknown scene id falls back to `custom` rather than throwing the settings away.
const RecordSchema = v.object({
  version: v.literal(SETTINGS_VERSION),
  weather: v.picklist(WEATHER_STATES),
  scene: v.fallback(v.picklist([...SCENE_IDS, 'custom', 'shuffled'] as const), 'custom'),
  sliders: v.partial(v.object(sliderEntries)),
})

/**
 * Bring a parsed record of an older `from` version up to the current one. Version 1 is the first, so this is a no-op
 * seam: when the format changes, add one `if (from < n)` step per version here and bump SETTINGS_VERSION.
 */
export function migrate(data: unknown, from: number): unknown {
  void from
  return data
}

/** Settings from a stored string: valid and clamped, or the defaults. Never throws, for any input. */
export function parseSettings(raw: string | null | undefined): Settings {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS
  try {
    const json: unknown = JSON.parse(raw)
    if (typeof json !== 'object' || json === null) return DEFAULT_SETTINGS
    const version = (json as { version?: unknown }).version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > SETTINGS_VERSION) return DEFAULT_SETTINGS
    const res = v.safeParse(RecordSchema, migrate(json, version))
    if (!res.success) return DEFAULT_SETTINGS
    const { weather, scene, sliders } = res.output
    const clamped: SliderValues = {}
    for (const k of SLIDER_KEYS) {
      const x = sliders[k]
      if (x !== undefined && !Number.isNaN(x)) clamped[k] = clamp01(x)
    }
    return { weather, scene, sliders: clamped }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** The stored form of settings: only known keys, sliders clamped. */
export function serializeSettings(s: Settings): string {
  const sliders: SliderValues = {}
  for (const k of SLIDER_KEYS) {
    const x = s.sliders[k]
    if (x !== undefined && !Number.isNaN(x)) sliders[k] = clamp01(x)
  }
  return JSON.stringify({ version: SETTINGS_VERSION, weather: s.weather, scene: s.scene, sliders })
}

export function loadSettings(source: StorageSource = browserStorage): Settings {
  try {
    return parseSettings(source()?.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Returns whether the write went through; a failure is a normal outcome (the game just does not remember). */
export function saveSettings(s: Settings, source: StorageSource = browserStorage): boolean {
  try {
    const st = source()
    if (!st) return false
    st.setItem(STORAGE_KEY, serializeSettings(s))
    return true
  } catch {
    return false
  }
}

export function clearSavedSettings(source: StorageSource = browserStorage): void {
  try {
    source()?.removeItem(STORAGE_KEY)
  } catch {
    // Blocked storage: nothing to clear.
  }
}

/** Timer functions, injectable so tests do not wait. */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export interface Saver {
  /** Remember `s` and write it `SAVE_DELAY_MS` after the last call. */
  schedule(s: Settings): void
  /** Write a pending value now (page hide); nothing pending: nothing happens. */
  flush(): void
  /** Forget a pending value without writing (reset). */
  cancel(): void
}

export function createSaver(source: StorageSource = browserStorage, timers: Timers = realTimers, delay = SAVE_DELAY_MS): Saver {
  let pending: Settings | null = null
  let handle: unknown = null
  const write = (): void => {
    handle = null
    const s = pending
    pending = null
    if (s) saveSettings(s, source)
  }
  return {
    schedule(s) {
      pending = s
      if (handle !== null) timers.clear(handle)
      handle = timers.set(write, delay)
    },
    flush() {
      if (handle !== null) timers.clear(handle)
      write()
    },
    cancel() {
      if (handle !== null) timers.clear(handle)
      handle = null
      pending = null
    },
  }
}
