import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BLOB, BLOB_STRIDE, createBlobBuffer } from './blobBuffer.ts'
import type { FlowParams } from './flow.ts'
import { createSim, type Sim } from './index.ts'
import type { SceneSpec } from './scene.ts'

const W = 17.8
const H = 10
const sims: Sim[] = []

async function make(scene: SceneSpec | 'm1' | 'empty', breeze: FlowParams | null = null): Promise<Sim> {
  const sim = await createSim({ breeze })
  sim.loadScene(scene, W, H)
  sims.push(sim)
  return sim
}

afterEach(() => {
  while (sims.length) sims.pop()?.dispose()
})
beforeAll(async () => {
  const s = await createSim()
  s.dispose()
})

const CLEAR: FlowParams = { speed: 0.18, angle: 0, turbulence: 0.06, scale: 7, rate: 0.06 }
const STILL: FlowParams = { ...CLEAR, turbulence: 0 }

function blobs(sim: Sim): { buf: Float32Array; n: number } {
  const buf = createBlobBuffer()
  return { buf, n: sim.writeBlobs(buf) }
}

interface CloudStat {
  id: number
  x: number
  y: number
  vx: number
  n: number
}
/** Per-cloud mean position and x velocity from the render buffer. */
function clouds(sim: Sim): CloudStat[] {
  const { buf, n } = blobs(sim)
  const by = new Map<number, CloudStat>()
  for (let i = 0; i < n; i++) {
    const o = i * BLOB_STRIDE
    const id = buf[o + BLOB.cloudId] ?? 0
    const c = by.get(id) ?? { id, x: 0, y: 0, vx: 0, n: 0 }
    c.x += buf[o + BLOB.x] ?? 0
    c.y += buf[o + BLOB.y] ?? 0
    c.vx += buf[o + BLOB.vx] ?? 0
    c.n++
    by.set(id, c)
  }
  return [...by.values()].map((c) => ({ ...c, x: c.x / c.n, y: c.y / c.n, vx: c.vx / c.n }))
}

const run = (sim: Sim, steps: number): void => {
  for (let i = 0; i < steps; i++) sim.step()
}

describe('breeze', () => {
  it('leaves the cursor alone: its trajectory is identical with and without a breeze (empty scene)', async () => {
    const trace = async (b: FlowParams | null): Promise<number[]> => {
      const sim = await make('empty', b)
      const out: number[] = []
      for (let i = 0; i < 120; i++) {
        sim.setPointer({ kind: 'present', x: -6 + i * 0.1, y: Math.sin(i / 9) })
        sim.step()
        const c = sim.snapshot().cursor
        out.push(c.x, c.y, c.vx, c.vy)
      }
      return out
    }
    expect(await trace({ ...CLEAR, speed: 1, turbulence: 0.5 })).toEqual(await trace(null))
  })

  it('with no breeze the sim is untouched (null equals zero amplitude)', async () => {
    const a = await make('m1', null)
    const b = await make('m1', null)
    b.setBreeze({ ...CLEAR, speed: 0, turbulence: 0 })
    run(a, 300)
    run(b, 300)
    expect(Array.from(blobs(b).buf)).toEqual(Array.from(blobs(a).buf))
  })

  it('a free cloud settles at the breeze speed whatever the blob damping', async () => {
    for (const damping of [1.5, 2.5, 3.5]) {
      const sim = await make({ clouds: [{ x: 0, y: 0, blobs: 30 }] }, { ...STILL, speed: 0.3 })
      sim.setParams({ blobDamping: damping })
      run(sim, 60 * 8)
      const c = clouds(sim)[0] as CloudStat
      expect(c.vx).toBeGreaterThan(0.3 * 0.97)
      expect(c.vx).toBeLessThan(0.3 * 1.03)
    }
  })

  it('a resting cloud drifts 0.1 to 0.4 units/s under the weather presets and keeps its shape and identity', async () => {
    const presets: Array<[string, FlowParams]> = [
      ['clear', CLEAR],
      ['rain', { speed: 0.23, angle: 0, turbulence: 0.1, scale: 6, rate: 0.09 }],
      ['thunder', { speed: 0.3, angle: 0, turbulence: 0.15, scale: 4.5, rate: 0.15 }],
    ]
    for (const [name, b] of presets) {
      const sim = await make({ clouds: [{ x: -4, y: 0, blobs: 30 }] }, b)
      const start = sim.inspect()
      const x0 = clouds(sim)[0]?.x ?? 0
      let path = 0
      let prev = x0
      let py = clouds(sim)[0]?.y ?? 0
      for (let s = 0; s < 20; s++) {
        run(sim, 60)
        const c = clouds(sim)[0] as CloudStat
        path += Math.hypot(c.x - prev, c.y - py)
        prev = c.x
        py = c.y
      }
      const speed = path / 20
      expect(speed, name).toBeGreaterThan(0.1)
      expect(speed, name).toBeLessThan(0.4)
      const end = sim.inspect()
      expect(sim.snapshot().clouds, name).toBe(1)
      expect(end.springs.length, name).toBe(start.springs.length)
      // Nothing creeps or tears: rest lengths unchanged.
      end.springs.forEach((s, i) => expect(s.L, name).toBeCloseTo(start.springs[i]?.L ?? 0, 6))
    }
  })

  it('a strong gale for a minute neither tears nor merges clouds', async () => {
    const sim = await make('m1', { speed: 0.4, angle: 0, turbulence: 0.5, scale: 4, rate: 0.3 })
    const springs = sim.snapshot().springs
    run(sim, 60 * 60)
    expect(sim.snapshot().clouds).toBe(3)
    expect(sim.snapshot().springs).toBe(springs)
  }, 30_000)
})

describe('wrap-around', () => {
  const off: SceneSpec = { clouds: [{ x: 14, y: 1, blobs: 24 }] }
  const wide = (sim: Sim) => {
    const { buf, n } = blobs(sim)
    return Array.from({ length: n }, (_, i) => ({
      x: buf[i * BLOB_STRIDE + BLOB.x] ?? 0,
      y: buf[i * BLOB_STRIDE + BLOB.y] ?? 0,
      vx: buf[i * BLOB_STRIDE + BLOB.vx] ?? 0,
      id: buf[i * BLOB_STRIDE + BLOB.cloudId] ?? 0,
    }))
  }

  it('moves a cloud that left downwind to the other side as a whole: count, springs, ids and shape kept', async () => {
    const sim = await make(off, { ...STILL, speed: 0.3 })
    const before = wide(sim)
    const info = sim.inspect()
    run(sim, 1)
    const after = wide(sim)
    expect(after).toHaveLength(before.length)
    expect(sim.snapshot()).toMatchObject({ clouds: 1, blobs: before.length, springs: info.springs.length })
    expect(sim.inspect().springs.map((s) => [s.a, s.b])).toEqual(info.springs.map((s) => [s.a, s.b]))
    const shift = (after[0]?.x ?? 0) - (before[0]?.x ?? 0)
    expect(shift).toBeLessThan(-W)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]?.id).toBe(before[i]?.id)
      expect((after[i]?.x ?? 0) - (before[i]?.x ?? 0)).toBeCloseTo(shift, 3)
      expect(after[i]?.y).toBeCloseTo(before[i]?.y ?? 0, 3)
    }
    // Fully off the left edge (visible reach included), so nothing pops on screen; it then drifts back in on its own.
    const { buf } = blobs(sim)
    const reach = Math.max(...after.map((b, i) => b.x + 1.6 * (buf[i * BLOB_STRIDE + BLOB.radius] ?? 0)))
    expect(reach).toBeLessThan(-W / 2)
    run(sim, 60 * 40)
    expect(Math.max(...wide(sim).map((b) => b.x))).toBeGreaterThan(-W / 2)
  })

  it('keeps blob velocities when it wraps (positions only)', async () => {
    const sim = await make({ clouds: [{ x: 8.9, y: 0, blobs: 24 }] }, { ...STILL, speed: 0.4 })
    let wrapped = false
    for (let i = 0; i < 60 * 30 && !wrapped; i++) {
      const before = wide(sim)
      sim.step()
      const after = wide(sim)
      if ((after[0]?.x ?? 0) < (before[0]?.x ?? 0) - W / 2) {
        wrapped = true
        for (let k = 0; k < before.length; k++) expect(Math.abs((after[k]?.vx ?? 0) - (before[k]?.vx ?? 0))).toBeLessThan(0.02)
        expect(before.reduce((a, b) => a + b.vx, 0) / before.length).toBeGreaterThan(0.2)
      }
    }
    expect(wrapped).toBe(true)
  })

  it('does not wrap without a breeze, upwind, or while a cloud is still partly in view', async () => {
    const plain = await make(off, null)
    const x0 = wide(plain)[0]?.x ?? 0
    run(plain, 5)
    expect(Math.abs((wide(plain)[0]?.x ?? 0) - x0)).toBeLessThan(1)

    const upwind = await make(off, { ...STILL, speed: 0.3, angle: Math.PI })
    run(upwind, 5)
    expect(wide(upwind)[0]?.x).toBeGreaterThan(9)

    const partly = await make({ clouds: [{ x: 9.5, y: 0, blobs: 24 }] }, { ...STILL, speed: 0.3 })
    run(partly, 5)
    expect(wide(partly)[0]?.x).toBeGreaterThan(5)
  })

  it('a drifting scene does not pile up at an edge over 5 simulated minutes', async () => {
    const sim = await make('m1', CLEAR)
    const total = sim.snapshot()
    const seen: number[] = []
    let wraps = 0
    const last = new Map(clouds(sim).map((c) => [c.id, c.x]))
    for (let s = 0; s < 300; s++) {
      run(sim, 60)
      for (const c of clouds(sim)) {
        seen.push(c.x)
        if (Math.abs(c.x - (last.get(c.id) ?? c.x)) > W / 2) wraps++
        last.set(c.id, c.x)
        expect(Math.abs(c.y)).toBeLessThan(H / 2)
      }
    }
    const end = sim.snapshot()
    expect(end).toMatchObject({ clouds: total.clouds, blobs: total.blobs, springs: total.springs })
    // Every cloud went round the loop more than once (0.18 u/s * 300 s = 54 units against a ~25 unit loop).
    expect(wraps).toBeGreaterThanOrEqual(2 * total.clouds)
    // No resting place at the downwind edge: little time spent in the last tenth of the view, and spread over the rest.
    const edge = seen.filter((x) => x > 0.8 * (W / 2)).length / seen.length
    expect(edge).toBeLessThan(0.25)
    const thirds = [0, 0, 0]
    for (const x of seen) thirds[x < -W / 6 ? 0 : x < W / 6 ? 1 : 2] = (thirds[x < -W / 6 ? 0 : x < W / 6 ? 1 : 2] ?? 0) + 1
    for (const t of thirds) expect(t / seen.length).toBeGreaterThan(0.1)
  }, 120_000)

  it('tornado (breeze plus its wind) wraps too: clouds do not pile up at the right edge', async () => {
    const sim = await createSim({ breeze: { speed: 0.28, angle: 0, turbulence: 0.14, scale: 5, rate: 0.12 }, wind: () => ({ x: 0.32, y: 0.04 }) })
    sims.push(sim)
    sim.setParams({ blobDamping: 2, k_s: 55, alpha: 0.04 })
    sim.loadScene('m1', W, H)
    let edge = 0
    let seen = 0
    for (let s = 0; s < 150; s++) {
      run(sim, 60)
      for (const c of clouds(sim)) {
        seen++
        if (c.x > 0.8 * (W / 2)) edge++
        expect(Math.abs(c.y)).toBeLessThan(H / 2)
      }
    }
    expect(edge / seen).toBeLessThan(0.25)
  }, 120_000)
})

describe('breeze and frame rate', () => {
  it('gives the same final state for 60 Hz and 120 Hz frame callbacks', async () => {
    const b: FlowParams = { speed: 0.3, angle: 0.1, turbulence: 0.2, scale: 5, rate: 0.12 }
    const a = await make('m1', b)
    const c = await make('m1', b)
    for (let f = 0; f < 240; f++) a.advance(1 / 60)
    for (let f = 0; f < 480; f++) c.advance(1 / 120)
    expect(c.snapshot()).toEqual(a.snapshot())
    expect(Array.from(blobs(c).buf)).toEqual(Array.from(blobs(a).buf))
    expect(c.flowState()).toEqual(a.flowState())
  })
})
