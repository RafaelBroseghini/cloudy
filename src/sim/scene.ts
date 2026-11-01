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
  /** Multiplies the spacing and the blob radii, so a cloud keeps its look at any size. Default 1. */
  readonly scale?: number
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
    const k = c.scale ?? 1
    const s = (c.spacing ?? 0.75) * k
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
      blobs.push({ x: c.x + p.x, y: c.y + p.y, radius: k * (0.42 + 0.16 * rnd()), cloud: ci })
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

/** Half-width and half-height of a cloud's outline (blob radii included) at scale 1. */
function unitExtent(blobs: number, aspect: number): { hw: number; hh: number } {
  const { blobs: b } = buildLayout({ clouds: [{ x: 0, y: 0, blobs, aspect }] })
  let hw = 0
  let hh = 0
  for (const p of b) {
    hw = Math.max(hw, Math.abs(p.x) + p.radius)
    hh = Math.max(hh, Math.abs(p.y) + p.radius)
  }
  return { hw, hh }
}

/** A cloud sized to sit inside the box centred at (cx, cy) with half-size (hx, hy): wide boxes get wider outlines. */
function fitCloud(cx: number, cy: number, hx: number, hy: number, blobs: number): CloudSpec {
  const aspect = Math.min(2, Math.max(1.2, hx / hy))
  const u = unitExtent(blobs, aspect)
  // Cap at the authored size so a roomy view does not blow clouds up.
  const scale = Math.min(1, hx / u.hw, hy / u.hh)
  return { x: cx, y: cy, blobs, scale, aspect }
}

/** Below this aspect (width / height) the m1 clouds stack in a zigzag instead of sitting in a triangle. */
const STACK_ASPECT = 0.85

/**
 * m1: three clouds laid out relative to the view so they open separated, with sky between them and wholly visible.
 * Landscape and square: two high clouds either side of a low one. Portrait: a vertical zigzag. Counts shrink with the
 * view width (the authored counts are for a 17.8 wide desktop view).
 */
function m1Clouds(viewW: number, viewH: number): CloudSpec[] {
  const f = Math.min(1, Math.max(0.5, viewW / 17.8))
  const n = (base: number): number => Math.round(base * f)
  if (viewW / viewH < STACK_ASPECT) {
    const hx = 0.28 * viewW
    const hy = 0.1 * viewH
    return [
      fitCloud(-0.07 * viewW, 0.3 * viewH, hx, hy, n(28)),
      fitCloud(0.07 * viewW, 0, hx, hy, n(32)),
      fitCloud(-0.04 * viewW, -0.3 * viewH, hx, hy, n(26)),
    ]
  }
  const hy = 0.165 * viewH
  return [
    fitCloud(-0.27 * viewW, 0.26 * viewH, 0.15 * viewW, hy, n(28)),
    fitCloud(0, -0.26 * viewH, 0.17 * viewW, hy, n(32)),
    fitCloud(0.27 * viewW, 0.26 * viewH, 0.15 * viewW, hy, n(26)),
  ]
}

/** Named scenes sized to the visible world (viewH is 10 units; viewW = 10 * aspect). */
export function sceneSpec(name: SceneName, viewW: number, viewH: number): SceneSpec {
  switch (name) {
    case 'empty':
      return { clouds: [] }
    case 'm1':
      return { clouds: m1Clouds(viewW, viewH) }
  }
}
