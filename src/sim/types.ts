// Cloud types. A blob has one type for its whole life; a cloud is whatever blobs it holds, so merged clouds can be mixed.
// Pure data: the sim reads the type's multipliers (params.ts), the renderer reads the one-hot in the blob buffer.

export const CLOUD_TYPES = ['cumulus', 'stratus', 'cumulonimbus'] as const
export type CloudType = (typeof CLOUD_TYPES)[number]

/** Index of each type: the slot in the blob buffer's one-hot (`BLOB.typeCumulus + index`) and in per-type tables. */
export const TYPE_INDEX: Readonly<Record<CloudType, number>> = { cumulus: 0, stratus: 1, cumulonimbus: 2 }
