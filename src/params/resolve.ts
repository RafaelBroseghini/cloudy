// P = defaults + scene + weather + user + transient; later layer wins per field, unset fields fall through.
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

/** Placeholder subset of continuous, non-interaction fields that M5's sliders may drive. */
export const SLIDER_KEYS = ['fxExposure', 'lightAmbient', 'skySunStrength', 'rainRate', 'midDensity'] as const satisfies readonly FieldKey[]
export type SliderKey = (typeof SLIDER_KEYS)[number]
/** Empty by default; M5 fills it from saved sliders. */
export type UserLayer = { [K in SliderKey]?: number }

/** A strike may touch lighting and post-FX only; interaction fields are not in the type. */
export type TransientKey = KeysOf<'lighting' | 'postfx'>
export type TransientLayer = { [K in TransientKey]?: number }
export const TRANSIENT_KEYS: readonly TransientKey[] = keysOfGroup('lighting', 'postfx')

export interface Layers {
  /** Preset scene (any field). */
  readonly scene?: Layer
  readonly user?: UserLayer
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
  apply(out, weatherLayer(weather, { ...out }), FIELD_KEYS)
  apply(out, layers.user, SLIDER_KEYS)
  apply(out, layers.transient, TRANSIENT_KEYS)
  for (const k of FIELD_KEYS) out[k] = clampField(k, out[k])
  // Belt and braces: the ranges already keep d_touch < d_release; clampParams enforces the minimum gap.
  const ip = clampParams(pick(out, PARAM_KEYS))
  for (const k of PARAM_KEYS) out[k] = ip[k]
  return Object.freeze(out)
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
