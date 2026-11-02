// Interaction parameters for the sim. One typed record, each field with a declared range and a default.
// Weather will later blend these; every blended value must still pass `clampParams`.

export interface ParamSpec {
  readonly min: number
  readonly max: number
  readonly default: number
}

/**
 * Per-type interaction multipliers. The global params above are the cumulus baseline (every cumulus multiplier is 1, so
 * cumulus has no fields); a stratus or cumulonimbus blob scales them. Weather scales the baseline, the type scales on top.
 * Springs between two blobs use the mean of the two multipliers, except stiffness: the harmonic mean (two half-springs in
 * series, so the softer material dominates the bond). See docs/SIM.md.
 */
export const TYPE_MULTS = ['drag', 'stiff', 'damp', 'yield', 'creep', 'split', 'flick', 'mass', 'breeze'] as const
export type TypeMult = (typeof TYPE_MULTS)[number]
export type TypedPrefix = 'stratus' | 'nimbus'
export type TypeKey = `${TypedPrefix}${Capitalize<TypeMult>}`

const MULT_DOC: Record<TypeMult, string> = {
  drag: 'weight of its density in the cursor drag (k_r)',
  stiff: 'spring stiffness (k_s)',
  damp: 'spring damping (c)',
  yield: 'strain where a spring starts to creep (yieldStrain)',
  creep: 'creep rate past yield (creep)',
  split: 'strain where a spring breaks (splitStrain)',
  flick: 'cursor speed where flick tearing starts (flickRate)',
  mass: 'blob mass (inertia and spring reduced mass; density for rendering stays geometric)',
  breeze: 'how strongly the ambient air and wind move the blob',
}

/** Defaults per type: stratus is soft, light and tearable; cumulonimbus heavy, stiff and hard to split. */
const TYPE_DEFAULTS: Record<TypedPrefix, Record<TypeMult, number>> = {
  stratus: { drag: 0.45, stiff: 0.65, damp: 1.2, yield: 0.55, creep: 1.6, split: 0.7, flick: 0.8, mass: 0.7, breeze: 1.1 },
  nimbus: { drag: 2.6, stiff: 1.7, damp: 1.5, yield: 1.5, creep: 0.5, split: 2, flick: 4.5, mass: 1.8, breeze: 0.55 },
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function typeSpecs(): Record<TypeKey, ParamSpec> {
  const out: Record<string, ParamSpec> = {}
  for (const t of ['stratus', 'nimbus'] as const) {
    for (const m of TYPE_MULTS) out[`${t}${cap(m)}`] = { min: 0.1, max: 5, default: TYPE_DEFAULTS[t][m] }
  }
  return out as Record<TypeKey, ParamSpec>
}

/** Doc line for a type multiplier field (dev panel / docs). */
export function typeKeyDoc(key: TypeKey): string {
  const m = TYPE_MULTS.find((x) => key.endsWith(cap(x))) as TypeMult
  return `${key.startsWith('stratus') ? 'Stratus' : 'Cumulonimbus'} multiplier on ${MULT_DOC[m]}`
}

const BASE_SPECS = {
  /** Cursor drag per unit density: F_drag = -k_r * rho * v. */
  k_r: { min: 0, max: 400, default: 120 },
  /** Spring stiffness (force per unit stretch). Converted to a Box2D joint hertz per spring. */
  k_s: { min: 5, max: 400, default: 90 },
  /** Spring damping along the spring axis. Converted to a Box2D damping ratio per spring. */
  c: { min: 0, max: 40, default: 3 },
  /** Strain beyond which a spring creeps (plastic deformation). */
  yieldStrain: { min: 0.02, max: 2, default: 0.45 },
  /** Fraction of the excess stretch absorbed into the rest length per step once past yield. */
  creep: { min: 0, max: 0.5, default: 0.02 },
  /** Strain beyond which a spring breaks. */
  splitStrain: { min: 0.3, max: 6, default: 0.9 },
  /** Cursor speed per spring rest length (1/s) above which it starts tearing springs near it at a reduced split strain; full effect at twice this. */
  flickRate: { min: 5, max: 300, default: 16 },
  /** Split strain multiplier for springs touched by a cursor at full flick speed. */
  flickCut: { min: 0.05, max: 1, default: 0.15 },
  /** Smallest piece a split may shed, as a fraction of its cloud (never under MIN_PIECE_FLOOR = 4 blobs, in sim.ts); smaller pieces stay attached. */
  minPieceFrac: { min: 0, max: 0.5, default: 0.15 },
  /** Surface gap (units) under which two armed clouds merge. Ranges are disjoint from d_release so d_touch < d_release always. */
  d_touch: { min: 0, max: 0.4, default: 0.1 },
  /** Surface gap beyond which a split pair arms. */
  d_release: { min: 0.45, max: 3, default: 0.6 },
  /** Cooldown (seconds) after which a split pair arms regardless of distance. */
  tau: { min: 0.1, max: 20, default: 1.5 },
  /** Shape matching: fraction of the goal error removed per step (velocity nudge alpha*(g-p)/dt). */
  alpha: { min: 0, max: 0.5, default: 0.06 },
  /** Linear damping on blobs (1/s). */
  blobDamping: { min: 0, max: 10, default: 2.5 },
  /** Soft containment stiffness (1/s^2) pulling blobs that leave the visible rect back in; damped critically. 0 disables. */
  containK: { min: 0, max: 100, default: 25 },
  /** Blob speed (units/s) above which the excess decays quickly, so flicked pieces do not fly across the view. 1000 disables. */
  softSpeed: { min: 2, max: 1000, default: 3 },
  /** Cursor mass. */
  m_c: { min: 0.1, max: 10, default: 1 },
  /** Stiffness of the cursor's spring toward the pointer. */
  k_p: { min: 10, max: 20000, default: 4000 },
  /** Damping of the cursor's spring, acting on velocity relative to the pointer (no steady lag in free space). */
  c_p: { min: 0, max: 1000, default: 120 },
  /** Cursor speed cap (units/s), a safety net only: 180 is the most the world-step slicing (10 slices of 0.3 units) can sweep without skipping blobs. */
  cursorMaxSpeed: { min: 1, max: 400, default: 180 },
} as const satisfies Record<string, ParamSpec>

export const PARAM_SPECS = { ...BASE_SPECS, ...typeSpecs() } as const satisfies Record<string, ParamSpec>

export type ParamKey = keyof typeof PARAM_SPECS
export type Params = { [K in ParamKey]: number }

/** Minimum separation kept between d_touch and d_release even if ranges are edited later. */
export const GATE_MIN_GAP = 0.02

export const PARAM_KEYS = Object.keys(PARAM_SPECS) as ParamKey[]
/** The per-type multiplier fields (a subset of PARAM_KEYS); the dev panel shows them in their own group. */
export const TYPE_PARAM_KEYS = Object.keys(typeSpecs()) as TypeKey[]

/** One type's multipliers, resolved. Cumulus is all ones. */
export type TypeMults = Readonly<Record<TypeMult, number>>

const ONES: TypeMults = { drag: 1, stiff: 1, damp: 1, yield: 1, creep: 1, split: 1, flick: 1, mass: 1, breeze: 1 }

/** Multipliers by type index (`TYPE_INDEX`): cumulus, stratus, cumulonimbus. */
export function typeMultsOf(p: Params): readonly [TypeMults, TypeMults, TypeMults] {
  const pick = (prefix: TypedPrefix): TypeMults => {
    const o = {} as Record<TypeMult, number>
    for (const m of TYPE_MULTS) o[m] = p[`${prefix}${cap(m)}` as TypeKey]
    return o
  }
  return [ONES, pick('stratus'), pick('nimbus')]
}

export function defaultParams(): Params {
  const p = {} as Params
  for (const k of PARAM_KEYS) p[k] = PARAM_SPECS[k].default
  return p
}

function clampOne(key: ParamKey, v: number): number {
  const s: ParamSpec = PARAM_SPECS[key]
  if (!Number.isFinite(v)) return s.default
  return Math.min(s.max, Math.max(s.min, v))
}

export function gateOrdered(p: Pick<Params, 'd_touch' | 'd_release'>): boolean {
  return p.d_touch < p.d_release
}

/** Clamp every field into its range (non-finite values fall back to the default) and keep d_touch < d_release. */
export function clampParams(partial: Partial<Params>, base: Params = defaultParams()): Params {
  const out = { ...base }
  for (const k of PARAM_KEYS) {
    const v = partial[k]
    out[k] = clampOne(k, v === undefined ? out[k] : v)
  }
  if (!(out.d_touch < out.d_release - GATE_MIN_GAP)) {
    out.d_touch = Math.max(PARAM_SPECS.d_touch.min, out.d_release - GATE_MIN_GAP)
  }
  return out
}
