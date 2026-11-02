// The one thing that crosses from the sim (CPU) to the renderer (GPU) each frame for the play layer.
// The sim writes it, the renderer uploads it as a data texture. Nothing flows back.

/**
 * Floats per blob: three RGBA texels (two of motion and size, one of type). 12 floats = 48 bytes, so 256 blobs upload
 * 12 KB per frame (PLAN's target is under 16 KB; a 16-float stride would sit exactly on it).
 */
export const BLOB_STRIDE = 12

/** Upper bound the renderer sizes its texture for. */
export const MAX_BLOBS = 256

/**
 * A blob of radius r contributes to the density field out to r * INFLUENCE_FACTOR.
 * The renderer's metaball splat and the sim's density sampler must use the same value.
 */
export const INFLUENCE_FACTOR = 2.2

/**
 * A blob contributes mass * (DENSITY_REF_RADIUS / radius)^2 * W(q). Mass is area (pi r^2), so without the factor density
 * would fall with the square of a cloud's layout scale and phone-sized clouds would render pale. With it, a cloud's core
 * density depends on its blob overlap only, not its size. Equal to the mean authored radius, so scale-1 clouds are unchanged.
 */
export const DENSITY_REF_RADIUS = 0.5

/** Density at which a cloud's edge sits (coverage ~50%). The renderer shades around it; cloud cores must exceed it. */
export const CLOUD_THRESHOLD = 0.42

/** Field offsets inside one blob record. */
export const BLOB = {
  x: 0,
  y: 1,
  radius: 2,
  mass: 3,
  vx: 4,
  vy: 5,
  /** Cloud id as a float; stable while a cloud lives, new ids after a split. */
  cloudId: 6,
  /** 1 for a live blob, 0 for an unused slot. */
  alive: 7,
  /**
   * Type as a one-hot over these three consecutive slots (cumulus, stratus, cumulonimbus): exactly one is 1 for a live blob,
   * all are 0 for an unused slot. One-hot rather than an index so the splat shader can multiply them straight into the
   * field's channels, and so a dead slot adds nothing to any of them.
   */
  typeCumulus: 8,
  typeStratus: 9,
  typeNimbus: 10,
  /** Spare (keeps the third texel whole). */
  spare: 11,
} as const

export function createBlobBuffer(): Float32Array {
  return new Float32Array(MAX_BLOBS * BLOB_STRIDE)
}
