// Per-cloud summaries read off the blob buffer (what the GPU sees): centre, extent, dominant type. Pure.

import { BLOB, BLOB_STRIDE } from './blobBuffer.ts'
import { CLOUD_TYPES, type CloudType } from './types.ts'

export interface CloudSummary {
  readonly id: number
  /** Mass-weighted centre. */
  readonly x: number
  readonly y: number
  readonly blobs: number
  /** The type most of the cloud's blobs have (ties go to the first of cumulus, stratus, cumulonimbus). */
  readonly type: CloudType
  /** Bounding box of the blobs' discs. */
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
}

/** One summary per live cloud in a blob buffer, ordered by id. */
export function summarizeClouds(buf: Float32Array, count: number): CloudSummary[] {
  interface Acc {
    sx: number
    sy: number
    m: number
    n: number
    types: [number, number, number]
    x0: number
    x1: number
    y0: number
    y1: number
  }
  const acc = new Map<number, Acc>()
  for (let i = 0; i < count; i++) {
    const o = i * BLOB_STRIDE
    if ((buf[o + BLOB.alive] ?? 0) === 0) continue
    const id = buf[o + BLOB.cloudId] ?? 0
    const m = buf[o + BLOB.mass] ?? 1
    const x = buf[o + BLOB.x] ?? 0
    const y = buf[o + BLOB.y] ?? 0
    const r = buf[o + BLOB.radius] ?? 0
    const a = acc.get(id) ?? { sx: 0, sy: 0, m: 0, n: 0, types: [0, 0, 0], x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
    a.sx += x * m
    a.sy += y * m
    a.m += m
    a.n += 1
    a.types[0] += buf[o + BLOB.typeCumulus] ?? 0
    a.types[1] += buf[o + BLOB.typeStratus] ?? 0
    a.types[2] += buf[o + BLOB.typeNimbus] ?? 0
    a.x0 = Math.min(a.x0, x - r)
    a.x1 = Math.max(a.x1, x + r)
    a.y0 = Math.min(a.y0, y - r)
    a.y1 = Math.max(a.y1, y + r)
    acc.set(id, a)
  }
  return [...acc]
    .map(([id, a]) => {
      const top = Math.max(...a.types)
      const type = CLOUD_TYPES[a.types.indexOf(top)] ?? 'cumulus'
      return { id, x: a.sx / a.m, y: a.sy / a.m, blobs: a.n, type, x0: a.x0, x1: a.x1, y0: a.y0, y1: a.y1 }
    })
    .sort((p, q) => p.id - q.id)
}
