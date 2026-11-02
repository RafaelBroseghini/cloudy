// Quality tiers. A tier changes only target resolutions and the step counts of the light marches; the shaders are the same
// on every tier, so switching never compiles anything. Gameplay is identical on every tier.

export type TierName = "hi" | "mid" | "low";
export const TIER_NAMES = ["hi", "mid", "low"] as const satisfies readonly TierName[];

export interface Tier {
  /** Play-layer field, height and thickness maps, relative to the drawing buffer. */
  field: number;
  /** Scenery thickness bake, relative to the drawing buffer. */
  bake: number;
  /** Cap of the device pixel ratio the drawing buffer uses. */
  pixelRatio: number;
  /** Beer steps toward the sun through the play layer, scenery steps, and ring-AO taps. */
  steps: number;
  sceneSteps: number;
  aoTaps: number;
}

export const TIERS: Readonly<Record<TierName, Tier>> = {
  hi: { field: 0.5, bake: 0.3, pixelRatio: 2, steps: 8, sceneSteps: 5, aoTaps: 8 },
  mid: { field: 0.5, bake: 0.3, pixelRatio: 1.5, steps: 6, sceneSteps: 4, aoTaps: 6 },
  low: { field: 0.35, bake: 0.25, pixelRatio: 1, steps: 4, sceneSteps: 3, aoTaps: 4 },
};

export function isTierName(v: unknown): v is TierName {
  return v === "hi" || v === "mid" || v === "low";
}

/** Phones and small touch screens start on `low`; everything else on `hi`. `?tier=hi|mid|low` overrides. */
export function pickTier(search: string, coarsePointer: boolean, width: number): TierName {
  const asked = new URLSearchParams(search).get("tier");
  if (isTierName(asked)) return asked;
  return coarsePointer && width <= 860 ? "low" : "hi";
}

/** `pickTier` for the live page. */
export function initialTier(): TierName {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return pickTier(location.search, coarse, window.innerWidth);
}
