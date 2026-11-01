import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BLOB, BLOB_STRIDE, CLOUD_THRESHOLD, MAX_BLOBS, createBlobBuffer } from './blobBuffer.ts'
import { createSim, type Sim, type Wind } from './index.ts'
import { sceneSpec, type SceneSpec } from './scene.ts'
import { labelComponents } from './topology.ts'

const W = 17.8
const H = 10
const sims: Sim[] = []

async function make(scene: SceneSpec | 'm1' | 'empty', params: Parameters<typeof createSim>[0] = {}): Promise<Sim> {
  const sim = await createSim(params)
  sim.loadScene(scene, W, H)
  sims.push(sim)
  return sim
}

afterEach(() => {
  while (sims.length) sims.pop()?.dispose()
})

beforeAll(async () => {
  // Warm the wasm module once so no test pays the load time.
  const s = await createSim()
  s.dispose()
})

const oneCloud: SceneSpec = { clouds: [{ x: 0, y: 0, blobs: 40 }] }

function run(sim: Sim, steps: number, ptr?: (i: number) => { x: number; y: number } | null): void {
  for (let i = 0; i < steps; i++) {
    const p = ptr?.(i)
    sim.setPointer(p ? { kind: 'present', x: p.x, y: p.y } : { kind: 'absent' })
    sim.step()
  }
}

function blobsOf(sim: Sim): Float32Array {
  const buf = createBlobBuffer()
  sim.writeBlobs(buf)
  return buf
}

/** Cloud ids present, derived from the render buffer (what the GPU sees). */
function cloudIds(buf: Float32Array, count: number): number[] {
  const ids = new Set<number>()
  for (let i = 0; i < count; i++) ids.add(buf[i * BLOB_STRIDE + BLOB.cloudId] ?? 0)
  return [...ids].sort((a, b) => a - b)
}

/** BlobPartition, SpringsInternal, CloudsConnected and record sanity. */
function checkInvariants(sim: Sim): void {
  const snap = sim.snapshot()
  const info = sim.inspect()
  const buf = blobsOf(sim)
  const ids = cloudIds(buf, snap.blobs)

  // BlobPartition: every blob in exactly one non-empty cloud; clouds cover all blobs.
  expect(info.blobCloud.length).toBe(snap.blobs)
  expect(ids.length).toBe(snap.clouds)
  const sizes = new Map<number, number>()
  for (const id of info.blobCloud) {
    expect(id).toBeGreaterThan(0)
    sizes.set(id, (sizes.get(id) ?? 0) + 1)
  }
  expect(sizes.size).toBe(snap.clouds)
  let total = 0
  for (const s of sizes.values()) {
    expect(s).toBeGreaterThan(0)
    total += s
  }
  expect(total).toBe(snap.blobs)
  for (let i = 0; i < snap.blobs; i++) {
    expect(buf[i * BLOB_STRIDE + BLOB.alive]).toBe(1)
    expect(buf[i * BLOB_STRIDE + BLOB.cloudId]).toBe(info.blobCloud[i])
  }
  for (let i = snap.blobs; i < MAX_BLOBS; i++) expect(buf[i * BLOB_STRIDE + BLOB.alive]).toBe(0)

  // SpringsInternal.
  for (const s of info.springs) expect(info.blobCloud[s.a]).toBe(info.blobCloud[s.b])
  expect(info.springs.length).toBe(snap.springs)

  // CloudsConnected after relabel: the spring graph's components are exactly the clouds.
  const root = labelComponents(snap.blobs, info.springs)
  const rootToCloud = new Map<number, number>()
  const cloudToRoot = new Map<number, number>()
  for (let i = 0; i < snap.blobs; i++) {
    const r = root[i] as number
    const c = info.blobCloud[i] as number
    expect(rootToCloud.get(r) ?? c).toBe(c)
    expect(cloudToRoot.get(c) ?? r).toBe(r)
    rootToCloud.set(r, c)
    cloudToRoot.set(c, r)
  }

  // Unarmed records only name live, distinct clouds.
  for (const r of info.unarmed) {
    expect(r.a).not.toBe(r.b)
    expect(sizes.has(r.a)).toBe(true)
    expect(sizes.has(r.b)).toBe(true)
  }
}

/** Smallest surface gap between two groups of blobs. */
function surfaceGap(buf: Float32Array, a: number[], b: number[]): number {
  let best = Infinity
  for (const i of a) {
    for (const j of b) {
      const d = Math.hypot(
        (buf[i * BLOB_STRIDE + BLOB.x] ?? 0) - (buf[j * BLOB_STRIDE + BLOB.x] ?? 0),
        (buf[i * BLOB_STRIDE + BLOB.y] ?? 0) - (buf[j * BLOB_STRIDE + BLOB.y] ?? 0),
      )
      best = Math.min(best, d - (buf[i * BLOB_STRIDE + BLOB.radius] ?? 0) - (buf[j * BLOB_STRIDE + BLOB.radius] ?? 0))
    }
  }
  return best
}

/** Cut a lone cloud down its vertical middle; returns blob indices of the left and right halves. */
async function splitInHalf(params: Parameters<typeof createSim>[0] = {}): Promise<{ sim: Sim; left: number[]; right: number[] }> {
  const sim = await make(oneCloud, params)
  const buf = blobsOf(sim)
  const n = sim.snapshot().blobs
  const xs = Array.from({ length: n }, (_, i) => buf[i * BLOB_STRIDE + BLOB.x] ?? 0)
  const mid = [...xs].sort((a, b) => a - b)[n >> 1] as number
  const left: number[] = []
  const right: number[] = []
  xs.forEach((x, i) => (x < mid ? left : right).push(i))
  const inLeft = new Set(left)
  sim.debugBreakSprings((a, b) => inLeft.has(a) !== inLeft.has(b))
  return { sim, left, right }
}

describe('scene and buffer', () => {
  it('the m1 scene has three clouds of 25 to 50 blobs and satisfies the invariants', async () => {
    const sim = await make('m1')
    const s = sim.snapshot()
    expect(s.clouds).toBe(3)
    expect(s.blobs).toBeGreaterThanOrEqual(75)
    expect(s.blobs).toBeLessThanOrEqual(150)
    const sizes = new Map<number, number>()
    for (const id of sim.inspect().blobCloud) sizes.set(id, (sizes.get(id) ?? 0) + 1)
    for (const n of sizes.values()) {
      expect(n).toBeGreaterThanOrEqual(25)
      expect(n).toBeLessThanOrEqual(50)
    }
    checkInvariants(sim)
  })

  it('writes the blob buffer contract: live records first, zeroed tail, finite values', async () => {
    const sim = await make('m1')
    const buf = createBlobBuffer()
    buf.fill(7)
    const n = sim.writeBlobs(buf)
    expect(n).toBe(sim.snapshot().blobs)
    for (let i = 0; i < n; i++) {
      const o = i * BLOB_STRIDE
      expect(buf[o + BLOB.radius]).toBeGreaterThanOrEqual(0.3)
      expect(buf[o + BLOB.radius]).toBeLessThanOrEqual(0.7)
      expect(buf[o + BLOB.mass]).toBeGreaterThan(0)
      expect(Math.abs(buf[o + BLOB.x] ?? 99)).toBeLessThan(W)
    }
    for (let i = n * BLOB_STRIDE; i < buf.length; i++) expect(buf[i]).toBe(0)
  })

  it('zero-cloud scene steps fine, and density is 0 everywhere', async () => {
    const sim = await make('empty')
    run(sim, 30, (i) => ({ x: Math.sin(i / 5) * 4, y: Math.cos(i / 7) * 3 }))
    const s = sim.snapshot()
    expect(s).toMatchObject({ clouds: 0, blobs: 0, springs: 0 })
    expect(s.cursor.present).toBe(true)
    expect(s.densityAtCursor).toBe(0)
    expect(sim.writeBlobs(createBlobBuffer())).toBe(0)
    fc.assert(
      fc.property(fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true }), (x, y) => {
        expect(sim.densityAt(x, y)).toBe(0)
      }),
      { numRuns: 50 },
    )
    sim.advance(1)
    checkInvariants(sim)
  })

  it('density is positive inside a cloud, zero far away, and equals the kernel sum', async () => {
    const sim = await make(oneCloud)
    expect(sim.densityAt(0, 0)).toBeGreaterThan(1)
    expect(sim.densityAt(50, 50)).toBe(0)
  })
})

describe('cursor', () => {
  it('pushes blobs when present and stops pushing when absent', async () => {
    const sim = await make(oneCloud)
    const before = blobsOf(sim).slice()
    // Absent pointer never disturbs a resting cloud.
    run(sim, 30)
    const rest = blobsOf(sim)
    for (let i = 0; i < 40 * BLOB_STRIDE; i++) expect(Math.abs((rest[i] ?? 0) - (before[i] ?? 0))).toBeLessThan(1e-4)

    // Present: the cursor ploughs into the cloud and moves it.
    let peak = 0
    for (let i = 0; i < 40; i++) {
      sim.setPointer({ kind: 'present', x: -4 + i * 0.1, y: 0 })
      sim.step()
      peak = Math.max(peak, sim.inspect().energy.total)
    }
    const pushed = blobsOf(sim)
    let moved = 0
    for (let i = 0; i < 40; i++) moved += Math.abs((pushed[i * BLOB_STRIDE + BLOB.x] ?? 0) - (before[i * BLOB_STRIDE + BLOB.x] ?? 0))
    expect(moved).toBeGreaterThan(1)
    expect(sim.snapshot().cursor.present).toBe(true)

    // Absent while parked inside the cloud: the body is disabled, so the cloud settles instead of being held apart.
    sim.setPointer({ kind: 'absent' })
    for (let i = 0; i < 240; i++) sim.step()
    const s = sim.snapshot()
    expect(s.cursor).toMatchObject({ present: false, vx: 0, vy: 0 })
    expect(s.densityAtCursor).toBe(0)
    expect(sim.inspect().energy.total).toBeLessThan(0.02 * peak)
  })

  it('cursor trajectory is identical for any wind function (clouds out of reach)', async () => {
    const far: SceneSpec = { clouds: [{ x: 0, y: 3.2, blobs: 30 }] }
    const trace = async (wind: Wind | null): Promise<number[]> => {
      const sim = await make(far, { wind })
      const out: number[] = []
      for (let i = 0; i < 100; i++) {
        sim.setPointer({ kind: 'present', x: -6 + i * 0.12, y: -4.2 + Math.sin(i / 9) })
        sim.step()
        const c = sim.snapshot().cursor
        out.push(c.x, c.y, c.vx, c.vy)
      }
      expect(sim.snapshot().densityAtCursor).toBe(0)
      return out
    }
    const reference = await trace(null)
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -0.4, max: 0.4, noNaN: true }),
        fc.double({ min: -0.4, max: 0.4, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        async (ax, ay, freq) => {
          const t = await trace((x, y, time) => ({ x: ax * Math.sin(freq * time + y), y: ay * Math.cos(freq * time + x) }))
          expect(t).toEqual(reference)
        },
      ),
      { numRuns: 6 },
    )
  })

  it('wind moves blobs but not the cursor itself', async () => {
    const sim = await make(oneCloud, { wind: () => ({ x: 3, y: 0 }) })
    const before = blobsOf(sim).slice()
    run(sim, 60, () => null)
    const after = blobsOf(sim)
    expect((after[BLOB.x] ?? 0) - (before[BLOB.x] ?? 0)).toBeGreaterThan(0.2)
    expect(sim.snapshot().cursor).toMatchObject({ vx: 0, vy: 0 })
  })

  it('is slowed by cloud density: the cursor inside a cloud lags a free one', async () => {
    const dense = await make(oneCloud)
    const free = await make('empty')
    // 30 units/s through the middle of the cloud; density drag is the only lag the free cursor lacks.
    const maxLag = (sim: Sim): number => {
      let worst = 0
      for (let i = 0; i < 45; i++) {
        const x = -6 + i * 0.5
        sim.setPointer({ kind: 'present', x, y: 0.1 })
        sim.step()
        worst = Math.max(worst, x - sim.snapshot().cursor.x)
      }
      return worst
    }
    const lagFree = maxLag(free)
    const lagDense = maxLag(dense)
    expect(lagFree).toBeLessThan(0.15)
    expect(lagDense).toBeGreaterThan(lagFree + 0.15)
  })
})

describe('springs, split and merge', () => {
  it('a slow edge brush dents the cloud without splitting it, and it springs back', async () => {
    const sim = await make(oneCloud)
    let peak = 0
    let maxClouds = 1
    for (let i = 0; i < 420; i++) {
      sim.setPointer({ kind: 'present', x: -7 + i * 0.033, y: 2.3 })
      sim.step()
      peak = Math.max(peak, sim.inspect().energy.total)
      maxClouds = Math.max(maxClouds, sim.snapshot().clouds)
    }
    expect(maxClouds).toBe(1)
    expect(peak).toBeGreaterThan(0)
    sim.setPointer({ kind: 'absent' })
    for (let i = 0; i < 300; i++) sim.step()
    expect(sim.snapshot().clouds).toBe(1)
    expect(sim.inspect().energy.total).toBeLessThan(0.02 * peak)
    checkInvariants(sim)
  })

  it('a fast drag through the middle splits the cloud; blob count and mass are conserved; new pieces are unarmed', async () => {
    const sim = await make(oneCloud)
    const massBefore = sim.inspect().mass.reduce((a, b) => a + b, 0)
    let firstSplit = -1
    for (let i = 0; i < 90; i++) {
      sim.setPointer({ kind: 'present', x: -7 + i * 0.35, y: 0.1 })
      sim.step()
      if (firstSplit < 0 && sim.snapshot().clouds > 1) {
        firstSplit = i
        // At the moment of the split every pair of pieces is unarmed.
        const info = sim.inspect()
        const ids = [...new Set(info.blobCloud)]
        for (let a = 0; a < ids.length; a++) {
          for (let b = a + 1; b < ids.length; b++) {
            expect(info.unarmed.some((r) => r.a === Math.min(ids[a] as number, ids[b] as number) && r.b === Math.max(ids[a] as number, ids[b] as number))).toBe(true)
          }
        }
        for (const r of info.unarmed) expect(r.splitStep).toBeLessThanOrEqual(info.step)
      }
      if (i % 10 === 0) checkInvariants(sim)
    }
    expect(firstSplit).toBeGreaterThanOrEqual(0)
    expect(sim.snapshot().clouds).toBeGreaterThan(1)
    expect(sim.snapshot().blobs).toBe(40)
    const massAfter = sim.inspect().mass.reduce((a, b) => a + b, 0)
    expect(massAfter).toBe(massBefore)
    checkInvariants(sim)
  })

  it('NoThrash: unarmed pieces do not re-merge while touching; once armed they merge on the next step', async () => {
    const { sim, left, right } = await splitInHalf({ params: { tau: 20 } })
    expect(sim.snapshot().clouds).toBe(2)
    expect(sim.inspect().unarmed).toHaveLength(1)
    const dTouch = sim.getParams().d_touch
    for (let i = 0; i < 120; i++) {
      sim.step()
      expect(sim.snapshot().clouds).toBe(2)
    }
    // The pieces really are touching, so only the gate held them apart.
    expect(surfaceGap(blobsOf(sim), left, right)).toBeLessThanOrEqual(dTouch)
    expect(sim.inspect().unarmed).toHaveLength(1)
    checkInvariants(sim)

    // Arm by cooldown: tau drops below the elapsed time. The very next step merges.
    sim.setParams({ tau: 0.1 })
    const springsBefore = sim.snapshot().springs
    sim.step()
    expect(sim.snapshot().clouds).toBe(1)
    expect(sim.inspect().unarmed).toHaveLength(0)
    expect(sim.snapshot().springs).toBeGreaterThan(springsBefore)
    expect(sim.snapshot().blobs).toBe(40)
    checkInvariants(sim)
  })

  it('pieces arm by distance, then merge when brought back to touching', async () => {
    const { sim, left, right } = await splitInHalf({ params: { tau: 20 } })
    const p = sim.getParams()
    let dir = 1
    sim.setWind((x) => ({ x: dir * (x < 0 ? -60 : 60), y: 0 }))
    for (let i = 0; i < 60 && sim.inspect().unarmed.length > 0; i++) sim.step()
    // Armed by gap, not by time.
    expect(sim.inspect().unarmed).toHaveLength(0)
    expect(sim.inspect().step).toBeLessThan(p.tau / (1 / 60))
    expect(sim.snapshot().clouds).toBe(2)
    expect(surfaceGap(blobsOf(sim), left, right)).toBeGreaterThan(p.d_release)

    dir = -1
    let merged = -1
    for (let i = 0; i < 300; i++) {
      sim.step()
      if (sim.snapshot().clouds === 1) {
        merged = i
        break
      }
    }
    expect(merged).toBeGreaterThanOrEqual(0)
    expect(sim.snapshot().blobs).toBe(40)
    checkInvariants(sim)
  })

  it('total energy (kinetic + spring + shape) does not increase with damping > 0 and no input', async () => {
    const sim = await make(oneCloud)
    run(sim, 30, (i) => ({ x: -3 + i * 0.1, y: 0 }))
    sim.setPointer({ kind: 'absent' })
    sim.step()
    let prev = sim.inspect().energy.total
    const e0 = prev
    let maxRise = 0
    for (let i = 0; i < 300; i++) {
      sim.step()
      const e = sim.inspect().energy.total
      maxRise = Math.max(maxRise, e - prev)
      prev = e
    }
    // Measured: rises are at the 1e-6 relative level (solver rounding); allow 1e-4.
    expect(maxRise).toBeLessThanOrEqual(1e-4 * e0)
    expect(prev).toBeLessThan(0.1 * e0)
  })

  it('same final state for 60 Hz and 120 Hz frame callbacks', async () => {
    const pointer = (frame: number) => ({ x: -6 + frame * 0.12, y: 0.2 + Math.sin(frame / 8) })
    const frames60 = 90
    const a = await make('m1')
    for (let f = 0; f < frames60; f++) {
      const p = pointer(f)
      a.setPointer({ kind: 'present', x: p.x, y: p.y })
      a.advance(1 / 60)
    }
    const b = await make('m1')
    for (let f = 0; f < frames60 * 2; f++) {
      if (f % 2 === 0) {
        const p = pointer(f / 2)
        b.setPointer({ kind: 'present', x: p.x, y: p.y })
      }
      b.advance(1 / 120)
    }
    expect(b.snapshot()).toEqual(a.snapshot())
    expect(Array.from(blobsOf(b))).toEqual(Array.from(blobsOf(a)))
    expect(a.snapshot().step).toBe(frames60)
  })

  it('invariants hold under random pointer paths in the m1 scene', () =>
    fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.double({ min: -8, max: 8, noNaN: true }), fc.double({ min: -4.5, max: 4.5, noNaN: true })), { minLength: 2, maxLength: 5 }),
        fc.double({ min: 2, max: 150, noNaN: true }),
        async (way, speed) => {
          const sim = await make('m1')
          const mass = sim.inspect().mass.reduce((a, b) => a + b, 0)
          let seg = 0
          let x = way[0]?.[0] ?? 0
          let y = way[0]?.[1] ?? 0
          for (let i = 0; i < 240; i++) {
            const t = way[(seg + 1) % way.length] as [number, number]
            const dx = t[0] - x
            const dy = t[1] - y
            const d = Math.hypot(dx, dy)
            const stepLen = speed / 60
            if (d <= stepLen) {
              x = t[0]
              y = t[1]
              seg++
            } else {
              x += (dx / d) * stepLen
              y += (dy / d) * stepLen
            }
            sim.setPointer(i % 97 === 96 ? { kind: 'absent' } : { kind: 'present', x, y })
            sim.step()
            if (i % 24 === 0) checkInvariants(sim)
          }
          checkInvariants(sim)
          expect(sim.snapshot().blobs).toBe(sim.inspect().mass.length)
          expect(sim.inspect().mass.reduce((a, b) => a + b, 0)).toBe(mass)
          const buf = blobsOf(sim)
          for (let i = 0; i < sim.snapshot().blobs * BLOB_STRIDE; i++) expect(Number.isFinite(buf[i])).toBe(true)
        },
      ),
      { numRuns: 8 },
    ))
})

describe('perf', () => {
  it('median step() with ~150 blobs is under 2 ms', async () => {
    const sim = await make({
      clouds: [
        { x: -5, y: 0, blobs: 50 },
        { x: 0, y: 0, blobs: 50 },
        { x: 5, y: 0, blobs: 50 },
      ],
    })
    expect(sim.snapshot().blobs).toBe(150)
    for (let i = 0; i < 60; i++) {
      sim.setPointer({ kind: 'present', x: -8 + i * 0.05, y: 0 })
      sim.step()
    }
    const times: number[] = []
    for (let i = 0; i < 300; i++) {
      sim.setPointer({ kind: 'present', x: -5 + i * 0.03, y: Math.sin(i / 20) * 2 })
      const t0 = performance.now()
      sim.step()
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[150] as number
    console.info(`step() median ${median.toFixed(3)} ms, p95 ${(times[285] as number).toFixed(3)} ms, springs ${sim.snapshot().springs}`)
    expect(median).toBeLessThan(2)
  })
})

describe('m1 core density is independent of layout scale', () => {
  it.each([[16, 10], [17.8, 10], [390 / 84.4, 10], [4.62, 10]] as const)('view %f x %f: cores stay above the render threshold', async (w, h) => {
    const sim = await createSim()
    sims.push(sim)
    sim.loadScene('m1', w, h)
    const cores = sceneSpec('m1', w, h).clouds.map((c) => sim.densityAt(c.x, c.y))
    for (const rho of cores) {
      expect(rho).toBeGreaterThanOrEqual(CLOUD_THRESHOLD * 1.5)
      expect(rho).toBeLessThan(3)
    }
  })
})
