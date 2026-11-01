// Gameplay feel: layout per aspect, soft containment, split vs. drag, cursor attachment. Node only, through the sim API.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BLOB, BLOB_STRIDE, createBlobBuffer } from './blobBuffer.ts'
import { CURSOR_RADIUS, createSim, type Sim } from './index.ts'
import { sceneSpec, type CloudSpec, type SceneSpec } from './scene.ts'

const sims: Sim[] = []
async function make(scene: SceneSpec | 'm1' | 'empty', w: number, h = 10, params: Parameters<typeof createSim>[0] = {}): Promise<Sim> {
  const sim = await createSim(params)
  sim.loadScene(scene, w, h)
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

const buf = createBlobBuffer()
interface Blob {
  x: number
  y: number
  r: number
  cloud: number
}
function blobs(sim: Sim): Blob[] {
  const n = sim.writeBlobs(buf)
  return Array.from({ length: n }, (_, i) => ({
    x: buf[i * BLOB_STRIDE + BLOB.x] ?? 0,
    y: buf[i * BLOB_STRIDE + BLOB.y] ?? 0,
    r: buf[i * BLOB_STRIDE + BLOB.radius] ?? 0,
    cloud: buf[i * BLOB_STRIDE + BLOB.cloudId] ?? 0,
  }))
}
function pieceSizes(sim: Sim): number[] {
  const sizes = new Map<number, number>()
  for (const id of sim.inspect().blobCloud) sizes.set(id, (sizes.get(id) ?? 0) + 1)
  return [...sizes.values()].sort((a, b) => b - a)
}
function run(sim: Sim, steps: number): void {
  for (let i = 0; i < steps; i++) sim.step()
}

// Viewports from the task: portrait phone, tablet, desktop, full HD, landscape phone.
const VIEWS: Array<[string, number, number]> = [
  ['390x844', 390, 844],
  ['768x1024', 768, 1024],
  ['1280x800', 1280, 800],
  ['1920x1080', 1920, 1080],
  ['844x390', 844, 390],
]

describe('m1 layout', () => {
  for (const [name, pw, ph] of VIEWS) {
    it(`${name}: opens with 2-3 separate, fully visible clouds that stay separate`, async () => {
      const W = (10 * pw) / ph
      const sim = await make('m1', W)
      const { d_release } = sim.getParams()
      const clouds = sim.snapshot().clouds
      expect(clouds).toBeGreaterThanOrEqual(2)
      expect(clouds).toBeLessThanOrEqual(3)
      const b = blobs(sim)
      for (const p of b) {
        expect(p.x - p.r).toBeGreaterThan(-W / 2)
        expect(p.x + p.r).toBeLessThan(W / 2)
        expect(p.y - p.r).toBeGreaterThan(-5)
        expect(p.y + p.r).toBeLessThan(5)
      }
      // Sky between every pair: surface gap well above d_release, so none can touch or merge on their own.
      const ids = [...new Set(b.map((p) => p.cloud))]
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          let gap = Infinity
          for (const p of b) {
            if (p.cloud !== ids[i]) continue
            for (const q of b) if (q.cloud === ids[j]) gap = Math.min(gap, Math.hypot(p.x - q.x, p.y - q.y) - p.r - q.r)
          }
          expect(gap).toBeGreaterThan(d_release + 0.4)
        }
      }
      run(sim, 600)
      expect(sim.snapshot().clouds).toBe(clouds)
    })
  }

  it('clouds shrink and get fewer blobs as the view narrows', async () => {
    const wide = await make('m1', 17.8)
    const narrow = await make('m1', 4.6)
    expect(narrow.snapshot().blobs).toBeLessThan(wide.snapshot().blobs)
    const span = (sim: Sim): number => {
      const b = blobs(sim)
      return Math.max(...b.map((p) => p.x + p.r)) - Math.min(...b.map((p) => p.x - p.r))
    }
    expect(span(narrow)).toBeLessThan(0.4 * span(wide))
  })
})

describe('soft containment', () => {
  const W = 17.8
  const rect = (sim: Sim, w: number, margin: number): number =>
    Math.max(0, ...blobs(sim).map((p) => Math.max(Math.abs(p.x) - (w / 2 - margin), Math.abs(p.y) - (5 - margin))))

  it('a cloud that starts outside the view drifts back inside within 4 s', async () => {
    const sim = await make({ clouds: [{ x: W / 2 + 3, y: 0, blobs: 30 }] }, W)
    expect(rect(sim, W, 0)).toBeGreaterThan(3)
    run(sim, 240)
    // Centres within a blob radius of the visible edge: the blob is back in view (soft, so no hard wall exactly at it).
    expect(rect(sim, W, 0)).toBeLessThan(0.15)
    run(sim, 240)
    expect(rect(sim, W, 0)).toBeLessThan(0.1)
  })

  it('blobs blasted out by wind, and flicked pieces, come back and settle inside', async () => {
    const sim = await make('m1', W)
    let blast = true
    sim.setWind(() => (blast ? { x: 40, y: 15 } : { x: 0, y: 0 }))
    let worst = 0
    for (let i = 0; i < 90; i++) {
      sim.step()
      worst = Math.max(worst, rect(sim, W, 0))
    }
    expect(worst).toBeGreaterThan(2)
    blast = false
    run(sim, 360)
    expect(rect(sim, W, 0)).toBeLessThan(0.15)
  })

  it('setBounds moves the containment rect: shrinking the view pulls blobs in', async () => {
    const sim = await make('m1', W)
    sim.setBounds(8, 10)
    run(sim, 360)
    // Three clouds are wider than the 8 unit view, so they crowd the edge: soft, not exact.
    expect(rect(sim, 8, 0)).toBeLessThan(0.5)
    // Growing it again leaves everything alone: no force inside the rect.
    sim.setBounds(W, 10)
    const before = blobs(sim)
    run(sim, 120)
    const after = blobs(sim)
    for (let i = 0; i < before.length; i++) expect(Math.hypot((after[i]?.x ?? 0) - (before[i]?.x ?? 0), 0)).toBeLessThan(3.5)
  })

  it('never acts on the cursor: a pointer outside the rect is reached', async () => {
    const sim = await make('empty', W)
    sim.setPointer({ kind: 'present', x: W / 2 + 4, y: 7 })
    run(sim, 30)
    const c = sim.snapshot().cursor
    expect(Math.hypot(c.x - (W / 2 + 4), c.y - 7)).toBeLessThan(0.05)
  })

  it('containK = 0 turns it off', async () => {
    const sim = await make({ clouds: [{ x: W / 2 + 3, y: 0, blobs: 30 }] }, W, 10, { params: { containK: 0 } })
    run(sim, 240)
    expect(rect(sim, W, 0)).toBeGreaterThan(3)
  })
})

describe('splits: drag vs. flick', () => {
  const W = 17.8
  /** Pointer sweeps the cloud's width in `across` seconds (1 unit lead-in/out at that speed) along its centre line. */
  async function sweep(cloud: CloudSpec, across: number, yFrac = 0): Promise<{ peak: number[]; clouds: number; moved: number; maxClouds: number }> {
    const sim = await make({ clouds: [cloud] }, W)
    const b0 = blobs(sim)
    const x0 = Math.min(...b0.map((p) => p.x - p.r))
    const x1 = Math.max(...b0.map((p) => p.x + p.r))
    const y0 = Math.min(...b0.map((p) => p.y - p.r))
    const y1 = Math.max(...b0.map((p) => p.y + p.r))
    const y = (y0 + y1) / 2 + yFrac * ((y1 - y0) / 2)
    const xa = x0 - 1
    const xb = x1 + 1
    const n = Math.round(((across * 60) * (xb - xa)) / (x1 - x0))
    let peak = pieceSizes(sim)
    const look = (): void => {
      if (sim.snapshot().clouds >= peak.length) peak = pieceSizes(sim)
    }
    sim.setPointer({ kind: 'present', x: xa, y })
    run(sim, 15)
    const c0 = blobs(sim).reduce((s, p) => s + p.x, 0) / b0.length
    let maxClouds = 1
    for (let i = 1; i <= n; i++) {
      sim.setPointer({ kind: 'present', x: xa + ((xb - xa) * i) / n, y })
      sim.step()
      maxClouds = Math.max(maxClouds, sim.snapshot().clouds)
      look()
    }
    sim.setPointer({ kind: 'absent' })
    // Look before tau re-merges the pieces.
    for (let i = 0; i < 60; i++) {
      sim.step()
      maxClouds = Math.max(maxClouds, sim.snapshot().clouds)
      look()
    }
    const moved = Math.abs(blobs(sim).reduce((s, p) => s + p.x, 0) / b0.length - c0)
    return { peak, clouds: sim.snapshot().clouds, moved, maxClouds }
  }

  const desktop = sceneSpec('m1', W, 10).clouds
  const floor = (n: number): number => Math.max(4, Math.ceil(0.15 * n))

  for (const across of [0.6, 0.9, 1.5]) {
    desktop.forEach((cloud, ci) => {
      it(`a ${across} s sweep across desktop cloud ${ci} dents and drags it but never splits it`, async () => {
        for (const yFrac of [-0.25, 0, 0.25]) {
          const r = await sweep(cloud, across, yFrac)
          expect(r.maxClouds).toBe(1)
          expect(r.peak).toEqual([cloud.blobs])
        }
      })
    })
  }

  for (const across of [0.15, 0.2]) {
    desktop.forEach((cloud, ci) => {
      it(`a ${across} s flick across desktop cloud ${ci} splits it into 2-3 sizable pieces`, async () => {
        let good = 0
        for (const yFrac of [-0.25, 0, 0.25]) {
          const r = await sweep(cloud, across, yFrac)
          const ok = r.peak.length >= 2 && r.peak.length <= 3 && (r.peak.at(-1) ?? 0) >= floor(cloud.blobs) && r.peak.reduce((a, c) => a + c, 0) === cloud.blobs
          if (ok) good++
        }
        // The cut depends on where the lattice rows fall: demand it for most of the lines through the middle.
        expect(good).toBeGreaterThanOrEqual(2)
      })
    })
  }

  it('a slow sweep moves the cloud with the cursor', async () => {
    const r = await sweep(desktop[1] as CloudSpec, 0.9)
    expect(r.moved).toBeGreaterThan(0.5)
  })

  it('no flick leaves a wisp: every piece is at or above the floor once things settle', async () => {
    const cloud = desktop[1] as CloudSpec
    const sim = await make({ clouds: [cloud] }, W)
    let split = 0
    for (let k = 0; k < 6; k++) {
      sim.loadScene({ clouds: [cloud] }, W, 10)
      const steps = 9 + (k % 3) * 3
      const y = cloud.y + (k - 2.5) * 0.5
      sim.setPointer({ kind: 'present', x: cloud.x - 6, y })
      run(sim, 10)
      for (let i = 1; i <= steps; i++) {
        sim.setPointer({ kind: 'present', x: cloud.x - 6 + (12 * i) / steps, y })
        sim.step()
      }
      sim.setPointer({ kind: 'absent' })
      run(sim, 60)
      const sizes = pieceSizes(sim)
      if (sizes.length > 1) split++
      // A piece of a piece may be as small as the absolute floor (4), never a 1-3 blob wisp.
      expect(sizes.at(-1) ?? 0).toBeGreaterThanOrEqual(4)
    }
    expect(split).toBeGreaterThan(2)
  })
})

describe('cursor attachment', () => {
  it('free space: a fast drag keeps the cursor within a fraction of a unit of the pointer, and it settles at once', async () => {
    const sim = await make('empty', 16)
    // The harness recipe: 12 units in 0.15 s (80 units/s). The old cap of 28 units/s left it ~4.5 units behind.
    sim.setPointer({ kind: 'present', x: -6, y: 0 })
    run(sim, 30)
    let worst = 0
    let lagEnd = 0
    for (let i = 1; i <= 9; i++) {
      const x = -6 + (12 * i) / 9
      sim.setPointer({ kind: 'present', x, y: 0 })
      sim.step()
      lagEnd = x - sim.snapshot().cursor.x
      worst = Math.max(worst, lagEnd)
    }
    console.info(`free-space fast drag: max lag ${worst.toFixed(3)}, lag at end of drag ${lagEnd.toFixed(3)}`)
    expect(worst).toBeLessThan(0.5)
    expect(lagEnd).toBeLessThan(0.25)
    // Pointer stopped: the cursor is on it within a tenth of a second.
    run(sim, 6)
    expect(Math.abs(6 - sim.snapshot().cursor.x)).toBeLessThan(0.06)
  })

  it('inside a cloud the only extra lag is density drag, and it stays a fraction of the cursor radius per 10 units/s', async () => {
    const sim = await make('m1', 16)
    const free = await make('empty', 16)
    const ys = -2.5
    let worst = 0
    let worstFree = 0
    for (let i = 0; i <= 60; i++) {
      const x = -7 + i * 0.25 // 15 units/s along the bottom cloud's centre line
      for (const [s, isFree] of [[sim, false], [free, true]] as const) {
        s.setPointer({ kind: 'present', x, y: ys })
        s.step()
        const lag = x - s.snapshot().cursor.x
        if (isFree) worstFree = Math.max(worstFree, lag)
        else worst = Math.max(worst, lag)
      }
    }
    expect(worst).toBeGreaterThan(worstFree)
    expect(worst).toBeLessThan(CURSOR_RADIUS * 2)
  })

  // Blobs cross the cursor centre only if it hopped over them between contact updates.
  for (const [name, spec, speeds] of [
    ['desktop-size blobs', { clouds: [{ x: 0, y: 0, blobs: 40 }] }, [60, 120, 180]],
    ['portrait-size blobs', { clouds: [sceneSpec('m1', 4.62, 10).clouds[1] as CloudSpec] }, [60, 120, 180]],
  ] as Array<[string, SceneSpec, number[]]>) {
    it(`does not tunnel through ${name} at up to the cursor speed cap`, async () => {
      const sim = await make(spec, 17.8)
      const cap = sim.getParams().cursorMaxSpeed
      for (const speed of [...speeds, cap]) {
        for (const dy of [0, 0.3, -0.5]) {
          const cloud = spec.clouds[0] as CloudSpec
          sim.loadScene(spec, 17.8, 10)
          const y = cloud.y + dy
          const x0 = cloud.x - 6
          const n = Math.max(2, Math.round((12 / speed) * 60))
          sim.setPointer({ kind: 'present', x: x0, y })
          run(sim, 10)
          const prev = new Map<number, number>()
          let crossings = 0
          for (let i = 1; i <= n; i++) {
            sim.setPointer({ kind: 'present', x: x0 + (12 * i) / n, y })
            sim.step()
            const c = sim.snapshot().cursor
            blobs(sim).forEach((b, k) => {
              const dxb = b.x - c.x
              if ((prev.get(k) ?? -1) > 0 && dxb < 0 && Math.abs(b.y - c.y) < 0.5 * (b.r + CURSOR_RADIUS)) crossings++
              prev.set(k, dxb)
            })
          }
          expect(crossings, `${name} ${speed} u/s dy ${dy}`).toBe(0)
        }
      }
    })
  }

  it('step() stays cheap while flicking (world-step slicing only on fast frames)', async () => {
    const sim = await make('m1', 16)
    const times: number[] = []
    for (let k = 0; k < 6; k++) {
      sim.setPointer({ kind: 'present', x: -8, y: -2.5 + k * 0.8 })
      run(sim, 5)
      for (let i = 1; i <= 12; i++) {
        sim.setPointer({ kind: 'present', x: -8 + (16 * i) / 12, y: -2.5 + k * 0.8 })
        const t0 = performance.now()
        sim.step()
        times.push(performance.now() - t0)
      }
      sim.setPointer({ kind: 'absent' })
      run(sim, 120)
    }
    times.sort((a, b) => a - b)
    const p50 = times[times.length >> 1] as number
    const p95 = times[Math.floor(times.length * 0.95)] as number
    console.info(`flick step() median ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${(times.at(-1) ?? 0).toFixed(3)} ms`)
    expect(p50).toBeLessThan(3)
  })
})

describe('persistence and determinism', () => {
  /** The verify flow: m1, a fast drag through the biggest cloud, then idle. */
  async function flickBiggest(w: number, sim: Sim): Promise<{ before: number; peak: number; after: number }> {
    sim.loadScene('m1', w, 10)
    run(sim, 60)
    const before = sim.snapshot().clouds
    const sizes = new Map<number, number>()
    for (const id of sim.inspect().blobCloud) sizes.set(id, (sizes.get(id) ?? 0) + 1)
    const big = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0]
    const mine = blobs(sim).filter((_, i) => sim.inspect().blobCloud[i] === big)
    const cx = mine.reduce((s, b) => s + b.x, 0) / mine.length
    const cy = mine.reduce((s, b) => s + b.y, 0) / mine.length
    sim.setPointer({ kind: 'present', x: cx - 6, y: cy })
    run(sim, 90)
    for (let i = 1; i <= 9; i++) {
      sim.setPointer({ kind: 'present', x: cx - 6 + (12 * i) / 9, y: cy })
      sim.step()
    }
    const peak = sim.snapshot().clouds
    sim.setPointer({ kind: 'absent' })
    run(sim, 180)
    return { before, peak, after: sim.snapshot().clouds }
  }

  for (const w of [16, 17.8, 21.6]) {
    it(`W=${w}: pieces from a 80 units/s flick persist: 3 s later there are more clouds than before`, async () => {
      const sim = await make('empty', w)
      const r = await flickBiggest(w, sim)
      expect(r.peak).toBeGreaterThan(r.before)
      expect(r.after).toBeGreaterThan(r.before)
    })
  }

  it('is deterministic: fresh sims and reloaded sims give the same result for the same inputs', async () => {
    const a = await make('empty', 16)
    const b = await make('empty', 16)
    const fingerprint = (sim: Sim): string => `${sim.snapshot().clouds}:${Array.from(blobsRaw(sim)).join(',')}`
    const ra = await flickBiggest(16, a)
    const fa = fingerprint(a)
    const rb = await flickBiggest(16, b)
    expect(rb).toEqual(ra)
    expect(fingerprint(b)).toBe(fa)
    // Reloading the same sim, after leaving the pointer where it was, gives the same again.
    const rc = await flickBiggest(16, a)
    expect(rc).toEqual(ra)
    expect(fingerprint(a)).toBe(fa)
  })

  it('a deliberate push-together after arming still merges the pieces', async () => {
    const sim = await make('m1', 16)
    await flickBiggest(16, sim)
    const before = sim.snapshot().clouds
    // Shove the two nearest pieces together with the cursor: pointer leads one into the other until they merge.
    const info = sim.inspect()
    expect(info.unarmed.length).toBe(0)
    const ids = [...new Set(info.blobCloud)]
    const centres = ids.map((id) => {
      const m = blobs(sim).filter((_, i) => info.blobCloud[i] === id)
      return { id, n: m.length, x: m.reduce((s, b) => s + b.x, 0) / m.length, y: m.reduce((s, b) => s + b.y, 0) / m.length }
    })
    let best: [(typeof centres)[number], (typeof centres)[number]] | null = null
    let bestD = Infinity
    for (const p of centres) for (const q of centres) if (p.id < q.id && Math.hypot(p.x - q.x, p.y - q.y) < bestD) {
      bestD = Math.hypot(p.x - q.x, p.y - q.y)
      best = [p, q]
    }
    const [p, q] = best as NonNullable<typeof best>
    // Drag p toward q from the far side.
    const dx = (q.x - p.x) / bestD
    const dy = (q.y - p.y) / bestD
    sim.setPointer({ kind: 'present', x: p.x - dx * 3, y: p.y - dy * 3 })
    run(sim, 60)
    for (let i = 0; i <= 120; i++) {
      sim.setPointer({ kind: 'present', x: p.x - dx * 3 + dx * (3 + bestD) * (i / 120), y: p.y - dy * 3 + dy * (3 + bestD) * (i / 120) })
      sim.step()
    }
    sim.setPointer({ kind: 'absent' })
    run(sim, 120)
    expect(sim.snapshot().clouds).toBeLessThan(before)
  })
})

function blobsRaw(sim: Sim): Float32Array {
  sim.writeBlobs(buf)
  return buf.slice(0, 8 * sim.snapshot().blobs)
}
