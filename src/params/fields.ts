// One spec table for every blendable field: group, blend kind, range, default.
// P is a flat record keyed by FieldKey; colours are three linear-RGB scalars (<name>R/G/B) so they blend per channel.
import { PARAM_KEYS, PARAM_SPECS, type ParamKey } from '../sim/params.ts'

export type Group = 'interaction' | 'sky' | 'lighting' | 'scenery' | 'weather' | 'postfx'
/** "linear": lerp. "step": keeps the from value until the blend ends, then takes the to value. */
export type BlendKind = 'linear' | 'step'

export interface FieldSpec<G extends Group = Group> {
  readonly group: G
  readonly kind: BlendKind
  readonly min: number
  readonly max: number
  readonly default: number
}

/** sRGB hex (what three's `new Color('#rrggbb')` reads) to linear RGB (what the shaders see). */
export function srgbHexToLinear(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  const lin = (c: number): number => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]
}

function f<G extends Group>(group: G, min: number, max: number, def: number, kind: BlendKind = 'linear'): FieldSpec<G> {
  return { group, kind, min, max, default: def }
}

type Rgb<P extends string, G extends Group> = { [K in `${P}R` | `${P}G` | `${P}B`]: FieldSpec<G> }
function rgb<G extends Group, P extends string>(group: G, prefix: P, hex: string): Rgb<P, G> {
  const [r, g, b] = srgbHexToLinear(hex)
  return { [`${prefix}R`]: f(group, 0, 2, r), [`${prefix}G`]: f(group, 0, 2, g), [`${prefix}B`]: f(group, 0, 2, b) } as Rgb<P, G>
}

type Scenery<P extends string> = { [K in `${P}Opacity` | `${P}Tint` | `${P}Drift` | `${P}Density`]: FieldSpec<'scenery'> }
function scenery<P extends string>(prefix: P, opacity: number, tint: number, drift: number, density: number): Scenery<P> {
  return {
    [`${prefix}Opacity`]: f('scenery', 0, 1, opacity),
    [`${prefix}Tint`]: f('scenery', 0, 1, tint),
    [`${prefix}Drift`]: f('scenery', -0.5, 0.5, drift),
    [`${prefix}Density`]: f('scenery', 0, 1, density),
  } as Scenery<P>
}

const interactionSpecs = Object.fromEntries(PARAM_KEYS.map((k) => [k, { group: 'interaction', kind: 'linear', ...PARAM_SPECS[k] }])) as Record<
  ParamKey,
  FieldSpec<'interaction'>
>

// Defaults mirror today's uniforms in src/render/sky.ts and cloudField.ts (colours converted to linear).
export const FIELD_SPECS = {
  ...interactionSpecs,
  // sky
  ...rgb('sky', 'skyTop', '#4f9be0'),
  ...rgb('sky', 'skyHorizon', '#bfe3f7'),
  ...rgb('sky', 'skyBottom', '#e9f3f2'),
  ...rgb('sky', 'skySun', '#fff1c9'),
  skyHorizonHeight: f('sky', 0, 1, 0.38),
  skySunPosX: f('sky', 0, 1, 0.78),
  skySunPosY: f('sky', 0, 1, 0.8),
  skySunSize: f('sky', 0.02, 1, 0.22),
  skySunStrength: f('sky', 0, 2, 0.55),
  // lighting
  lightDirX: f('lighting', -2, 2, -0.3),
  lightDirY: f('lighting', -2, 2, 1.1),
  lightGain: f('lighting', 0, 6, 2.6),
  lightAmbient: f('lighting', 0, 1, 0),
  ...rgb('lighting', 'cloudLit', '#ffffff'),
  ...rgb('lighting', 'cloudMid', '#dfe9f6'),
  ...rgb('lighting', 'cloudShade', '#9fb3d6'),
  // scenery: far bank, mid clouds, near wisps (render-only)
  ...scenery('far', 0.5, 0.3, 0.01, 0.5),
  ...scenery('mid', 0.7, 0.2, 0.02, 0.5),
  ...scenery('near', 0.35, 0.1, 0.05, 0.3),
  // weather (vortexStrength is a placeholder for M4)
  rainRate: f('weather', 0, 1, 0),
  rainAngle: f('weather', -0.8, 0.8, 0),
  rainSpeed: f('weather', 2, 30, 12),
  windX: f('weather', -3, 3, 0),
  windY: f('weather', -1, 1, 0),
  strikeRate: f('weather', 0, 1, 0),
  strikesEnabled: f('weather', 0, 1, 0, 'step'),
  vortexStrength: f('weather', 0, 1, 0),
  // postfx
  fxExposure: f('postfx', 0.25, 2, 1),
  fxFlash: f('postfx', 0, 1, 0),
  /** Screen x (0 left .. 1 right) of the flash's local glow. */
  fxFlashX: f('postfx', 0, 1, 0.5),
} as const satisfies Record<string, FieldSpec>

export type FieldKey = keyof typeof FIELD_SPECS
export type Values = { [K in FieldKey]: number }
/** Any subset of fields; unset fields fall through to earlier layers. */
export type Layer = Partial<Values>
export type KeysOf<G extends Group> = { [K in FieldKey]: (typeof FIELD_SPECS)[K]['group'] extends G ? K : never }[FieldKey]
export type ColorName = 'skyTop' | 'skyHorizon' | 'skyBottom' | 'skySun' | 'cloudLit' | 'cloudMid' | 'cloudShade'

export const FIELD_KEYS = Object.keys(FIELD_SPECS) as FieldKey[]

export function keysOfGroup<G extends Group>(...groups: G[]): KeysOf<G>[] {
  return FIELD_KEYS.filter((k) => (groups as Group[]).includes(FIELD_SPECS[k].group)) as KeysOf<G>[]
}

export function defaultValues(): Values {
  const v = {} as Values
  for (const k of FIELD_KEYS) v[k] = FIELD_SPECS[k].default
  return v
}

/** Clamp into range; non-finite falls back to the default. */
export function clampField(key: FieldKey, v: number): number {
  const s: FieldSpec = FIELD_SPECS[key]
  if (!Number.isFinite(v)) return s.default
  return Math.min(s.max, Math.max(s.min, v))
}
