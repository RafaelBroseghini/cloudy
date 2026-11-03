import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MAX_BLOBS } from './blobBuffer.ts'
import { buildLayout, sceneSpec, type SceneName } from './scene.ts'

/** One cumulonimbus (or any type) at the origin with `n` blobs, at scale 1. */
function cloud(n: number, type: 'cumulonimbus' | 'stratus' = 'cumulonimbus', seed = 1) {
  return buildLayout({ clouds: [{ x: 0, y: 0, blobs: n, type, ...(type === 'stratus' ? { aspect: 5 } : {}) }], seed })
}

function connected(n: number, springs: ReadonlyArray<readonly [number, number]>): boolean {
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const [a, b] of springs) {
    adj[a]?.push(b)
    adj[b]?.push(a)
  }
  const seen = new Set<number>([0])
  const stack = [0]
  while (stack.length > 0) {
    const i = stack.pop() as number
    for (const j of adj[i] ?? []) {
      if (seen.has(j)) continue
      seen.add(j)
      stack.push(j)
    }
  }
  return seen.size === n
}

/** Width (blob radii included) of the blobs whose centres lie in the height band [f0, f1] of the cloud, 0 at the bottom. */
function bandWidth(blobs: ReturnType<typeof cloud>['blobs'], f0: number, f1: number): number {
  const lo = Math.min(...blobs.map((b) => b.y - b.radius))
  const hi = Math.max(...blobs.map((b) => b.y + b.radius))
  const inBand = blobs.filter((b) => (b.y - lo) / (hi - lo) >= f0 && (b.y - lo) / (hi - lo) <= f1)
  if (inBand.length === 0) return 0
  return Math.max(...inBand.map((b) => b.x + b.radius)) - Math.min(...inBand.map((b) => b.x - b.radius))
}

describe('storm tower generator', () => {
  it('makes exactly the requested number of blobs (within the cap), all one cumulonimbus cloud, connected by springs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 12, max: 120 }), fc.integer({ min: 1, max: 50 }), (n, seed) => {
        const l = cloud(n, 'cumulonimbus', seed)
        expect(l.blobs.length).toBe(n)
        expect(l.blobs.every((b) => b.type === 'cumulonimbus' && b.cloud === 0)).toBe(true)
        expect(connected(n, l.springs)).toBe(true)
      }),
      { numRuns: 40 },
    )
  })

  it('is deterministic for a seed', () => {
    expect(cloud(80, 'cumulonimbus', 7)).toEqual(cloud(80, 'cumulonimbus', 7))
  })

  it('is taller than wide, with a wide anvil on a narrower column, and a broad flat foot', () => {
    for (const n of [56, 80, 100]) {
      const { blobs } = cloud(n)
      const top = bandWidth(blobs, 0.72, 0.9)
      const column = bandWidth(blobs, 0.25, 0.5)
      const foot = bandWidth(blobs, 0, 0.1)
      expect(top, `${n}: anvil band vs column`).toBeGreaterThan(1.25 * column)
      expect(foot, `${n}: foot vs the widest band`).toBeGreaterThan(0.3 * top)
      const h = Math.max(...blobs.map((b) => b.y + b.radius)) - Math.min(...blobs.map((b) => b.y - b.radius))
      const w = Math.max(...blobs.map((b) => b.x + b.radius)) - Math.min(...blobs.map((b) => b.x - b.radius))
      expect(h).toBeGreaterThan(1.2 * w)
    }
  })

  it('has a flat bottom: no blob sits below the foot line, and the lowest ones lie on a common level', () => {
    const { blobs } = cloud(80)
    const ys = blobs.map((b) => b.y).sort((a, b) => a - b)
    const spread = (ys[Math.floor(ys.length * 0.12)] as number) - (ys[0] as number)
    expect(spread).toBeLessThan(1.5) // the lowest 12% of the blobs within about two blob radii of each other (a rounded foot would spread over the tower's whole girth)
  })

  it('uses small blobs on the rim and big ones inside, so the outline shows lumps', () => {
    const { blobs } = cloud(80)
    const r = blobs.map((b) => b.radius)
    expect(Math.min(...r)).toBeLessThan(0.36)
    expect(Math.max(...r)).toBeGreaterThan(0.5)
    // A good handful of them are small ones.
    expect(r.filter((x) => x < 0.4).length).toBeGreaterThanOrEqual(6)
  })
})

describe('stratus sheet tips', () => {
  it('taper: the blobs at the two ends are smaller than the ones in the middle, and the sheet stays connected', () => {
    const l = cloud(24, 'stratus')
    const xs = l.blobs.map((b) => b.x)
    const lo = Math.min(...xs)
    const hi = Math.max(...xs)
    const end = l.blobs.filter((b) => (b.x - lo) / (hi - lo) < 0.1 || (b.x - lo) / (hi - lo) > 0.9)
    const mid = l.blobs.filter((b) => Math.abs((b.x - lo) / (hi - lo) - 0.5) < 0.15)
    const mean = (a: typeof end): number => a.reduce((s, b) => s + b.radius, 0) / a.length
    expect(mean(end)).toBeLessThan(0.85 * mean(mid))
    expect(connected(l.blobs.length, l.springs)).toBe(true)
  })
})

describe('shipped scene budgets', () => {
  const NAMES: SceneName[] = ['m1', 'clear', 'rain', 'thunder', 'mixed', 'lone']
  it('every scene at every view keeps within the 254-blob cap, with headroom, and the storm scene stays the largest', () => {
    let largest = 0
    for (const name of NAMES) {
      for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [1920, 1080]] as const) {
        const spec = sceneSpec(name, (10 * w) / h, 10)
        const requested = spec.clouds.reduce((a, c) => a + c.blobs, 0)
        expect(requested, `${name} ${w}x${h}`).toBeLessThanOrEqual(MAX_BLOBS - 40)
        expect(buildLayout(spec).blobs.length).toBe(requested)
        largest = Math.max(largest, requested)
      }
    }
    expect(largest).toBeGreaterThanOrEqual(160)
    expect(largest).toBeLessThanOrEqual(210)
  })
})
