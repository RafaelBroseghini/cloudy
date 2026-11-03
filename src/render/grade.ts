// Colour grade (M6): a pure function from a display-space (sRGB-encoded) colour to a graded one, and the 3D LUT it is
// baked into. No three: the scene uploads the bytes as a Data3DTexture and `lut3D` (three/tsl) samples it after the
// output transform. The LUT is rebuilt only when the resolved grade fields change (weather blends move them), so it is small.

/** LUT edge in texels: 16^3 RGBA8 is 16 KiB, cheap to rebuild and upload during a weather blend. */
export const LUT_SIZE = 16;

export interface Grade {
  /** Per-channel S-curve around `CONTRAST_PIVOT` (1 = none, above 1 = more contrast). Keeps 0 and 1 fixed. */
  contrast: number;
  /** Distance from the colour's luma (1 = none, 0 = grey). */
  saturation: number;
  /** White balance: positive warms (red up, blue down), negative cools. */
  temperature: number;
  /** Black level: positive lifts the blacks (milky), negative crushes them. */
  lift: number;
  /** Multipliers on the shadows and on the highlights (split toning); (1, 1, 1) is neutral. */
  shadow: readonly [number, number, number];
  highlight: readonly [number, number, number];
}

export const NEUTRAL_GRADE: Grade = { contrast: 1, saturation: 1, temperature: 0, lift: 0, shadow: [1, 1, 1], highlight: [1, 1, 1] };

/** The mid-grey the contrast curve turns around (display space, a little under 0.5 so a sky's mid tones keep their brightness). */
export const CONTRAST_PIVOT = 0.45;
/** Red and blue gain per unit of temperature. */
const TEMP_GAIN = 0.1;

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Monotone S-curve on [0, 1] through (0, 0), (p, p) and (1, 1); k = 1 is the identity. */
export function contrastCurve(x: number, k: number, p = CONTRAST_PIVOT): number {
  const v = clamp01(x);
  return v < p ? p * (v / p) ** k : 1 - (1 - p) * ((1 - v) / (1 - p)) ** k;
}

/** Grade one display-space colour (each channel 0..1) into `out`; the result is clamped to 0..1. */
export function gradeColor(g: Grade, r: number, gr: number, b: number, out: [number, number, number]): [number, number, number] {
  let x = r * (1 + TEMP_GAIN * g.temperature);
  let y = gr;
  let z = b * (1 - TEMP_GAIN * g.temperature);
  x = g.lift + x * (1 - g.lift);
  y = g.lift + y * (1 - g.lift);
  z = g.lift + z * (1 - g.lift);
  const k = Math.max(0.05, g.contrast);
  x = contrastCurve(x, k);
  y = contrastCurve(y, k);
  z = contrastCurve(z, k);
  const l0 = luma(x, y, z);
  x = l0 + (x - l0) * g.saturation;
  y = l0 + (y - l0) * g.saturation;
  z = l0 + (z - l0) * g.saturation;
  // Split toning: the shadow tint fades out by mid-grey, the highlight tint in from it.
  const l = clamp01(luma(x, y, z));
  const ws = (1 - l) * (1 - l);
  const wh = l * l;
  x *= (1 + (g.shadow[0] - 1) * ws) * (1 + (g.highlight[0] - 1) * wh);
  y *= (1 + (g.shadow[1] - 1) * ws) * (1 + (g.highlight[1] - 1) * wh);
  z *= (1 + (g.shadow[2] - 1) * ws) * (1 + (g.highlight[2] - 1) * wh);
  out[0] = clamp01(x);
  out[1] = clamp01(y);
  out[2] = clamp01(z);
  return out;
}

/**
 * Bake `g` into an RGBA8 LUT of `size`^3 texels (red fastest, then green, then blue: a Data3DTexture's layout). Texel i holds
 * the grade of i / (size - 1), so the corners are exact; `lut3D` insets its lookups by half a texel to hit them.
 */
export function fillLut(g: Grade, size: number, data: Uint8Array): Uint8Array {
  const out: [number, number, number] = [0, 0, 0];
  const s = size - 1;
  let o = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        gradeColor(g, ri / s, gi / s, bi / s, out);
        data[o] = Math.round(out[0] * 255);
        data[o + 1] = Math.round(out[1] * 255);
        data[o + 2] = Math.round(out[2] * 255);
        data[o + 3] = 255;
        o += 4;
      }
    }
  }
  return data;
}

export function sameGrade(a: Grade, b: Grade): boolean {
  return (
    a.contrast === b.contrast &&
    a.saturation === b.saturation &&
    a.temperature === b.temperature &&
    a.lift === b.lift &&
    a.shadow.every((v, i) => v === b.shadow[i]) &&
    a.highlight.every((v, i) => v === b.highlight[i])
  );
}
