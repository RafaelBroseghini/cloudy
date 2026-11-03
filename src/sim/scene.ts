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
  /** Outline of the lattice points kept: an `ellipse` (stretched by `aspect`), a `tower` (a lumpy column on a broad base under a wider, sheared anvil) or a `sheet` (a thin sheet with uneven, frayed ends). Default per type. */
  readonly outline?: Outline
}

export type Outline = 'ellipse' | 'tower' | 'sheet'

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

export type SceneName = 'm1' | 'empty' | 'clear' | 'rain' | 'thunder' | 'mixed' | 'lone'

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
  stratus: { aspect: 5, spacing: 0.6, radius: [0.33, 0.12], reach: 1.3, outline: 'sheet' },
  cumulonimbus: { aspect: 1, spacing: 0.7, radius: [0.44, 0.16], reach: 1.3, outline: 'tower' },
} as const satisfies Record<CloudType, { aspect: number; spacing: number; radius: readonly [number, number]; reach: number; outline: Outline }>

/** A tower's rim blobs are this much smaller than its core ones (at the very rim), so its outline shows the lobes. */
const RIM_SHRINK = 0.4
/** A stratus sheet's end blobs are this much smaller at the very tip, so it tapers (kept small: the sheet must stay long). */
const TIP_SHRINK = 0.28

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Lattice-point distance from the cloud's centre, in units of the lattice spacing: the `want` smallest are kept (an ellipse, stretched by `aspect`). */
const ellipseDistance = (u: number, v: number, aspect: number): number => (u / aspect) ** 2 + v ** 2

/** One lobe of a storm tower, in lattice units at the reference size (a tower of `TOWER_REF_H` rows): an ellipse of half-axes rx, ry. */
interface Lobe {
  readonly x: number
  readonly y: number
  readonly rx: number
  readonly ry: number
}

/** Height (lattice units) of the reference tower the lobe table below is written for; other towers scale from it. */
const TOWER_REF_H = 13

/**
 * The lobes of a cumulonimbus: a broad flat base slab, a leaning column of puffs that bulge to alternating sides, a cluster of
 * domed billows on top, and a wide, thin, downwind-sheared anvil with a billowy rim. Union of ellipses, so the outline has
 * real lumps (about half a unit across) that the density kernel keeps, instead of the faint ripples a lattice cut leaves.
 */
function towerLobes(rnd: () => number): Lobe[] {
  const H = TOWER_REF_H
  // A broad, flat foot.
  const lobes: Lobe[] = [{ x: 0.1, y: 0.07 * H, rx: 3.0, ry: 0.085 * H }]
  // Column: puffs that swell with height (cauliflower), each pushed to alternating sides so the flanks scallop.
  const puffs = 7
  for (let i = 0; i < puffs; i++) {
    const t = 0.13 + (0.5 * i) / (puffs - 1)
    const side = i % 2 === 0 ? -1 : 1
    const r = 1.3 + 1.15 * t ** 1.2 + 0.35 * rnd()
    const lean = 0.45 * t * 2 + 0.5 * smooth(0.55, 1, t)
    lobes.push({ x: lean + side * (0.5 + 0.55 * rnd()), y: t * H, rx: r, ry: r * (0.9 + 0.2 * rnd()) })
  }
  // Dome: several big billows of different sizes crowd the top of the column, the middle ones highest.
  const dome = 5
  for (let i = 0; i < dome; i++) {
    const f = i / (dome - 1)
    const x = -1.9 + 4.6 * f + (rnd() - 0.5) * 0.5
    const up = 1 - Math.abs(f - 0.5) * 1.5
    lobes.push({ x, y: (0.8 + 0.12 * up) * H, rx: 1.15 + 0.55 * rnd(), ry: 1.1 + 0.5 * rnd() })
  }
  // Anvil: a wide thin slab sheared to the right, with a ragged, billowy upper rim.
  lobes.push({ x: 1.3, y: 0.76 * H, rx: 4.3, ry: 0.065 * H })
  lobes.push({ x: 3.7, y: 0.75 * H, rx: 2.6, ry: 0.045 * H })
  for (let i = 0; i < 7; i++) lobes.push({ x: -2.3 + i * 1.2 + (rnd() - 0.5) * 0.4, y: (0.795 + 0.03 * rnd()) * H, rx: 0.85 + 0.35 * rnd(), ry: 0.6 + 0.3 * rnd() })
  return lobes
}

/**
 * Points of a storm tower in lattice units (spacing 1), `d` = 0 deep inside .. 1 at the rim of the lobe union. The lobes are scaled
 * (about the base) until the lattice holds `want` points, then the deepest ones are kept, so fewer blobs narrow the whole tower
 * evenly and the anvil survives. A flat base: nothing below y = 0.
 */
function towerPoints(want: number, hv: number, rnd: () => number): Array<{ x: number; y: number; d: number; rim: number }> {
  const lobes = towerLobes(rnd)
  const unit = hv / TOWER_REF_H
  const reach = Math.ceil(Math.sqrt(want) * 1.2) + 8
  const jitter: Array<readonly [number, number]> = []
  for (let r = -reach; r <= reach * 2; r++) for (let q = -reach; q <= reach; q++) jitter.push([(rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12])
  const make = (g: number): Array<{ x: number; y: number; d: number; rim: number }> => {
    const out: Array<{ x: number; y: number; d: number; rim: number }> = []
    let k = 0
    for (let r = -reach; r <= reach * 2; r++) {
      for (let q = -reach; q <= reach; q++) {
        const [jx, jy] = jitter[k++] as readonly [number, number]
        const x = q + r * 0.5 + jx
        const y = r * 0.866 + jy
        if (y < 0) continue
        let d = Infinity
        let near = lobes[0] as Lobe
        for (const l of lobes) {
          const dl = Math.hypot((x - l.x * unit * g) / (l.rx * unit * g), (y - l.y * unit * g) / (l.ry * unit * g))
          if (dl < d) {
            d = dl
            near = l
          }
        }
        if (d >= 1) continue
        // Near the rim a point is pushed out to hug its lobe's outline and made small (the caller shrinks it), so the contour
        // follows the lobes' bumps instead of the lattice's smooth, large-blob blur.
        const rim = smooth(0.72, 0.92, d) * smooth(0.04 * hv, 0.14 * hv, y)
        const cx = near.x * unit * g
        const cy = near.y * unit * g
        const pull = 1 + rim * (0.93 / Math.max(d, 0.05) - 1)
        out.push({ x: cx + (x - cx) * pull, y: Math.max(0, cy + (y - cy) * pull), d, rim })
      }
    }
    return out
  }
  let g = 0.5
  let pts = make(g)
  while (pts.length < want && g < 3) {
    g += 0.02
    pts = make(g)
  }
  return pts
}

/**
 * Points of a stratus sheet, in world units, nearest-the-middle first in `d`. Unlike a lattice cut by an outline (which
 * can only be a few rows thick, so it comes out a rolling pin: thick middle, one-row tails), the thickness follows a
 * smooth lens along the length, with columns every 0.85 spacings and stacked 0.8 apart, so the sheet thins evenly to
 * its tips. Columns differ a little in thickness; when the sheet holds more points than wanted, the top and bottom ones drop first, so the length stays and the sheet just gets thinner.
 */
function sheetPoints(want: number, s: number, aspect: number, rnd: () => number): Array<{ x: number; y: number; d: number; rim: number }> {
  const dx = 0.85 * s
  const dy = 0.8 * s
  const lens = (t: number): number => Math.max(0, 1 - Math.abs(t) ** 2.2) ** 0.75
  const make = (half: number): Array<{ x: number; y: number; d: number; rim: number }> => {
    const len = 1.3 * aspect * half * dy
    const out: Array<{ x: number; y: number; d: number; rim: number }> = []
    for (let i = -Math.floor(len / dx); i <= Math.floor(len / dx); i++) {
      const x = i * dx
      const h = half * lens(x / len) * (1 + 0.18 * Math.sin(i * 1.9 + 0.7) + 0.08 * Math.sin(i * 4.3))
      const count = Math.max(1, Math.round(2 * h + 1 - 1e-9))
      for (let j = 0; j < count; j++) {
        const y = (j - (count - 1) / 2) * dy + ((i & 1) * 0.5 - 0.25) * dy * 0.5
        // The tips taper: smaller blobs toward the ends (the caller shrinks them), so the sheet ends in a thin point, not a rounded pill.
        const tip = smooth(0.5, 1, Math.abs(x / len))
        out.push({ x: x + (rnd() - 0.5) * 0.1 * s, y: y + (rnd() - 0.5) * 0.1 * s, d: 0.3 * (x / len) ** 2 + (y / (half * dy + 1e-6)) ** 2, rim: tip * (TIP_SHRINK / RIM_SHRINK) })
      }
    }
    return out
  }
  // Smallest half-thickness (in rows) whose sheet holds at least `want` points; the extra outermost points are dropped by the caller.
  let half = 0.5
  let pts = make(half)
  while (pts.length < want && half < 12) {
    half += 0.05
    pts = make(half)
  }
  return pts
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
    // A tower's height grows with its blob count (lattice units), so a small one keeps its proportions.
    const hv = 1.6 * Math.sqrt(want)
    // Jittered hex lattice; keep the `want` points nearest the centre in the stretched metric. A sheet makes its own points.
    let pts: Array<{ x: number; y: number; d: number; rim?: number }> = []
    if (shapeOutline === 'sheet') {
      pts = sheetPoints(want, s, aspect, rnd)
    } else {
      if (shapeOutline === 'tower') {
        pts = towerPoints(want, hv, rnd).map((p) => ({ x: p.x * s, y: p.y * s, d: p.d, rim: p.rim }))
      } else {
        const reach = Math.ceil(Math.sqrt(want)) + 3
        for (let r = -reach; r <= reach; r++) {
          for (let q = -reach; q <= reach; q++) {
            const x = (q + r * 0.5) * s + (rnd() - 0.5) * 0.12 * s
            const y = r * 0.866 * s + (rnd() - 0.5) * 0.12 * s
            pts.push({ x, y, d: ellipseDistance(x / s, y / s, aspect) })
          }
        }
      }
    }
    pts.sort((p, q) => p.d - q.d)
    const first = blobs.length
    const chosen = pts.slice(0, want).map((p) => ({ x: p.x, y: p.y, radius: k * ((c.radius ?? shape.radius)[0] + (c.radius ?? shape.radius)[1] * rnd()) * (1 - RIM_SHRINK * (p.rim ?? 0)) }))
    // A sheet undulates gently along its length and tilts a little, so it is not a straight bar.
    if (shapeOutline === 'sheet') for (const p of chosen) p.y += s * (0.18 * Math.sin(p.x / s * 0.45 + 1.1) + 0.04 * p.x / s)
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
      ['cumulonimbus', -0.18, 0.0, 0.15, 0.41, 80],
      ['cumulonimbus', 0.3, -0.04, 0.14, 0.35, 66],
      ['stratus', 0.08, -0.4, 0.1, 0.045, 20],
      ['stratus', -0.405, 0.425, 0.08, 0.04, 20],
    ],
    tall: [
      ['stratus', 0, 0.45, 0.4, 0.03, 20],
      ['cumulonimbus', 0, 0.065, 0.3, 0.265, 56],
      ['stratus', 0, -0.34, 0.4, 0.04, 22],
    ],
  },
  // One big cumulus in the middle of the sky (the "lone cloud" scene).
  lone: {
    wide: [['cumulus', 0, 0.02, 0.2, 0.22, 36]],
    tall: [['cumulus', 0, 0.04, 0.4, 0.15, 32]],
  },
  // A bit of everything.
  mixed: {
    wide: [
      ['cumulus', -0.3, 0.27, 0.13, 0.15, 26],
      ['cumulonimbus', 0.12, 0.0, 0.115, 0.38, 56],
      ['stratus', -0.12, -0.3, 0.17, 0.05, 28],
      ['cumulus', 0.38, 0.28, 0.07, 0.1, 14],
      ['stratus', 0.34, -0.38, 0.1, 0.045, 20],
    ],
    tall: [
      ['cumulus', -0.04, 0.38, 0.28, 0.08, 22],
      ['cumulonimbus', 0.04, 0.0, 0.26, 0.22, 50],
      ['stratus', 0, -0.345, 0.4, 0.035, 22],
    ],
  },
} as const satisfies Record<'clear' | 'rain' | 'thunder' | 'mixed' | 'lone', Composition>

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
    case 'lone':
      return { clouds: compose(COMPOSITIONS[name], viewW, viewH) }
  }
}
