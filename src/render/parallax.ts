// Parallax camera offset: pure, no three, no DOM. The play plane (z = 0) never shifts (depth factor 1); render-only scenery
// layers shift by `offset * (1 - depth)` and the volume pass moves its eye by the same offset (`eyeOf`), so the clouds'
// near and far sides slide against the plane.
// Units: fractions of the view height, y-up like the world. The renderer multiplies by VIEW_HEIGHT.

import { EYE_MAX } from "./view.ts";

export interface ParallaxOptions {
  /** Cap on the cursor-driven offset (fraction of view height). */
  maxCursor?: number;
  /** Amplitude of the idle sway (fraction of view height). */
  maxSway?: number;
  /** Smoothing time constant of the cursor follow, seconds. */
  follow?: number;
  /** Start in reduced-motion mode. */
  reducedMotion?: boolean;
  /** Scale of the whole offset (cursor shift and sway): 0 = flat, 1 = default. */
  strength?: number;
}

export interface Parallax {
  /** Pointer in normalised view coordinates (-1..1, x right, y up), or null while the pointer is absent. */
  setTarget(p: { x: number; y: number } | null): void;
  setReducedMotion(on: boolean): void;
  /** Scale of the offset (0 = no movement, 1 = default); eases in, so a slider drag never makes the layers jump. */
  setStrength(s: number): void;
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
/** Matches the `parallaxStrength` field's range. */
const MAX_STRENGTH = 2;
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
  const clampStrength = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(MAX_STRENGTH, v)) : 1);
  let strengthTarget = clampStrength(opts.strength);
  let strength = strengthTarget;
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
    setStrength(s) {
      strengthTarget = clampStrength(s);
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
      strength += (strengthTarget - strength) * a;
      if (Math.abs(strengthTarget - strength) < 1e-4) strength = strengthTarget; // land exactly: 0 means no movement at all
      offset.x = (cx + Math.sin((time / SWAY_PERIOD_X) * tau) * maxSway * swayGain) * strength;
      offset.y = (cy + Math.sin((time / SWAY_PERIOD_Y) * tau) * maxSway * Y_SCALE * swayGain) * strength;
    },
  };
}

/**
 * Extra factor on the eye's gain under reduced motion (on top of REDUCED_CURSOR_SCALE already in the shift). The eye's gain is
 * steeper than it was, so a quarter of the shift would still move it twice as far as before; halving the gain puts the reduced
 * eye back where it was (about 1.8 units at the screen edge). The scenery layers are unaffected.
 */
export const REDUCED_EYE_GAIN = 0.5;

/**
 * World units of eye shift per world unit of the scenery's parallax shift, for small shifts (see `eyeOf`). Large: a cursor
 * near the middle of the screen already moves the eye several units, so the clouds' sides and thickness show everywhere.
 */
export const EYE_GAIN = 24;

/**
 * Eye position (world units, relative to the view centre) of the volume camera for the parallax shift the scenery uses
 * (`offset * VIEW_HEIGHT`, which already carries the Depth slider, the idle sway and the reduced-motion scale): the same
 * sign, so a cloud's back moves with the far banks and its front with the near wisps. Zero shift is exactly zero eye.
 */
export function eyeOf(shift: { x: number; y: number }, out: { x: number; y: number } = { x: 0, y: 0 }, gain = 1): { x: number; y: number } {
  // tanh: linear (gain EYE_GAIN) near the centre, then it flattens toward +-EYE_MAX, which the tile lists are padded for.
  const lim = (v: number): number => EYE_MAX * Math.tanh((v * EYE_GAIN * gain) / EYE_MAX) + 0; // + 0: never -0
  out.x = lim(shift.x);
  out.y = lim(shift.y);
  return out;
}

/** Screen-space shift of a layer with the given depth factor (1 = play layer, 0 = at infinity, >1 = foreground). */
export function layerShift(offset: number, depth: number): number {
  return offset * (1 - depth);
}
