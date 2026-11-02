// The seven player sliders. Each is a normalised 0..1 position with a pure, monotone mapping to a bounded field value
// (and an inverse, for showing where an unset slider sits). Pure TypeScript: no three, no DOM.
//
// Unset sliders produce nothing, so with no settings the resolved P equals today's. Time of day goes into the `sky` layer
// (below the weather, so a grey rain sky still wins); the other six go into the `user` layer (above the weather).
import { FIELD_SPECS, type P, type SkyLayer, type UserLayer, type WeatherState } from '../params/index.ts'
import { skyLayerAt, timeOfDayFromSunX } from './timeOfDay.ts'

export const SLIDER_KEYS = ['timeOfDay', 'breeze', 'puffiness', 'rain', 'thunder', 'depth', 'squish'] as const
export type SliderKey = (typeof SLIDER_KEYS)[number]
/** The sliders the player has set, as 0..1 positions. A missing key is "follow the scene and weather". */
export type SliderValues = Partial<Record<SliderKey, number>>

/** Clamp to 0..1 (+-Infinity land on the ends; NaN counts as 0). */
export const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)))
const lerp = (a: number, b: number, v: number): number => a + (b - a) * v
const unlerp = (a: number, b: number, x: number): number => clamp01((x - a) / (b - a))

// Slider position -> field value. Every range sits inside the field's own range (tested).
const BREEZE_MAX = FIELD_SPECS.breezeSpeed.max
const PUFF_LUMP = [0.15, 0.95] as const // volLumpStrength: smooth domes .. deep billows (default .55 at .5)
const PUFF_HEIGHT = [0.6, 1.8] as const // volHeightCumulus, in blob radii (default 1.2 at .5)
const STRIKE_RATE = [0.07, 0.29] as const // strikes per second: about one per 14 s .. one per 3.4 s (thunder weather is .1)
const DEPTH_MAX = FIELD_SPECS.parallaxStrength.max // 2: default 1 at .5
const SQUISH = [FIELD_SPECS.squish.min, 1, FIELD_SPECS.squish.max] as const // firm .. 1 at .5 .. marshmallow

export const breezeSpeedOf = (v: number): number => lerp(0, BREEZE_MAX, clamp01(v))
export const lumpStrengthOf = (v: number): number => lerp(PUFF_LUMP[0], PUFF_LUMP[1], clamp01(v))
export const cumulusHeightOf = (v: number): number => lerp(PUFF_HEIGHT[0], PUFF_HEIGHT[1], clamp01(v))
export const rainRateOf = (v: number): number => clamp01(v)
export const strikeRateOf = (v: number): number => lerp(STRIKE_RATE[0], STRIKE_RATE[1], clamp01(v))
export const parallaxStrengthOf = (v: number): number => lerp(0, DEPTH_MAX, clamp01(v))
export function squishOf(v: number): number {
  const x = clamp01(v)
  return x <= 0.5 ? lerp(SQUISH[0], SQUISH[1], x * 2) : lerp(SQUISH[1], SQUISH[2], (x - 0.5) * 2)
}
function squishPosition(m: number): number {
  return m <= SQUISH[1] ? unlerp(SQUISH[0], SQUISH[1], m) / 2 : 0.5 + unlerp(SQUISH[1], SQUISH[2], m) / 2
}

/** The sun-height slider's layer (sky, sun and cloud tints), for `Layers.sky`. Empty while the slider is unset. */
export function skyLayerOf(sliders: SliderValues): SkyLayer {
  const t = sliders.timeOfDay
  return t === undefined ? {} : skyLayerAt(t)
}

/** The other sliders' layer, for `Layers.user`. Only set sliders contribute; never `strikesEnabled`, never raw interaction fields. */
export function userLayerOf(sliders: SliderValues): UserLayer {
  const u: UserLayer = {}
  if (sliders.breeze !== undefined) u.breezeSpeed = breezeSpeedOf(sliders.breeze)
  if (sliders.puffiness !== undefined) {
    u.volLumpStrength = lumpStrengthOf(sliders.puffiness)
    u.volHeightCumulus = cumulusHeightOf(sliders.puffiness)
  }
  if (sliders.rain !== undefined) u.rainRate = rainRateOf(sliders.rain)
  if (sliders.thunder !== undefined) u.strikeRate = strikeRateOf(sliders.thunder)
  if (sliders.depth !== undefined) u.parallaxStrength = parallaxStrengthOf(sliders.depth)
  if (sliders.squish !== undefined) u.squish = squishOf(sliders.squish)
  return u
}

/** Is the slider live? Thunder only matters when the weather lets lightning strike (`strikesEnabled` comes from the thunder preset). */
export function sliderEnabled(key: SliderKey, weather: WeatherState): boolean {
  return key !== 'thunder' || weather === 'thunder'
}

/**
 * Effective 0..1 positions for display: a slider the player has set shows its own value; an unset one is read back from
 * the resolved P (the inverse of its mapping, clamped), so it sits where the scene and weather put it.
 */
export function sliderValuesOf(p: P, set: SliderValues = {}): Record<SliderKey, number> {
  const fromP: Record<SliderKey, number> = {
    timeOfDay: timeOfDayFromSunX(p.skySunPosX),
    breeze: unlerp(0, BREEZE_MAX, p.breezeSpeed),
    puffiness: unlerp(PUFF_LUMP[0], PUFF_LUMP[1], p.volLumpStrength),
    rain: clamp01(p.rainRate),
    thunder: unlerp(STRIKE_RATE[0], STRIKE_RATE[1], p.strikeRate),
    depth: unlerp(0, DEPTH_MAX, p.parallaxStrength),
    squish: squishPosition(p.squish),
  }
  const out = {} as Record<SliderKey, number>
  for (const k of SLIDER_KEYS) out[k] = set[k] === undefined ? fromP[k] : clamp01(set[k])
  return out
}

// Friendly words, thresholds exactly as in the approved mockup.
const WORDS: Record<SliderKey, (v: number) => string> = {
  timeOfDay: (v) => (v < 0.12 ? 'Dawn' : v < 0.35 ? 'Morning' : v < 0.62 ? 'Midday' : v < 0.86 ? 'Sunset' : 'Dusk'),
  breeze: (v) => (v < 0.1 ? 'Still' : v < 0.38 ? 'Gentle' : v < 0.7 ? 'Brisk' : 'Gusty'),
  puffiness: (v) => (v < 0.25 ? 'Wispy' : v < 0.6 ? 'Soft' : v < 0.85 ? 'Puffy' : 'Billowy'),
  rain: (v) => (v < 0.05 ? 'Dry' : v < 0.35 ? 'Drizzle' : v < 0.7 ? 'Steady' : 'Downpour'),
  thunder: (v) => (v < 0.1 ? 'Rare' : v < 0.5 ? 'Occasional' : 'Frequent'),
  depth: (v) => (v < 0.2 ? 'Flat' : v < 0.6 ? 'Layered' : 'Deep'),
  squish: (v) => (v < 0.25 ? 'Firm' : v < 0.65 ? 'Springy' : 'Marshmallow'),
}

/** What the mockup shows in place of the word while the thunder slider is disabled. */
export const THUNDER_DISABLED_WORD = 'Storm weather only'

export const sliderWord = (key: SliderKey, v: number): string => WORDS[key](clamp01(v))
