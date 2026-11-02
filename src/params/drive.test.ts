import { afterEach, describe, expect, it } from 'vitest'
import { FIXED_DT, createSim, defaultParams, type Params, type Sim, type Wind } from '../sim/index.ts'
import { PARAM_KEYS } from '../sim/params.ts'
import { WIND_ACCEL_GAIN, breezeOf, createDriveRunner, parseWeatherParam, reportWeather, sameInteraction, windOf, type DriveSink } from './drive.ts'
import { WEATHER_PRESETS } from './presets.ts'
import { interactionOf, resolve } from './resolve.ts'
import { steady } from './weather.ts'

const sims: Sim[] = []
afterEach(() => {
  while (sims.length) sims.pop()?.dispose()
})

/** A sink that records what the drive did to it. */
function recorder(): DriveSink & { sets: Params[]; winds: Array<Wind | null> } {
  const sets: Params[] = []
  const winds: Array<Wind | null> = []
  return { sets, winds, setParams: (p) => sets.push(p), setWind: (w) => winds.push(w) }
}

describe('breeze drive', () => {
  const sinkWithBreeze = () => {
    const breezes: Array<ReturnType<typeof breezeOf>> = []
    return { breezes, setParams: () => undefined, setWind: () => undefined, setBreeze: (b: ReturnType<typeof breezeOf>) => breezes.push(b) }
  }

  it('clear weather pushes a slow drift with faint turbulence, and sinks without setBreeze still work', () => {
    const sink = sinkWithBreeze()
    createDriveRunner(sink, {}, 'clear')
    const b = sink.breezes.at(-1)
    expect(b).toMatchObject({ angle: 0 })
    expect(b?.speed).toBeGreaterThan(0.1)
    expect(b?.speed).toBeLessThan(0.3)
    expect(b?.turbulence).toBeLessThan(b?.speed ?? 0)
    expect(() => createDriveRunner(recorder(), {}, 'rain')).not.toThrow()
  })

  it('weather scales it: rain is faster than clear, thunder gustier than rain, all far under softSpeed', () => {
    const of = (w: 'clear' | 'rain' | 'thunder' | 'tornado') => breezeOf(resolve({}, steady(w)))
    const [c, r, t, n] = [of('clear'), of('rain'), of('thunder'), of('tornado')]
    expect(r?.speed).toBeGreaterThan(c?.speed ?? 0)
    expect(t?.turbulence).toBeGreaterThan(r?.turbulence ?? 0)
    expect(t?.rate).toBeGreaterThan(r?.rate ?? 0)
    for (const b of [c, r, t, n]) expect((b?.speed ?? 9) + 3 * (b?.turbulence ?? 9)).toBeLessThan(defaultParams().softSpeed / 2)
  })

  it('is null (breeze off) when both the drift and the turbulence are zero', () => {
    const sink = sinkWithBreeze()
    createDriveRunner(sink, { scene: { breezeSpeed: 0, turbulence: 0 } }, 'clear')
    expect(sink.breezes.at(-1)).toBeNull()
  })

  it('a transition blends the breeze without a jump', () => {
    const sink = sinkWithBreeze()
    const r = createDriveRunner(sink, {}, 'clear')
    r.setWeather('thunder', 4)
    let prev = sink.breezes.at(-1)?.speed ?? 0
    let maxJump = 0
    for (let i = 0; i < 260; i++) {
      r.step(FIXED_DT)
      const s = sink.breezes.at(-1)?.speed ?? 0
      maxJump = Math.max(maxJump, Math.abs(s - prev))
      prev = s
    }
    expect(maxJump).toBeLessThan(0.01)
    expect(prev).toBeCloseTo(WEATHER_PRESETS.thunder.breezeSpeed ?? 0, 9)
  })
})

describe('weather drive', () => {
  it('clear weather leaves the sim on its default params and no wind', () => {
    const sink = recorder()
    const r = createDriveRunner(sink, {}, 'clear')
    for (let i = 0; i < 600; i++) r.step(FIXED_DT)
    expect(sink.sets).toHaveLength(1)
    for (const k of PARAM_KEYS) expect(sink.sets[0]?.[k]).toBe(defaultParams()[k])
    expect(sink.winds.every((w) => w === null)).toBe(true)
  })

  it('a transition reaches the target interaction params through the same resolve path', () => {
    const sink = recorder()
    const r = createDriveRunner(sink, {}, 'clear')
    r.setWeather('thunder', 4)
    const n = Math.round(4 / FIXED_DT) + 1
    for (let i = 0; i < n; i++) r.step(FIXED_DT)
    expect(r.drive.weather).toEqual(steady('thunder'))
    const want = interactionOf(resolve({}, steady('thunder')))
    expect(sink.sets.at(-1)).toEqual(want)
    expect(want.k_s).toBe(WEATHER_PRESETS.thunder.k_s)
    expect(windOf(r.drive.p).x).toBeCloseTo((WEATHER_PRESETS.thunder.windX ?? 0) * WIND_ACCEL_GAIN, 9)
  })

  it('setParams runs only when an interaction field changed, never once settled', () => {
    const sink = recorder()
    const r = createDriveRunner(sink, {}, 'rain')
    expect(sink.sets).toHaveLength(1) // initial push
    for (let i = 0; i < 300; i++) r.step(FIXED_DT)
    expect(sink.sets).toHaveLength(1)
    r.setWeather('rain', 2) // already there: ignored
    r.step(FIXED_DT)
    expect(sink.sets).toHaveLength(1)
    r.setWeather('tornado', 1)
    for (let i = 0; i < 30; i++) r.step(FIXED_DT)
    const during = sink.sets.length
    expect(during).toBeGreaterThan(1)
    for (let i = 0; i < 300; i++) r.step(FIXED_DT)
    const settled = sink.sets.length
    for (let i = 0; i < 300; i++) r.step(FIXED_DT)
    expect(sink.sets).toHaveLength(settled)
    // Each push really differs from the one before it.
    for (let i = 1; i < sink.sets.length; i++) expect(sameInteraction(sink.sets[i - 1] as Params, sink.sets[i] as Params)).toBe(false)
  })

  it('a transition that only moves look fields never calls setParams', () => {
    const sink = recorder()
    const r = createDriveRunner(sink, { scene: {} }, 'clear')
    r.setLayers({ transient: { fxExposure: 0.5 } })
    r.step(FIXED_DT)
    expect(sink.sets).toHaveLength(1)
  })

  it('weather time is lockstep with sim steps: n steps of dt equal one transition advanced n*dt', () => {
    const a = createDriveRunner(recorder(), {}, 'clear')
    const b = createDriveRunner(recorder(), {}, 'clear')
    a.setWeather('rain', 4)
    b.setWeather('rain', 4)
    for (let i = 0; i < 60; i++) a.step(FIXED_DT)
    for (let i = 0; i < 60; i++) b.step(FIXED_DT)
    expect(a.drive.p).toEqual(b.drive.p)
    expect(reportWeather(a.drive.weather).progress).toBeCloseTo(0.25, 6)
  })

  it('reports weather for the harness', () => {
    expect(reportWeather(steady('rain'))).toEqual({ kind: 'steady', state: 'rain', progress: 1 })
    const r = createDriveRunner(recorder(), {}, 'clear')
    r.setWeather('tornado', 4)
    expect(reportWeather(r.drive.weather)).toMatchObject({ kind: 'transition', from: 'clear', to: 'tornado', progress: 0 })
  })

  it('parses ?weather=', () => {
    expect(parseWeatherParam('?weather=rain')).toBe('rain')
    expect(parseWeatherParam('?weather=thunder&backend=webgl')).toBe('thunder')
    expect(parseWeatherParam('?weather=tornado')).toBe('tornado')
    expect(parseWeatherParam('?weather=snow')).toBe('clear')
    expect(parseWeatherParam('')).toBe('clear')
  })
})

describe('wind never acts on the cursor', () => {
  // The drive's wind goes to blobs only: with the clouds out of reach, the cursor trajectory is the same under any wind.
  const trace = async (windX: number, windY: number, to?: 'tornado'): Promise<number[]> => {
    const sim = await createSim()
    sims.push(sim)
    sim.loadScene({ clouds: [{ x: -7, y: 3, blobs: 30 }] }, 17.8, 10)
    // Layers cannot set wind (weather owns it); a scene layer feeds the wind fields through resolve like a preset would.
    const r = createDriveRunner(sim, { scene: { windX, windY } }, 'clear')
    if (to) r.setWeather(to, 2)
    const out: number[] = []
    for (let i = 0; i < 240; i++) {
      sim.setPointer({ kind: 'present', x: 6 + 2 * Math.sin(i / 20), y: -3 + Math.cos(i / 15) })
      r.step(FIXED_DT)
      sim.step()
      const s = sim.snapshot().cursor
      out.push(s.x, s.y, s.vx, s.vy)
    }
    return out
  }

  it('is bit-identical for any windX / windY, even while the weather transitions', async () => {
    const base = await trace(0, 0)
    expect(await trace(3, 1)).toEqual(base)
    expect(await trace(-3, -1)).toEqual(base)
    // Tornado's own wind (and its other interaction params) ramping in changes nothing the cursor feels while clouds are far.
    expect(await trace(0, 0, 'tornado')).toEqual(base)
  })

  it('wind from P does move blobs', async () => {
    const sim = await createSim()
    sims.push(sim)
    sim.loadScene({ clouds: [{ x: 0, y: 0, blobs: 30 }] }, 17.8, 10)
    const r = createDriveRunner(sim, { scene: { windX: 3 } }, 'clear')
    const buf = new Float32Array(256 * 8)
    sim.writeBlobs(buf)
    const x0 = buf[0] ?? 0
    for (let i = 0; i < 120; i++) {
      r.step(FIXED_DT)
      sim.step()
    }
    sim.writeBlobs(buf)
    expect((buf[0] ?? 0) - x0).toBeGreaterThan(0.1)
  })
})
