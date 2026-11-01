// Interaction parameters for the sim. One typed record, each field with a declared range and a default.
// Weather will later blend these; every blended value must still pass `clampParams`.

export interface ParamSpec {
  readonly min: number
  readonly max: number
  readonly default: number
}

export const PARAM_SPECS = {
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
  /** Smallest piece a split may shed, as a fraction of its cloud (never under 3 blobs); smaller pieces stay attached. */
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

export type ParamKey = keyof typeof PARAM_SPECS
export type Params = { [K in ParamKey]: number }

/** Minimum separation kept between d_touch and d_release even if ranges are edited later. */
export const GATE_MIN_GAP = 0.02

export const PARAM_KEYS = Object.keys(PARAM_SPECS) as ParamKey[]

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
