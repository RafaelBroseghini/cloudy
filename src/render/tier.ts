// Quality tiers. A tier changes only target resolutions and step counts (view march, sun march, scattering octaves); the
// shaders are the same on every tier, so switching never compiles anything. Gameplay is identical on every tier.

export type TierName = "hi" | "mid" | "low";
export const TIER_NAMES = ["hi", "mid", "low"] as const satisfies readonly TierName[];

export interface Tier {
  /** Cloud march target, relative to the CSS viewport (not the drawing buffer: the clouds are soft, so a phone's DPR buys nothing there). */
  marchScale: number;
  /** Upper bound on the march target's pixel count, whatever the screen size. */
  marchMaxPixels: number;
  /** Steps of the view march through a cloud, steps of the sun march per sample, and multiple-scattering octaves. */
  steps: number;
  lightSteps: number;
  octaves: number;
  /** 1 = the view march also samples the fine erosion octave (0 = the big one only). */
  fine: 0 | 1;
  /** 1 = an ambient-occlusion tap per sample (darker under overhangs; about a fifth of the march's cost). */
  ao: 0 | 1;
  /** Sharpening of the march's upsample in the composite (0 = the plain 3x3 tent; see scene.ts). */
  sharp: number;
  /** Fraction of a step the view march's start jitter spans (see volume.ts): the low tier's few steps would show the dither. */
  jitter: number;
  /** Scenery thickness bake, relative to the drawing buffer. */
  bake: number;
  /** Cap of the device pixel ratio the drawing buffer uses. */
  pixelRatio: number;
  /** Sun-march steps and ring-AO taps of the lit scenery layers. */
  sceneSteps: number;
  aoTaps: number;
  /** Bloom's working resolution, relative to the drawing buffer (its five blur mips halve from there). Bloom is on every tier. */
  bloomScale: number;
}

/**
 * March target caps in pixels (about 0.75, 0.5 and 0.15 megapixels). Low scales like the others and lets its cap do the
 * shrinking: a phone (390x844) gets half resolution, a desktop window hits the cap at about 0.38 of its size (the spike's 0.35).
 */
export const MARCH_MAX_PIXELS = { hi: 750_000, mid: 500_000, low: 150_000 } as const;

export const TIERS: Readonly<Record<TierName, Tier>> = {
  hi: { marchScale: 0.5, marchMaxPixels: MARCH_MAX_PIXELS.hi, steps: 28, lightSteps: 6, octaves: 8, fine: 1, ao: 1, sharp: 0, jitter: 1, bake: 0.3, pixelRatio: 2, sceneSteps: 5, aoTaps: 8, bloomScale: 0.5 },
  mid: { marchScale: 0.5, marchMaxPixels: MARCH_MAX_PIXELS.mid, steps: 16, lightSteps: 4, octaves: 4, fine: 1, ao: 1, sharp: 0, jitter: 1, bake: 0.3, pixelRatio: 1.5, sceneSteps: 4, aoTaps: 6, bloomScale: 0.5 },
  low: { marchScale: 0.6, marchMaxPixels: MARCH_MAX_PIXELS.low, steps: 12, lightSteps: 4, octaves: 2, fine: 1, ao: 0, sharp: 1.5, jitter: 0, bake: 0.25, pixelRatio: 1.5, sceneSteps: 3, aoTaps: 4, bloomScale: 0.25 },
};

/**
 * Size (pixels) of the cloud march target for a CSS viewport: `marchScale` of each side, shrunk uniformly so the pixel count
 * stays under the tier's cap. It depends on the CSS size only, never on the device pixel ratio.
 */
export function marchSize(cssWidth: number, cssHeight: number, tier: Tier): { width: number; height: number } {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  const fit = Math.min(1, Math.sqrt(tier.marchMaxPixels / (w * h * tier.marchScale * tier.marchScale)));
  const scale = tier.marchScale * fit;
  // Floor (with a hair of slack for float error), so the cap is a hard bound.
  return { width: Math.max(2, Math.floor(w * scale + 1e-6)), height: Math.max(2, Math.floor(h * scale + 1e-6)) };
}

export function isTierName(v: unknown): v is TierName {
  return v === "hi" || v === "mid" || v === "low";
}

/** Phones and small touch screens start on `low`; everything else on `mid` (`hi` is opt-in). `?tier=hi|mid|low` overrides. */
export function pickTier(search: string, coarsePointer: boolean, width: number): TierName {
  const asked = new URLSearchParams(search).get("tier");
  if (isTierName(asked)) return asked;
  return coarsePointer && width <= 860 ? "low" : "mid";
}

/** `pickTier` for the live page. */
export function initialTier(): TierName {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return pickTier(location.search, coarse, window.innerWidth);
}
