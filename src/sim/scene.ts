// Scene layouts: where blobs start and which pairs get springs. Pure and seeded, so scenes are reproducible.

import { MAX_BLOBS } from './blobBuffer.ts'

export interface CloudSpec {
  /** Centre in world units. */
  readonly x: number
  readonly y: number
  /** Number of blobs. */
  readonly blobs: number
  /** Lattice spacing between neighbouring blob centres. Default 0.75. */
  readonly spacing?: number
  /** Horizontal stretch of the outline, so clouds are wider than tall. Default 1.3. */
  readonly aspect?: number
}

export interface SceneSpec {
  readonly clouds: readonly CloudSpec[]
  readonly seed?: number
}

export interface BlobInit {
  readonly x: number
  readonly y: number
  readonly radius: number
  /** Index into `SceneSpec.clouds`. */
  readonly cloud: number
}

export interface SceneLayout {
  readonly blobs: BlobInit[]
  readonly springs: Array<readonly [number, number]>
}

export type SceneName = 'm1' | 'empty'

/** Small deterministic PRNG (mulberry32); the sim must not touch Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildLayout(spec: SceneSpec): SceneLayout {
  const rnd = mulberry32(spec.seed ?? 1)
  const blobs: BlobInit[] = []
  const springs: Array<readonly [number, number]> = []
  spec.clouds.forEach((c, ci) => {
    const s = c.spacing ?? 0.75
    const aspect = c.aspect ?? 1.3
    const want = Math.max(0, Math.min(c.blobs, MAX_BLOBS - blobs.length))
    // Jittered hex lattice; keep the `want` points nearest the centre in the stretched metric.
    const pts: Array<{ x: number; y: number; d: number }> = []
    const reach = Math.ceil(Math.sqrt(want)) + 3
    for (let r = -reach; r <= reach; r++) {
      for (let q = -reach; q <= reach; q++) {
        const x = (q + r * 0.5) * s + (rnd() - 0.5) * 0.12 * s
        const y = r * 0.866 * s + (rnd() - 0.5) * 0.12 * s
        pts.push({ x, y, d: (x / aspect) ** 2 + y ** 2 })
      }
    }
    pts.sort((p, q) => p.d - q.d)
    const first = blobs.length
    for (const p of pts.slice(0, want)) {
      blobs.push({ x: c.x + p.x, y: c.y + p.y, radius: 0.42 + 0.16 * rnd(), cloud: ci })
    }
    for (let i = first; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = blobs[i]
        const b = blobs[j]
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 1.3 * s) springs.push([i, j])
      }
    }
  })
  return { blobs, springs }
}

/** Named scenes sized to the visible world (viewH is 10 units; viewW = 10 * aspect). */
export function sceneSpec(name: SceneName, viewW: number, viewH: number): SceneSpec {
  switch (name) {
    case 'empty':
      return { clouds: [] }
    case 'm1':
      return {
        clouds: [
          { x: -0.26 * viewW, y: 0.14 * viewH, blobs: 45 },
          { x: 0.02 * viewW, y: -0.2 * viewH, blobs: 36 },
          { x: 0.3 * viewW, y: 0.16 * viewH, blobs: 28 },
        ],
      }
  }
}
