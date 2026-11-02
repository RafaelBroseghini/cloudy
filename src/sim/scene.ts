// Scene layouts: where blobs start and which pairs get springs. Pure and seeded, so scenes are reproducible.

import { MAX_BLOBS } from './blobBuffer.ts'
import type { CloudType } from './types.ts'

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
  /** Horizontal stretch of the outline, so clouds are wider than tall. Default 1.3 (cumulus), 5 (stratus); ignored by cumulonimbus. */
  readonly aspect?: number
  /** Every blob of the cloud gets this type. Default cumulus. */
  readonly type?: CloudType
  /** Springs join blobs closer than `linkReach * spacing`. Default 1.3 (nearest neighbours). Longer reaches add springs between farther blobs and make a cloud much harder to tear. */
  readonly linkReach?: number
  /** Blob radius = scale * (base + jitter * rnd). Default per type: cumulus [0.42, 0.16], stratus [0.33, 0.12], cumulonimbus [0.44, 0.16]. */
  readonly radius?: readonly [base: number, jitter: number]
  /** Outline of the lattice points kept: an `ellipse` (stretched by `aspect`) or a `tower` (a tall column under a wider anvil). Default per type. */
  readonly outline?: Outline
}

export type Outline = 'ellipse' | 'tower'

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
  readonly type: CloudType
}

export interface SceneLayout {
  readonly blobs: BlobInit[]
  readonly springs: Array<readonly [number, number]>
}

export type SceneName = 'm1' | 'empty' | 'clear' | 'rain' | 'thunder' | 'mixed'

/** Small deterministic PRNG (mulberry32); the sim must not touch Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Per-type generator constants. Cumulus is the original (its `rnd()` calls must stay exactly as they were, so m1 is stable). */
const SHAPE = {
  cumulus: { aspect: 1.3, spacing: 0.75, radius: [0.42, 0.16], reach: 1.3, outline: 'ellipse' },
  // Wide flat sheets of smaller blobs. Neighbour springs only: longer ones (reach 1.8+) hold a sheet together so well that a
  // sweep can no longer tear it, which is the stratus's character.
  stratus: { aspect: 5, spacing: 0.6, radius: [0.33, 0.12], reach: 1.3, outline: 'ellipse' },
  cumulonimbus: { aspect: 1, spacing: 0.7, radius: [0.44, 0.16], reach: 1.3, outline: 'tower' },
} as const satisfies Record<CloudType, { aspect: number; spacing: number; radius: readonly [number, number]; reach: number; outline: Outline }>

/**
 * Lattice-point distance from the cloud's centre, in units of the lattice spacing: the `want` smallest are kept.
 * Cumulus and stratus are ellipses (stretched by `aspect`). Cumulonimbus is a union of two ellipses, a tall narrow column
 * and a wider flat anvil sitting on its top, so the cloud is taller than wide and flares at the top.
 */
function outlineDistance(outline: Outline, u: number, v: number, aspect: number): number {
  if (outline === 'ellipse') return (u / aspect) ** 2 + v ** 2
  const column = (u / 1) ** 2 + (v / 4.2) ** 2
  const anvil = (u / 2.1) ** 2 + ((v - 3.7) / 0.6) ** 2
  return Math.min(column, anvil)
}

export function buildLayout(spec: SceneSpec): SceneLayout {
  const rnd = mulberry32(spec.seed ?? 1)
  const blobs: BlobInit[] = []
  const springs: Array<readonly [number, number]> = []
  spec.clouds.forEach((c, ci) => {
    const type = c.type ?? 'cumulus'
    const shape = SHAPE[type]
    const k = c.scale ?? 1
    const s = (c.spacing ?? shape.spacing) * k
    const aspect = c.aspect ?? shape.aspect
    const shapeOutline = c.outline ?? shape.outline
    const want = Math.max(0, Math.min(c.blobs, MAX_BLOBS - blobs.length))
    // Jittered hex lattice; keep the `want` points nearest the centre in the stretched metric.
    const pts: Array<{ x: number; y: number; d: number }> = []
    const reach = Math.ceil(Math.sqrt(want)) + 3
    for (let r = -reach; r <= reach; r++) {
      for (let q = -reach; q <= reach; q++) {
        const x = (q + r * 0.5) * s + (rnd() - 0.5) * 0.12 * s
        const y = r * 0.866 * s + (rnd() - 0.5) * 0.12 * s
        pts.push({ x, y, d: shapeOutline === 'ellipse' ? (x / aspect) ** 2 + y ** 2 : outlineDistance(shapeOutline, x / s, y / s, aspect) })
      }
    }
    pts.sort((p, q) => p.d - q.d)
    const first = blobs.length
    const chosen = pts.slice(0, want).map((p) => ({ x: p.x, y: p.y, radius: k * ((c.radius ?? shape.radius)[0] + (c.radius ?? shape.radius)[1] * rnd()) }))
    // A tower is not symmetric about the lattice origin (the anvil), so centre its outline on (c.x, c.y).
    let cx = 0
    let cy = 0
    if (shapeOutline === 'tower' && chosen.length > 0) {
      cx = (Math.min(...chosen.map((p) => p.x - p.radius)) + Math.max(...chosen.map((p) => p.x + p.radius))) / 2
      cy = (Math.min(...chosen.map((p) => p.y - p.radius)) + Math.max(...chosen.map((p) => p.y + p.radius))) / 2
    }
    for (const p of chosen) blobs.push({ x: c.x + p.x - cx, y: c.y + p.y - cy, radius: p.radius, cloud: ci, type })
    for (let i = first; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = blobs[i]
        const b = blobs[j]
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < (c.linkReach ?? shape.reach) * s) springs.push([i, j])
      }
    }
  })
  return { blobs, springs }
}

/** Half-width and half-height of a cloud's outline (blob radii included) at scale 1. */
function unitExtent(blobs: number, aspect: number, type: CloudType): { hw: number; hh: number } {
  const { blobs: b } = buildLayout({ clouds: [{ x: 0, y: 0, blobs, aspect, type }] })
  let hw = 0
  let hh = 0
  for (const p of b) {
    hw = Math.max(hw, Math.abs(p.x) + p.radius)
    hh = Math.max(hh, Math.abs(p.y) + p.radius)
  }
  return { hw, hh }
}

/** A cloud sized to sit inside the box centred at (cx, cy) with half-size (hx, hy): wide boxes get wider outlines. */
function fitCloud(cx: number, cy: number, hx: number, hy: number, blobs: number, type: CloudType = 'cumulus'): CloudSpec {
  // Cumulus follows the box's shape (1.2 to 2); a stratus sheet is always wide (2.5 to 6); a cumulonimbus has its own outline.
  const aspect = type === 'stratus' ? Math.min(6, Math.max(2.5, hx / hy)) : Math.min(2, Math.max(1.2, hx / hy))
  const u = unitExtent(blobs, aspect, type)
  // Cap at the authored size so a roomy view does not blow clouds up.
  const scale = Math.min(1, hx / u.hw, hy / u.hh)
  return type === 'cumulus' ? { x: cx, y: cy, blobs, scale, aspect } : { x: cx, y: cy, blobs, scale, aspect, type }
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

/**
 * A cloud slot as fractions of the view: centre (x, y; y up, 0 at the middle), half-size, type and authored blob count
 * (for a 17.8 wide view; counts shrink with the view width like m1's).
 */
type Slot = readonly [type: CloudType, x: number, y: number, hx: number, hy: number, blobs: number]

interface Composition {
  /** Landscape and square views (width / height at least STACK_ASPECT). */
  readonly wide: readonly Slot[]
  /** Portrait views: clouds stack vertically. */
  readonly tall: readonly Slot[]
}

const COMPOSITIONS = {
  // Fair weather: three puffy cumulus (m1's triangle, a little smaller) and one thin stratus low in a corner.
  clear: {
    wide: [
      ['cumulus', -0.27, 0.26, 0.145, 0.16, 28],
      ['cumulus', 0, -0.26, 0.165, 0.16, 32],
      ['cumulus', 0.27, 0.26, 0.145, 0.16, 26],
      ['stratus', -0.355, -0.37, 0.125, 0.045, 24],
    ],
    tall: [
      ['cumulus', -0.06, 0.38, 0.27, 0.08, 28],
      ['stratus', 0.04, 0.18, 0.32, 0.03, 22],
      ['cumulus', 0.06, -0.03, 0.27, 0.09, 32],
      ['cumulus', -0.04, -0.3, 0.27, 0.09, 26],
    ],
  },
  // Rain: layered sheets with a couple of cumulus between them.
  rain: {
    wide: [
      ['stratus', -0.17, 0.37, 0.26, 0.05, 36],
      ['stratus', 0.22, 0.17, 0.25, 0.05, 36],
      ['cumulus', -0.3, -0.04, 0.12, 0.12, 22],
      ['stratus', 0.16, -0.12, 0.28, 0.05, 36],
      ['cumulus', -0.14, -0.38, 0.1, 0.07, 14],
    ],
    tall: [
      ['stratus', 0, 0.425, 0.4, 0.035, 26],
      ['cumulus', -0.02, 0.21, 0.3, 0.08, 22],
      ['stratus', 0, -0.005, 0.4, 0.035, 26],
      ['cumulus', 0.02, -0.215, 0.3, 0.075, 18],
      ['stratus', 0, -0.425, 0.4, 0.035, 22],
    ],
  },
  // Thunder: one or two storm towers with sheets low between and beside them.
  thunder: {
    wide: [
      ['cumulonimbus', -0.2, 0.0, 0.13, 0.4, 40],
      ['cumulonimbus', 0.3, -0.04, 0.11, 0.34, 34],
      ['stratus', 0.08, -0.4, 0.1, 0.045, 20],
      ['stratus', -0.38, 0.38, 0.09, 0.04, 20],
    ],
    tall: [
      ['stratus', 0, 0.45, 0.4, 0.03, 20],
      ['cumulonimbus', 0, 0.065, 0.3, 0.265, 36],
      ['stratus', 0, -0.34, 0.4, 0.04, 22],
    ],
  },
  // A bit of everything.
  mixed: {
    wide: [
      ['cumulus', -0.3, 0.27, 0.13, 0.15, 26],
      ['cumulonimbus', 0.12, 0.0, 0.1, 0.38, 36],
      ['stratus', -0.12, -0.3, 0.17, 0.05, 28],
      ['cumulus', 0.38, 0.28, 0.07, 0.1, 14],
      ['stratus', 0.34, -0.38, 0.1, 0.045, 20],
    ],
    tall: [
      ['cumulus', -0.04, 0.38, 0.28, 0.08, 22],
      ['cumulonimbus', 0.04, 0.0, 0.26, 0.22, 32],
      ['stratus', 0, -0.345, 0.4, 0.035, 22],
    ],
  },
} as const satisfies Record<'clear' | 'rain' | 'thunder' | 'mixed', Composition>

/** The same width-based count shrink as m1. */
function compose(c: Composition, viewW: number, viewH: number): CloudSpec[] {
  const f = Math.min(1, Math.max(0.5, viewW / 17.8))
  const slots = viewW / viewH < STACK_ASPECT ? c.tall : c.wide
  return slots.map(([type, x, y, hx, hy, blobs]) => fitCloud(x * viewW, y * viewH, hx * viewW, hy * viewH, Math.max(8, Math.round(blobs * f)), type))
}

/** Named scenes sized to the visible world (viewH is 10 units; viewW = 10 * aspect). */
export function sceneSpec(name: SceneName, viewW: number, viewH: number): SceneSpec {
  switch (name) {
    case 'empty':
      return { clouds: [] }
    case 'm1':
      return { clouds: m1Clouds(viewW, viewH) }
    case 'clear':
    case 'rain':
    case 'thunder':
    case 'mixed':
      return { clouds: compose(COMPOSITIONS[name], viewW, viewH) }
  }
}
