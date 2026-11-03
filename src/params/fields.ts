// One spec table for every blendable field: group, blend kind, range, default.
// P is a flat record keyed by FieldKey; colours are three linear-RGB scalars (<name>R/G/B) so they blend per channel.
import { PARAM_KEYS, PARAM_SPECS, TYPE_PARAM_KEYS, type ParamKey } from '../sim/params.ts'

export type Group = 'interaction' | 'types' | 'feel' | 'sky' | 'lighting' | 'volume' | 'scenery' | 'weather' | 'postfx'
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

// The sim's params, all of them: the per-type multipliers get their own panel group, the rest are "interaction".
const typeKeys = new Set<string>(TYPE_PARAM_KEYS)
const interactionSpecs = Object.fromEntries(
  PARAM_KEYS.map((k) => [k, { group: typeKeys.has(k) ? 'types' : 'interaction', kind: 'linear', ...PARAM_SPECS[k] }]),
) as Record<ParamKey, FieldSpec<'interaction' | 'types'>>

// Defaults mirror today's uniforms in src/render/sky.ts and cloudField.ts (colours converted to linear).
export const FIELD_SPECS = {
  ...interactionSpecs,
  // feel: the player's squish slider. A multiplier `resolve` applies to the interaction fields (stiffness, damping, yield, split)
  // after the weather and user layers and before the dev layer; it is not itself a sim param, so the sim never sees it.
  /** Squishiness multiplier: below 1 firmer (stiffer, tears sooner), above 1 marshmallow (softer, stretchier). 1 changes nothing. */
  squish: f('feel', 0.6, 1.6, 1),
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
  /** Where the sun sits along the view axis: 1 in front of the viewer (lit faces toward us), 0 at the side, -1 behind the clouds (silver linings). */
  skySunDepth: f('sky', -1, 1, 0.35),
  // lighting
  /** Shadow contrast of the lit scenery layers (the play clouds' sunlight is `volSunGain`; the light direction is the sky's sun). */
  lightGain: f('lighting', 0, 6, 2.6),
  lightAmbient: f('lighting', 0, 1, 0),
  ...rgb('lighting', 'cloudLit', '#ffffff'),
  ...rgb('lighting', 'cloudMid', '#dfe9f6'),
  ...rgb('lighting', 'cloudShade', '#9fb3d6'),
  // volume: the play clouds as real volumes (src/render/volume.ts). Render-only; the step counts and scattering octaves
  // come from the quality tier, not from here. Defaults are the look the spike was tuned to in clear weather.
  /** Extinction per world unit: higher = denser, darker cores and deeper shadows, a softer lit skin. */
  volSigma: f('volume', 2, 40, 12),
  /** How far (world units) the march toward the sun reaches. */
  volReach: f('volume', 0.5, 6, 2.8),
  /** Sunlight strength on the clouds (the light direction itself comes from the sky's sun). */
  volSunGain: f('volume', 0, 6, 1.5),
  /** Erosion strength: how deeply the baked noise carves billows into the sim's silhouette (0 = smooth ellipsoids). Noise only subtracts, so the contour never grows. */
  volErosion: f('volume', 0, 1.5, 0.7),
  /** Outward lumpiness: how far the billows may bulge past the contour where the field is already above it (0 = never; towers most). The silhouette still follows the sim's contour (a few percent of area). */
  volLump: f('volume', 0, 1.2, 0.4),
  /** Layering of stratus sheets: depth of the horizontal bands inside them (0 = smooth sheets). */
  volStratusLayers: f('volume', 0, 1, 0.7),
  /** Billow size: the noise period in world units (bigger = fewer, rounder lumps), scaled with the clouds' own size on small screens. */
  volLumpScale: f('volume', 1, 8, 2.4),
  /** How flat the underside of cumulus and cumulonimbus is (0 = round all over, 1 = a thin, flat base). */
  volFlatBase: f('volume', 0, 1, 0.4),
  /** Powder effect: the thin, low-density skin scatters less toward the viewer (0 = off). */
  volPowder: f('volume', 0, 1, 0.6),
  /** Forward-scatter anisotropy of the phase function (Henyey-Greenstein g). */
  volPhaseG: f('volume', 0, 0.95, 0.72),
  /** Multiple scattering: gain of the second scattering octave (0 = shadows go dark, 1 = very soft). */
  volMultiScatter: f('volume', 0, 1, 0.45),
  /** Sky-light fill in shadowed parts (multiplies the ambient). */
  volAmbient: f('volume', 0, 2, 0.9),
  /** Ambient occlusion strength under overhanging parts. */
  volAO: f('volume', 0, 2, 0.55),
  /** Silver lining: light leaking through thin cloud edges when the sun is behind (needs skySunDepth < 0). */
  volSilver: f('volume', 0, 4, 1),
  /** Half-thickness (in blob radii) of each cloud type, and from it how deep a cloud is along the view axis. */
  volHeightCumulus: f('volume', 0.1, 3, 1.15),
  volHeightStratus: f('volume', 0.1, 3, 0.38),
  volHeightNimbus: f('volume', 0.1, 3, 1.9),
  // scenery: far bank, mid clouds, near wisps (render-only)
  ...scenery('far', 0.5, 0.3, 0.01, 0.5),
  ...scenery('mid', 0.7, 0.2, 0.02, 0.5),
  ...scenery('near', 0.35, 0.1, 0.05, 0.3),
  /** Scale of the parallax shift (cursor follow and idle sway) of the scenery and the rain bands: 0 = flat, 1 = today's depth. */
  parallaxStrength: f('scenery', 0, 2, 1),
  // weather (vortexStrength is a placeholder for M4)
  rainRate: f('weather', 0, 1, 0),
  rainAngle: f('weather', -0.8, 0.8, 0),
  rainSpeed: f('weather', 2, 30, 12),
  windX: f('weather', -3, 3, 0),
  windY: f('weather', -1, 1, 0),
  strikeRate: f('weather', 0, 1, 0),
  strikesEnabled: f('weather', 0, 1, 0, 'step'),
  vortexStrength: f('weather', 0, 1, 0),
  // ambient breeze on the play clouds (see sim/flow.ts); defaults are the clear-sky values: a slow drift, faint eddies
  /** Prevailing drift speed (units/s). Keep well under softSpeed (3). */
  breezeSpeed: f('weather', 0, 1.5, 0.18),
  /** Prevailing direction (radians, 0 = toward +x). Off-horizontal drift piles clouds against the top and bottom walls. */
  breezeAngle: f('weather', -Math.PI, Math.PI, 0),
  /** RMS speed (units/s) of the divergence-free curl noise added to the drift. */
  turbulence: f('weather', 0, 1, 0.06),
  /** Eddy size (units): the curl noise wavelength. */
  turbulenceScale: f('weather', 1.5, 20, 7),
  /** How fast the eddies evolve (noise cells per second; about 1 / eddy lifetime in seconds). */
  turbulenceTime: f('weather', 0, 1, 0.06),
  // postfx
  fxExposure: f('postfx', 0.25, 2, 1),
  fxFlash: f('postfx', 0, 1, 0),
  /** Screen x (0 left .. 1 right) of the flash's local glow. */
  fxFlashX: f('postfx', 0, 1, 0.5),
  /** Screen y (0 bottom .. 1 top) of the flash's local glow; lightning that starts in a cumulonimbus moves it there. */
  fxFlashY: f('postfx', 0, 1, 0.55),
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
