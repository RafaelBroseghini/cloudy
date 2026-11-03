// Per-type look of the play clouds: the numbers and the height profiles the volume shader (volume.ts) uses. Pure (no three), so
// the profiles are unit-tested; the shader writes the same formulas in TSL and imports these constants, so the two cannot drift
// apart on a number. Type shares are 0..1 (`st` stratus, `nb` cumulonimbus, the rest cumulus) and `h` is the height in the
// cloud (0 at its lowest blob, 1 at its highest).
//
// What each type is for (Schneider's Nubis profiles, restated in blob terms):
//   cumulus        erosion grows a little toward the top; a mildly flattened base.
//   cumulonimbus   a clean, flat, darker base cut a little above the lowest blob and slightly ragged; erosion small at the base and
//                  carved hardest at the top and anvil; two sizes of billow (a coarse octave of big lobes + the mid one), a harder
//                  contrast so the creases cut deep, and a bounded outward lumpiness where the field is above the contour.
//   stratus        noise stretched along x and squeezed along y (streaks), vertical banding with a wobble, a lumpy thickness along
//                  its length, a grey underside, and thin parts that stay translucent.

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Cumulonimbus: contrast of the billow noise (the coarse lobes are remapped by smoothstep over this range). */
export const TOWER_CONTRAST = [0.12, 0.75] as const;
/** Cumulonimbus: the coarse octave samples the baked noise at this fraction of the mid octave's frequency (bigger lobes). */
export const TOWER_COARSE_SCALE = 0.45;
/** Erosion gain of a cumulus (base .. top), of a tower (base .. top) and of a sheet. */
export const GAIN_CUMULUS = [0.55, 1.25] as const;
export const GAIN_TOWER = [0.3, 1.7] as const;
export const GAIN_STRATUS = 0.9;
/** A tower's flat base: density is cut in from this height, over this width (fractions of the cloud's height), plus ragged noise. */
export const TOWER_BASE_CUT = [0.07, 0.06] as const;
export const TOWER_BASE_RAGGED = 0.1;
/** Share of the underside a cumulus's flatBase thins over (height fraction). */
export const CUMULUS_BASE_WIDTH = 0.22;
/** Stratus: noise frequency factor along x (streaks) and along y (layers). */
export const STRATUS_STRETCH = [0.25, 1.6] as const;
/** Stratus: band wobble (noise phase), tilt along x (rad per unit) and thickness variation along the sheet. */
export const STRATUS_BAND_WOBBLE = 4.5;
export const STRATUS_BAND_TILT = 0.35;
export const STRATUS_BAND_FREQ = 12;
export const STRATUS_THICKNESS_VAR = 0.8;
/** Stratus: extinction multiplier (thin parts stay see-through) and the grey of its underside .. top. */
export const STRATUS_SIGMA = 1;
export const STRATUS_GREY = [0.5, 0.78] as const;
/** Cumulonimbus: brightness of its base .. top (a dark flat base under a sunlit top). */
export const TOWER_GREY = [0.3, 1.2] as const;

/** Erosion gain by height in the cloud and type: cumulus mild, tower clean at the base and hard at the top, sheet even. */
export function erosionGain(h: number, st: number, nb: number): number {
  const cu = mix(GAIN_CUMULUS[0], GAIN_CUMULUS[1], h);
  const tower = mix(GAIN_TOWER[0], GAIN_TOWER[1], smoothstep(0.15, 0.95, h));
  return mix(mix(cu, tower, nb), GAIN_STRATUS, st);
}

/**
 * Density factor at height `h` that flattens the underside: 1 above, falling to 0 at the base. Cumulus and tower share `flatBase`
 * (stratus keeps its full base); a tower is cut flat whatever `flatBase` says, at its own height, a little ragged (`ragged` in
 * about -0.5..0.5, from noise).
 */
export function baseFlat(h: number, st: number, nb: number, flatBase: number, ragged: number): number {
  const r = ragged * TOWER_BASE_RAGGED;
  const tower = smoothstep(TOWER_BASE_CUT[0] + r, TOWER_BASE_CUT[0] + TOWER_BASE_CUT[1] + r, h);
  const cu = smoothstep(0, CUMULUS_BASE_WIDTH, h);
  return mix(1, mix(cu, tower, nb), Math.max(flatBase * (1 - st), nb * 0.85));
}

/** Brightness multiplier by height for the grey of the type: a tower is dark at its base and bright on top, a sheet grey below. */
export function typeGrey(h: number, st: number, nb: number): number {
  const tower = mix(TOWER_GREY[0], TOWER_GREY[1], smoothstep(0.1, 0.85, h));
  const sheet = mix(STRATUS_GREY[0], STRATUS_GREY[1], smoothstep(0.05, 0.7, h));
  return mix(1, sheet, st) * mix(1, tower, nb);
}

/**
 * Stratus layering: a density factor (about 1 on average, 0 in a band's trough) from the height `y` (world units), a noise value `n` (0..1) that wobbles the bands,
 * the position `x` along the sheet, the band depth `amount` (0 = none) and the thickness noise `along` (0..1).
 */
export function stratusLayer(y: number, x: number, n: number, along: number, amount: number): number {
  const band = 0.5 + 0.5 * Math.sin(y * STRATUS_BAND_FREQ + n * STRATUS_BAND_WOBBLE + x * STRATUS_BAND_TILT);
  return (1 - amount + band * amount) * (0.55 + along * STRATUS_THICKNESS_VAR * 2);
}

/** Outward lumpiness (in units of the contour density): the billow noise `bill` may add at most `budget`, only where the field is above the contour and not deep inside. */
export function lumpOut(bill: number, sn: number, h: number, nb: number, st: number, budget: number): number {
  const band = smoothstep(0.5, 1, sn) * (1 - smoothstep(1.3, 2.2, sn));
  return clamp01((bill - 0.4) * 2.5) * band * budget * mix(0.5, 1, h) * (nb * 0.8 + 0.2) * (1 - st);
}
