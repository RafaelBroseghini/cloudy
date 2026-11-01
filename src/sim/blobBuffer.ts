// The one thing that crosses from the sim (CPU) to the renderer (GPU) each frame for the play layer.
// The sim writes it, the renderer uploads it as a data texture. Nothing flows back.

/** Floats per blob. Two RGBA texels per blob when uploaded. */
export const BLOB_STRIDE = 8

/** Upper bound the renderer sizes its texture for. */
export const MAX_BLOBS = 256

/**
 * A blob of radius r contributes to the density field out to r * INFLUENCE_FACTOR.
 * The renderer's metaball splat and the sim's density sampler must use the same value.
 */
export const INFLUENCE_FACTOR = 2.2

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
} as const

export function createBlobBuffer(): Float32Array {
  return new Float32Array(MAX_BLOBS * BLOB_STRIDE)
}
