// P = defaults + scene + sky + weather + user + dev + transient; later layer wins per field, unset fields fall through.
import { PARAM_KEYS, clampParams, type Params } from '../sim/params.ts'
import {
  FIELD_KEYS,
  clampField,
  defaultValues,
  keysOfGroup,
  type ColorName,
  type FieldKey,
  type KeysOf,
  type Group,
  type Layer,
  type Values,
} from './fields.ts'
import { weatherLayer, type Weather } from './weather.ts'

/**
 * Fields the time-of-day slider writes: sky colours, the sun and the cloud lighting tints. They sit BELOW the weather
 * layer (`Layers.sky`), so a grey rain sky still wins over a sunset and blends in over a weather transition.
 */
export const SKY_KEYS = [
  'skyTopR', 'skyTopG', 'skyTopB', 'skyHorizonR', 'skyHorizonG', 'skyHorizonB', 'skyBottomR', 'skyBottomG', 'skyBottomB',
  'skySunR', 'skySunG', 'skySunB', 'skySunPosX', 'skySunPosY', 'skySunSize', 'skySunStrength', 'skySunDepth',
  'cloudLitR', 'cloudLitG', 'cloudLitB', 'cloudMidR', 'cloudMidG', 'cloudMidB', 'cloudShadeR', 'cloudShadeG', 'cloudShadeB',
] as const satisfies readonly FieldKey[]
export type SkyKey = (typeof SKY_KEYS)[number]
export type SkyLayer = { [K in SkyKey]?: number }

/**
 * Fields the other player sliders write (they win over the weather): never `strikesEnabled` or any other step/feature
 * field, never a raw interaction field. The squish slider reaches the sim only through the bounded `squish` multiplier.
 */
export const USER_KEYS = [
  'breezeSpeed', 'volLumpStrength', 'volHeightCumulus', 'rainRate', 'strikeRate', 'parallaxStrength', 'squish',
] as const satisfies readonly FieldKey[]
export type UserKey = (typeof USER_KEYS)[number]
/** Empty unless the player has set a slider (src/settings builds it); an unset slider follows the scene and weather. */
export type UserLayer = { [K in UserKey]?: number }

/** A strike may touch lighting and post-FX only; interaction fields are not in the type. */
export type TransientKey = KeysOf<'lighting' | 'postfx'>
export type TransientLayer = { [K in TransientKey]?: number }
export const TRANSIENT_KEYS: readonly TransientKey[] = keysOfGroup('lighting', 'postfx')

export interface Layers {
  /** Preset scene (any field). */
  readonly scene?: Layer
  /** Time-of-day sky and lighting (`SKY_KEYS` only), applied before the weather so the weather mood blends on top. */
  readonly sky?: SkyLayer
  readonly user?: UserLayer
  /** Developer overrides (any field, interaction included): above weather and user, below the strike flash. Dev panel only. */
  readonly dev?: Layer
  readonly transient?: TransientLayer
}

/** Resolved parameters: flat, clamped, frozen. */
export type P = Readonly<Values>

function apply(out: Values, layer: Layer | undefined, keys: readonly FieldKey[]): void {
  if (!layer) return
  // Reads only `keys`, so a transient layer smuggled in with interaction keys (cast, non-literal) is still ignored.
  for (const k of keys) {
    const v = layer[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
}

export function resolve(layers: Layers, weather: Weather): P {
  const out = defaultValues()
  apply(out, layers.scene, FIELD_KEYS)
  apply(out, layers.sky, SKY_KEYS)
  apply(out, weatherLayer(weather, { ...out }), FIELD_KEYS)
  apply(out, layers.user, USER_KEYS)
  // Before the dev layer, so a dev override of an interaction field stays exact; the dev layer's own squish still counts.
  const dv = layers.dev?.squish
  applySquish(out, typeof dv === 'number' && Number.isFinite(dv) ? dv : out.squish)
  apply(out, layers.dev, FIELD_KEYS)
  apply(out, layers.transient, TRANSIENT_KEYS)
  for (const k of FIELD_KEYS) out[k] = clampField(k, out[k])
  // Belt and braces: the ranges already keep d_touch < d_release; clampParams enforces the minimum gap.
  const ip = clampParams(pick(out, PARAM_KEYS))
  for (const k of PARAM_KEYS) out[k] = ip[k]
  return Object.freeze(out)
}

/**
 * The squish multiplier m (above 1 = squishier): stiffness /= m, damping *= sqrt(m), yield /= sqrt(m), split *= sqrt(m).
 * Yield stays under 0.9x split. Only these four fields change, and m = 1 (the default) leaves every value untouched.
 * The merge gate, cursor and type multipliers are never touched, so `d_touch < d_release` still holds.
 */
function applySquish(out: Values, squish: number): void {
  const m = clampField('squish', squish)
  if (m === 1) return
  const r = Math.sqrt(m)
  out.k_s = out.k_s / m
  out.c = out.c * r
  out.splitStrain = out.splitStrain * r
  out.yieldStrain = Math.min(out.yieldStrain / r, out.splitStrain * 0.9)
}

function pick<K extends FieldKey>(p: Values, keys: readonly K[]): { [Q in K]: number } {
  const o = {} as { [Q in K]: number }
  for (const k of keys) o[k] = p[k]
  return o
}

/** Exactly the sim's params shape: `sim.setParams(interactionOf(P))`. */
export function interactionOf(p: P): Params {
  return clampParams(pick(p, PARAM_KEYS))
}

/** The fields of one group, e.g. `groupOf(p, 'sky')`, for pushing uniforms. */
export function groupOf<G extends Group>(p: P, group: G): { [K in KeysOf<G>]: number } {
  return pick(p, keysOfGroup(group))
}

/** A colour as a linear-RGB triple; feed to `color.setRGB(r, g, b)` (linear working space), not via hex. */
export function colorOf(p: P, name: ColorName): readonly [number, number, number] {
  return [p[`${name}R`], p[`${name}G`], p[`${name}B`]]
}
