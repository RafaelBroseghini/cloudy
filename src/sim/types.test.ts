import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BLOB, BLOB_STRIDE, CLOUD_THRESHOLD, MAX_BLOBS, createBlobBuffer } from './blobBuffer.ts'
import { createSim, type Sim } from './index.ts'
import { buildLayout, sceneSpec, type CloudSpec, type SceneSpec } from './scene.ts'
import { CLOUD_TYPES, TYPE_INDEX, type CloudType } from './types.ts'

const sims: Sim[] = []
async function make(scene: SceneSpec | 'm1', w = 17.8, params: Parameters<typeof createSim>[0] = {}): Promise<Sim> {
  const sim = await createSim(params)
  sim.loadScene(scene, w, 10)
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

/** The same geometry for every type, so only the type's multipliers differ. */
function equal(type: CloudType, extra: Partial<CloudSpec> = {}): SceneSpec {
  return { clouds: [{ x: 0, y: 0, blobs: 40, aspect: 1.3, spacing: 0.75, radius: [0.42, 0.16], outline: 'ellipse', linkReach: 1.3, type, ...extra }] }
}

describe('drag by type', () => {
  it('the cursor drags harder in a cumulonimbus core than a cumulus, and least in a stratus, at equal geometry', async () => {
    const rho: Record<CloudType, number> = { cumulus: 0, stratus: 0, cumulonimbus: 0 }
    const drag: Record<CloudType, number> = { cumulus: 0, stratus: 0, cumulonimbus: 0 }
    for (const t of CLOUD_TYPES) {
      const sim = await make(equal(t))
      rho[t] = sim.densityAt(0, 0)
      drag[t] = sim.dragDensityAt(0, 0)
    }
    // The rendered density does not depend on type; the drag-weighted one does.
    expect(rho.stratus).toBeCloseTo(rho.cumulus, 9)
    expect(rho.cumulonimbus).toBeCloseTo(rho.cumulus, 9)
    expect(rho.cumulus).toBeGreaterThan(CLOUD_THRESHOLD)
    expect(drag.cumulus).toBeCloseTo(rho.cumulus, 9)
    expect(drag.cumulonimbus).toBeGreaterThan(drag.cumulus)
    expect(drag.cumulus).toBeGreaterThan(drag.stratus)
  })

  it('a cursor pushed through each type travels farthest in stratus and least in cumulonimbus', async () => {
    const reach: number[] = []
    for (const t of ['stratus', 'cumulus', 'cumulonimbus'] as const) {
      const sim = await make(equal(t))
      // The pointer sweeps 3 units/s through the middle of the cloud; the cursor lags by the drag.
      let lag = 0
      for (let i = 0; i < 120; i++) {
        const x = -3 + i * 0.05
        sim.setPointer({ kind: 'present', x, y: 0 })
        sim.step()
        if (i > 60) lag = Math.max(lag, x - sim.snapshot().cursor.x)
      }
      reach.push(lag)
    }
    const [st, cu, nb] = reach as [number, number, number]
    expect(st).toBeLessThan(cu)
    expect(cu).toBeLessThan(nb)
  })
})

describe('tearing by type', () => {
  /** Drag the pointer across the cloud's short axis at `speed` units/s and let it settle; returns the cloud count. */
  async function sweep(spec: SceneSpec, speed: number, travel = 6, axis: 'x' | 'y' = 'y'): Promise<{ clouds: number; sim: Sim }> {
    const sim = await make(spec)
    const steps = Math.round((2 * travel) / speed / (1 / 60))
    for (let i = 0; i <= steps; i++) {
      const u = -travel + (2 * travel * i) / steps
      sim.setPointer({ kind: 'present', x: axis === 'x' ? u : 0, y: axis === 'y' ? u : 0 })
      sim.step()
    }
    sim.setPointer({ kind: 'absent' })
    for (let i = 0; i < 120; i++) sim.step()
    return { clouds: sim.snapshot().clouds, sim }
  }

  const sheet = (type: CloudType): SceneSpec => ({ clouds: [{ x: 0, y: 0, blobs: 60, aspect: 4, spacing: 0.6, radius: [0.38, 0.1], outline: 'ellipse', linkReach: 1.3, type }] })

  it('a slow sweep across a sheet tears stratus more readily than cumulus', async () => {
    // Tearing is chaotic at the margin, so compare over a band of slow speeds (units/s; a cumulus flick starts near 20).
    let st = 0
    let cu = 0
    for (const speed of [13, 14, 15, 16, 17]) {
      st += (await sweep(sheet('stratus'), speed)).clouds - 1
      cu += (await sweep(sheet('cumulus'), speed)).clouds - 1
    }
    expect(cu).toBe(0)
    expect(st).toBeGreaterThanOrEqual(3)
  })

  it('a fast flick splits cumulus, and a cumulonimbus resists at the same speed', async () => {
    const speed = 45
    const cu = await sweep(equal('cumulus'), speed, 6, 'x')
    const nb = await sweep(equal('cumulonimbus'), speed, 6, 'x')
    expect(cu.clouds).toBeGreaterThan(1)
    expect(nb.clouds).toBe(1)
  })

  it('a much faster flick does split a cumulonimbus', async () => {
    const nb = await sweep(equal('cumulonimbus'), 150, 6, 'x')
    expect(nb.clouds).toBeGreaterThan(1)
  })
})

describe('mixed clouds', () => {
  const mixedPair: SceneSpec = {
    clouds: [
      { x: -1.6, y: 0, blobs: 14, type: 'cumulus' },
      { x: 2.4, y: 0, blobs: 18, type: 'stratus' },
    ],
  }
  const typesOf = (sim: Sim): number[] => [...sim.inspect().blobType]

  it('touching clouds of different types merge, and every blob keeps its type', async () => {
    const sim = await make(mixedPair)
    const before = typesOf(sim)
    expect(new Set(before)).toEqual(new Set([TYPE_INDEX.cumulus, TYPE_INDEX.stratus]))
    // Pull the right cloud into the left one until they touch (nothing is unarmed, so touching merges at once).
    for (let i = 0; i < 600 && sim.snapshot().clouds > 1; i++) {
      sim.setWind((x) => ({ x: x > 0 ? -6 : 6, y: 0 }))
      sim.step()
    }
    expect(sim.snapshot().clouds).toBe(1)
    expect(sim.snapshot().blobs).toBe(32)
    expect(typesOf(sim)).toEqual(before)
    // The renderer sees the mix too: one cloud id, both one-hots present, exactly one per blob.
    const buf = createBlobBuffer()
    sim.writeBlobs(buf)
    let st = 0
    let cu = 0
    for (let i = 0; i < 32; i++) {
      const o = i * BLOB_STRIDE
      const hot = (buf[o + BLOB.typeCumulus] ?? 0) + (buf[o + BLOB.typeStratus] ?? 0) + (buf[o + BLOB.typeNimbus] ?? 0)
      expect(hot).toBe(1)
      st += buf[o + BLOB.typeStratus] ?? 0
      cu += buf[o + BLOB.typeCumulus] ?? 0
    }
    expect([cu, st]).toEqual([14, 18])
  })

  it('a split keeps types and conserves blobs; energy does not rise without input; 60 and 120 Hz agree', async () => {
    const run = async (hz: number): Promise<string> => {
      const sim = await make(sceneSpec('mixed', 17.8, 10))
      // The pointer is sampled at 60 Hz whatever the frame rate: a flick through the middle, then idle.
      const ptr = (f: number) => (f >= 40 && f < 90 ? ({ kind: 'present', x: -9 + (f - 40) * 0.4, y: 0 } as const) : ({ kind: 'absent' } as const))
      const per = hz / 60
      for (let f = 0; f < 240 * per; f++) {
        if (f % per === 0) sim.setPointer(ptr(f / per))
        sim.advance(1 / hz)
      }
      const info = sim.inspect()
      return JSON.stringify([sim.snapshot(), [...info.blobType].join(''), Array.from(info.mass)])
    }
    const a = await run(60)
    const b = await run(120)
    expect(a).toBe(b)
    expect(JSON.parse(a)[0].clouds).toBeGreaterThan(sceneSpec('mixed', 17.8, 10).clouds.length)
    expect(JSON.parse(a)[0].blobs).toBe(buildLayout(sceneSpec('mixed', 17.8, 10)).blobs.length)

    const sim = await make(sceneSpec('mixed', 17.8, 10))
    const types = [...sim.inspect().blobType].join('')
    for (let i = 0; i < 90; i++) {
      sim.setPointer({ kind: 'present', x: -5 + i * 0.1, y: 0 })
      sim.step()
    }
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
    expect(maxRise).toBeLessThanOrEqual(1e-4 * Math.max(e0, 1e-9))
    expect([...sim.inspect().blobType].join('')).toBe(types)
    const info = sim.inspect()
    for (const s of info.springs) expect(info.blobCloud[s.a]).toBe(info.blobCloud[s.b])
  })

  it('type multipliers do not touch a cumulus-only scene (m1 is bit-identical)', async () => {
    const run = async (params: Parameters<typeof createSim>[0]): Promise<string> => {
      const sim = await make('m1', 17.8, params)
      for (let i = 0; i < 240; i++) {
        sim.setPointer(i < 100 ? { kind: 'present', x: -8 + i * 0.16, y: 1 } : { kind: 'absent' })
        sim.step()
      }
      const buf = createBlobBuffer()
      const n = sim.writeBlobs(buf)
      return Array.from(buf.subarray(0, n * BLOB_STRIDE)).join(',')
    }
    const base = await run({})
    const wild = await run({ params: { stratusStiff: 4, stratusSplit: 0.1, nimbusDrag: 5, nimbusMass: 4, nimbusBreeze: 0.1 } })
    expect(wild).toBe(base)
  })

  it('changing a type multiplier at run time retunes its springs (stiffer nimbus rings faster)', async () => {
    const energyAfter = async (stiff: number): Promise<number> => {
      const sim = await make(equal('cumulonimbus'))
      sim.setParams({ nimbusStiff: stiff })
      for (let i = 0; i < 30; i++) {
        sim.setPointer({ kind: 'present', x: -3 + i * 0.1, y: 0 })
        sim.step()
      }
      sim.setPointer({ kind: 'absent' })
      sim.step()
      return sim.inspect().energy.spring
    }
    // Same dent, stiffer springs: more spring energy stored in it.
    expect(await energyAfter(3)).toBeGreaterThan(await energyAfter(0.5))
  })
})

describe('type-aware scenes', () => {
  const NEW = ['clear', 'rain', 'thunder', 'mixed'] as const
  const VIEWS = [
    ['390x844', 390, 844],
    ['1280x800', 1280, 800],
    ['844x390', 844, 390],
  ] as const

  for (const name of NEW) {
    for (const [label, pw, ph] of VIEWS) {
      it(`${name} at ${label}: separated whole clouds inside the view, connected, cores above threshold`, async () => {
        const W = (10 * pw) / ph
        const spec = sceneSpec(name, W, 10)
        // Requested blobs fit before buildLayout truncates (truncation would silently make partial clouds).
        expect(spec.clouds.reduce((a, c) => a + c.blobs, 0)).toBeLessThanOrEqual(MAX_BLOBS)
        const layout = buildLayout(spec)
        expect(layout.blobs.length).toBe(spec.clouds.reduce((a, c) => a + c.blobs, 0))

        const sim = await make(spec, W)
        const { d_release } = sim.getParams()
        const info = sim.inspect()
        const n = sim.snapshot().blobs
        expect(n).toBeLessThanOrEqual(MAX_BLOBS)
        expect(sim.snapshot().clouds).toBe(spec.clouds.length)
        expect(sim.snapshot().clouds).toBeGreaterThanOrEqual(3)

        const buf = createBlobBuffer()
        sim.writeBlobs(buf)
        const at = (i: number, k: number): number => buf[i * BLOB_STRIDE + k] ?? 0
        for (let i = 0; i < n; i++) {
          expect(Math.abs(at(i, BLOB.x)) + at(i, BLOB.radius)).toBeLessThan(W / 2)
          expect(Math.abs(at(i, BLOB.y)) + at(i, BLOB.radius)).toBeLessThan(5)
        }
        // Sky between every pair, well above d_release, so none merge on their own.
        const members = new Map<number, number[]>()
        info.blobCloud.forEach((id, i) => (members.get(id) ?? members.set(id, []).get(id))?.push(i))
        const ids = [...members.keys()]
        for (let a = 0; a < ids.length; a++) {
          for (let b = a + 1; b < ids.length; b++) {
            let gap = Infinity
            for (const i of members.get(ids[a] as number) ?? []) {
              for (const j of members.get(ids[b] as number) ?? []) {
                gap = Math.min(gap, Math.hypot(at(i, BLOB.x) - at(j, BLOB.x), at(i, BLOB.y) - at(j, BLOB.y)) - at(i, BLOB.radius) - at(j, BLOB.radius))
              }
            }
            expect(gap).toBeGreaterThan(d_release + 0.2)
          }
        }
        // Every cloud has a core that renders (a connected cloud, as many springs as it needs).
        for (const ms of members.values()) {
          const core = Math.max(...ms.map((i) => sim.densityAt(at(i, BLOB.x), at(i, BLOB.y))))
          expect(core).toBeGreaterThanOrEqual(CLOUD_THRESHOLD)
        }
        for (const s of info.springs) expect(info.blobCloud[s.a]).toBe(info.blobCloud[s.b])
        // Stays separate for a while with the breeze off.
        for (let i = 0; i < 300; i++) sim.step()
        expect(sim.snapshot().clouds).toBe(spec.clouds.length)
      })
    }
  }

  it('compositions: clear is mostly cumulus, rain mostly stratus, thunder has storm towers, mixed has all three', () => {
    const count = (name: (typeof NEW)[number]): Record<CloudType, number> => {
      const out: Record<CloudType, number> = { cumulus: 0, stratus: 0, cumulonimbus: 0 }
      for (const c of sceneSpec(name, 16, 10).clouds) out[c.type ?? 'cumulus'] += 1
      return out
    }
    const clear = count('clear')
    expect(clear.cumulus).toBeGreaterThan(clear.stratus)
    expect(clear.stratus).toBe(1)
    expect(clear.cumulonimbus).toBe(0)
    const rain = count('rain')
    expect(rain.stratus).toBeGreaterThan(rain.cumulus)
    expect(rain.cumulus).toBeGreaterThan(0)
    const thunder = count('thunder')
    expect(thunder.cumulonimbus).toBeGreaterThanOrEqual(1)
    expect(thunder.cumulonimbus).toBeLessThanOrEqual(2)
    expect(thunder.stratus).toBeGreaterThan(0)
    const mixed = count('mixed')
    expect(Object.values(mixed).every((v) => v > 0)).toBe(true)
    // Cumulonimbus is taller than wide, stratus much wider than tall.
    const ext = (type: CloudType): { w: number; h: number } => {
      const spec = sceneSpec('mixed', 16, 10)
      const lay = buildLayout(spec)
      const idx = spec.clouds.findIndex((c) => (c.type ?? 'cumulus') === type)
      const b = lay.blobs.filter((p) => p.cloud === idx)
      return {
        w: Math.max(...b.map((p) => p.x + p.radius)) - Math.min(...b.map((p) => p.x - p.radius)),
        h: Math.max(...b.map((p) => p.y + p.radius)) - Math.min(...b.map((p) => p.y - p.radius)),
      }
    }
    expect(ext('cumulonimbus').h).toBeGreaterThan(1.5 * ext('cumulonimbus').w)
    expect(ext('stratus').w).toBeGreaterThanOrEqual(3 * ext('stratus').h)
  })
})
