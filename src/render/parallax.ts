// Parallax camera offset: pure, no three, no DOM. The play layer never reads it (depth factor 1 => zero shift);
// only render-only scenery layers shift by `offset * (1 - depth)`.
// Units: fractions of the view height, y-up like the world. The renderer multiplies by VIEW_HEIGHT.

export interface ParallaxOptions {
  /** Cap on the cursor-driven offset (fraction of view height). */
  maxCursor?: number;
  /** Amplitude of the idle sway (fraction of view height). */
  maxSway?: number;
  /** Smoothing time constant of the cursor follow, seconds. */
  follow?: number;
  /** Start in reduced-motion mode. */
  reducedMotion?: boolean;
}

export interface Parallax {
  /** Pointer in normalised view coordinates (-1..1, x right, y up), or null while the pointer is absent. */
  setTarget(p: { x: number; y: number } | null): void;
  setReducedMotion(on: boolean): void;
  /** Advance by `dt` seconds (clamped, so a stalled tab cannot throw the layers across the screen). */
  step(dt: number): void;
  /** Current offset. Mutated in place by `step`; copy it if you keep it. */
  readonly offset: { x: number; y: number };
}

export const PARALLAX_DEFAULTS = {
  maxCursor: 0.06,
  maxSway: 0.018,
  follow: 0.9,
} as const;

/** Reduced motion keeps a little depth from the cursor but no autonomous movement. */
export const REDUCED_CURSOR_SCALE = 0.25;
/** Vertical parallax is weaker than horizontal: screens are wide and vertical drift reads as bobbing. */
const Y_SCALE = 0.6;
const MAX_DT = 0.25;
/** Two incommensurate, very slow periods (seconds) so the sway never visibly repeats. */
const SWAY_PERIOD_X = 37;
const SWAY_PERIOD_Y = 53;

const clamp1 = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

export function createParallax(opts: ParallaxOptions = {}): Parallax {
  const maxCursor = opts.maxCursor ?? PARALLAX_DEFAULTS.maxCursor;
  const maxSway = opts.maxSway ?? PARALLAX_DEFAULTS.maxSway;
  const follow = Math.max(1e-3, opts.follow ?? PARALLAX_DEFAULTS.follow);

  let reduced = opts.reducedMotion ?? false;
  let tx = 0;
  let ty = 0;
  // Smoothed cursor component and sway gain; the sway gain eases so toggling reduced motion does not pop.
  let cx = 0;
  let cy = 0;
  let swayGain = reduced ? 0 : 1;
  let time = 0;
  const offset = { x: 0, y: 0 };

  return {
    offset,
    setTarget(p) {
      tx = p ? clamp1(p.x) : 0;
      ty = p ? clamp1(p.y) : 0;
    },
    setReducedMotion(on) {
      reduced = on;
    },
    step(dt) {
      const d = Number.isFinite(dt) ? Math.max(0, Math.min(MAX_DT, dt)) : 0;
      time += d;
      // Exponential smoothing with exp(-dt/tau) is exact for any dt split, so 60 and 120 Hz agree.
      const a = 1 - Math.exp(-d / follow);
      const scale = (reduced ? REDUCED_CURSOR_SCALE : 1) * maxCursor;
      cx += (tx * scale - cx) * a;
      cy += (ty * scale * Y_SCALE - cy) * a;
      swayGain += ((reduced ? 0 : 1) - swayGain) * a;
      const tau = Math.PI * 2;
      offset.x = cx + Math.sin((time / SWAY_PERIOD_X) * tau) * maxSway * swayGain;
      offset.y = cy + Math.sin((time / SWAY_PERIOD_Y) * tau) * maxSway * Y_SCALE * swayGain;
    },
  };
}

/** Screen-space shift of a layer with the given depth factor (1 = play layer, 0 = at infinity, >1 = foreground). */
export function layerShift(offset: number, depth: number): number {
  return offset * (1 - depth);
}
