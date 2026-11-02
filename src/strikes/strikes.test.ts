import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { interactionOf, resolve, steady, WEATHER_STATES, createDriveRunner, type Layers } from '../params/index.ts'
import { createStrikeDirector, flashLayer, type StrikePorts } from './director.ts'
import { FULL_SHAPE, SOFT_SHAPE, STRIKE_LEAD, flashEnvelope } from './envelope.ts'
import { createStrikeScheduler } from './scheduler.ts'
import { heardAt, latencyOf, planThunder, renderNowFromTimestamp, thunderStart, type Clocks } from './sync.ts'
import { MAX_VOICES, RATE_MAX, RATE_MIN, thunderVoice } from './voice.ts'
import { FIXED_DT } from '../sim/fixedStep.ts'
import type { Params } from '../sim/params.ts'

const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true })

interface Rig {
  clocks: Clocks
  played: { id: number; startAt: number }[]
  ports: StrikePorts
}

/** A director rig with a hand-set clock and a recording thunder port. */
function rig(init: { audio: number | null; perf?: number; latency?: number; loaded?: boolean; voiceFree?: boolean; reduced?: boolean }): Rig {
  const r: Rig = {
    clocks: { audio: init.audio, perf: init.perf ?? 100 },
    played: [],
    ports: undefined as unknown as StrikePorts,
  }
  r.ports = {
    clocks: () => r.clocks,
    latency: () => init.latency ?? 0,
    currentTime: () => (r.clocks.audio ?? 0) - 0.01,
    thunder: {
      loaded: init.loaded ?? true,
      voiceFree: init.voiceFree ?? true,
      start: (s, startAt) => void r.played.push({ id: s.id, startAt }),
    },
    reducedMotion: () => init.reduced ?? false,
  }
  return r
}

describe('flash envelope', () => {
  const sample = fc.double({ min: -0.5, max: 3, noNaN: true })
  it('peaks at tau = 0 with value 1 and stays within [0, 1]', () => {
    expect(flashEnvelope(0)).toBe(1)
    fc.assert(
      fc.property(sample, (tau) => {
        const e = flashEnvelope(tau)
        expect(e).toBeGreaterThanOrEqual(0)
        expect(e).toBeLessThanOrEqual(1)
        if (Math.abs(tau) > 1e-6) expect(e).toBeLessThan(1)
      }),
    )
  })
  it('is 0 before the rise and after the end, and the rise fits inside the strike lead', () => {
    for (const sh of [FULL_SHAPE, SOFT_SHAPE]) {
      expect(sh.attack).toBeLessThanOrEqual(STRIKE_LEAD)
      expect(flashEnvelope(-sh.attack, sh)).toBe(0)
      expect(flashEnvelope(-STRIKE_LEAD, sh)).toBe(0)
      expect(flashEnvelope(sh.duration, sh)).toBe(0)
      expect(flashEnvelope(sh.duration + 5, sh)).toBe(0)
      expect(flashEnvelope(0, sh)).toBeCloseTo(sh.gain, 12)
    }
  })
  it('flickers (a dip then a second rise) in the full shape and decays to a faint glow by 0.8 s', () => {
    expect(flashEnvelope(0.08)).toBeLessThan(flashEnvelope(0.12))
    expect(flashEnvelope(0.8)).toBeLessThan(0.1)
  })
  it('the soft (reduced motion) shape is dimmer and has no second peak', () => {
    let rising = 0
    let prev = flashEnvelope(0, SOFT_SHAPE)
    for (let t = 0.01; t < 2; t += 0.01) {
      const e = flashEnvelope(t, SOFT_SHAPE)
      if (e > prev + 1e-9) rising++
      prev = e
    }
    expect(rising).toBe(0)
    expect(SOFT_SHAPE.gain).toBeLessThan(0.6)
  })
})

describe('StrikeSync: heard thunder minus flash peak is d for any latency', () => {
  it('pure timing', () => {
    fc.assert(
      fc.property(num(0, 1e5), num(0, 10), num(0, 1), (tStrike, d, L) => {
        const start = thunderStart(tStrike, d, L)
        expect(start).toBeCloseTo(tStrike + d - L, 6)
        // Output is delayed by L after the start, so it is heard at start + L.
        const heard = start + L
        expect(heard).toBeCloseTo(heardAt(tStrike, d), 6)
        const flashPeak = tStrike // the envelope peaks at tau = 0
        expect(heard - flashPeak).toBeCloseTo(d, 6)
      }),
    )
  })
  it('through the director: scheduledThunderAt + latency - flash peak = d, and the flash is at its peak at tStrike', () => {
    fc.assert(
      fc.property(num(0, 1000), num(0.45, 3), num(0, 0.3), num(0, 1), (t0, d, L, intensity) => {
        const r = rig({ audio: t0, latency: L })
        const dir = createStrikeDirector(1, r.ports)
        const rec = dir.force({ d, intensity })
        expect(rec.scheduledThunderAt).not.toBeNull()
        expect(rec.tStrike).toBeCloseTo(t0 + STRIKE_LEAD, 9)
        expect(rec.scheduledThunderAt! + rec.latency - rec.tStrike).toBeCloseTo(d, 9)
        expect(rec.latency).toBe(L)
        r.clocks = { audio: rec.tStrike, perf: 100 }
        expect(dir.flash().value).toBeCloseTo(intensity, 9)
        // Before and after the peak it is lower.
        r.clocks = { audio: rec.tStrike + 0.3, perf: 100 }
        expect(dir.flash().value).toBeLessThan(intensity + 1e-12)
      }),
    )
  })
  it('the render clock from an output timestamp is the heard clock plus the latency', () => {
    expect(renderNowFromTimestamp({ contextTime: 10, performanceTime: 5000 }, 5250, 0.04)).toBeCloseTo(10.29, 9)
  })
  it('latencyOf prefers outputLatency, then baseLatency, then 0, and ignores junk', () => {
    expect(latencyOf({ outputLatency: 0.05, baseLatency: 0.01 })).toBe(0.05)
    expect(latencyOf({ outputLatency: 0, baseLatency: 0.01 })).toBe(0.01)
    expect(latencyOf({ outputLatency: Number.NaN })).toBe(0)
    expect(latencyOf({})).toBe(0)
    expect(latencyOf({ outputLatency: -1 })).toBe(0)
  })
})

describe('no late thunder', () => {
  const env = (audioNow: number | null, o: Partial<{ latency: number; loaded: boolean; voiceFree: boolean }> = {}) => ({
    audioNow,
    currentTime: audioNow ?? 0,
    latency: o.latency ?? 0,
    loaded: o.loaded ?? true,
    voiceFree: o.voiceFree ?? true,
  })
  const s = { clock: 'audio' as const, tStrike: 10, d: 1 }
  it('skips when the heard time has passed, for any latency', () => {
    fc.assert(
      fc.property(num(0, 1), num(0, 5), (L, over) => {
        const now = heardAt(s.tStrike, s.d) + over
        expect(planThunder(s, env(now, { latency: L }))).toEqual({ kind: 'skip', reason: 'late' })
      }),
    )
  })
  it('plays only at a start that is not before now, and then it is heard at or after now', () => {
    fc.assert(
      fc.property(num(0, 1), num(0, 15), (L, now) => {
        const plan = planThunder(s, env(now, { latency: L }))
        if (plan.kind === 'play') {
          expect(plan.startAt).toBeGreaterThanOrEqual(now)
          expect(plan.startAt + L).toBeGreaterThanOrEqual(now)
        }
      }),
    )
  })
  it('skips with a reason when not loaded or out of voices, and only then plays', () => {
    expect(planThunder(s, env(9.9, { loaded: false }))).toEqual({ kind: 'skip', reason: 'not-loaded' })
    expect(planThunder(s, env(9.9, { voiceFree: false }))).toEqual({ kind: 'skip', reason: 'voice-cap' })
    expect(planThunder(s, env(9.9, { latency: 0.1 }))).toEqual({ kind: 'play', startAt: 10.9 })
  })
  it('the director skips a strike whose latency makes the start already past', () => {
    const r = rig({ audio: 50, latency: 0.6 })
    const rec = createStrikeDirector(1, r.ports).force({ d: 0.45 })
    expect(rec.skippedReason).toBe('late')
    expect(rec.scheduledThunderAt).toBeNull()
    expect(r.played).toEqual([])
  })
  it('caps simultaneous voices through the port', () => {
    expect(MAX_VOICES).toBe(3)
    const r = rig({ audio: 50, voiceFree: false })
    expect(createStrikeDirector(1, r.ports).force({ d: 1 }).skippedReason).toBe('voice-cap')
  })
})

describe('locked audio', () => {
  it('flash follows the performance clock and thunder is skipped', () => {
    fc.assert(
      fc.property(num(0.45, 3), num(0.1, 1), (d, intensity) => {
        const r = rig({ audio: null, perf: 100 })
        const dir = createStrikeDirector(1, r.ports)
        const rec = dir.force({ d, intensity })
        expect(rec.clock).toBe('perf')
        expect(rec.skippedReason).toBe('locked')
        expect(rec.scheduledThunderAt).toBeNull()
        expect(r.played).toEqual([])
        expect(rec.tStrike).toBeCloseTo(100 + STRIKE_LEAD, 9)
        r.clocks = { audio: null, perf: rec.tStrike }
        expect(dir.flash().value).toBeCloseTo(intensity, 9)
        r.clocks = { audio: null, perf: rec.tStrike + 5 }
        expect(dir.flash().value).toBe(0)
      }),
    )
  })
  it('a strike made while locked keeps flashing on the performance clock after audio unlocks', () => {
    const r = rig({ audio: null, perf: 100 })
    const dir = createStrikeDirector(1, r.ports)
    const rec = dir.force({ intensity: 1, d: 1 })
    r.clocks = { audio: 7, perf: rec.tStrike + 0.05 }
    expect(dir.flash().value).toBeCloseTo(flashEnvelope(0.05), 9)
    expect(r.played).toEqual([])
  })
  it('a suspended context (audio clock gone) reads as locked', () => {
    const r = rig({ audio: null })
    expect(createStrikeDirector(3, r.ports).force().skippedReason).toBe('locked')
  })
})

describe('StrikeLeavesSimUnchanged', () => {
  const state = fc.constantFrom(...WEATHER_STATES)
  const strikeSeq = fc.array(fc.record({ gap: num(0, 2), intensity: num(0, 1), x: num(0, 1), d: num(0.4, 3) }), { maxLength: 8 })

  it('resolved interaction fields are identical with and without any strike sequence', () => {
    fc.assert(
      fc.property(state, strikeSeq, fc.integer({ min: 0, max: 400 }), (st, seq, probe) => {
        const r = rig({ audio: 10 })
        const dir = createStrikeDirector(9, r.ports)
        const base = resolve({}, steady(st))
        for (const s of seq) {
          r.clocks = { audio: (r.clocks.audio ?? 0) + s.gap, perf: r.clocks.perf + s.gap }
          dir.force(s)
          r.clocks = { audio: (r.clocks.audio ?? 0) + (probe % 40) / 100, perf: r.clocks.perf }
          const f = flashLayer(dir.flash())
          const withStrike = resolve({ transient: f }, steady(st))
          expect(interactionOf(withStrike)).toEqual(interactionOf(base))
          // Stronger: every field outside the post-FX flash pair is untouched.
          for (const k of Object.keys(base) as (keyof typeof base)[]) {
            if (k !== 'fxFlash' && k !== 'fxFlashX') expect(withStrike[k]).toBe(base[k])
          }
        }
      }),
    )
  })

  it('a smuggled interaction key in the transient layer is ignored by resolve', () => {
    const evil = { fxFlash: 1, k_s: 399, tau: 19, d_touch: 0.3 } as unknown as Layers['transient']
    expect(interactionOf(resolve({ transient: evil }, steady('thunder')))).toEqual(interactionOf(resolve({}, steady('thunder'))))
  })

  it('running flashes through the drive runner never calls setParams again', () => {
    const calls: Params[] = []
    const sink = { setParams: (p: Params) => void calls.push(p), setWind: () => {} }
    const run = createDriveRunner(sink, {}, 'thunder')
    const n = calls.length
    for (let i = 0; i < 20; i++) run.setLayers({ transient: flashLayer({ value: i / 20, x: 0.3 }) })
    for (let i = 0; i < 20; i++) run.step(FIXED_DT)
    expect(calls.length).toBe(n)
  })
})

describe('strike scheduler', () => {
  const run = (seed: number, secs: number, enabled: boolean, rate: number) => {
    const s = createStrikeScheduler(seed)
    const out: { at: number; d: number; intensity: number; x: number }[] = []
    const n = Math.round(secs / FIXED_DT)
    for (let i = 0; i < n; i++) for (const e of s.step(FIXED_DT, enabled, rate)) out.push({ at: i * FIXED_DT, d: e.d, intensity: e.intensity, x: e.x })
    return out
  }
  it('is deterministic for a seed and differs between seeds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (seed) => {
        expect(run(seed, 120, true, 0.2)).toEqual(run(seed, 120, true, 0.2))
      }),
      { numRuns: 20 },
    )
    expect(run(1, 300, true, 0.2)).not.toEqual(run(2, 300, true, 0.2))
  })
  it('long-run rate is about strikeRate', () => {
    for (const rate of [0.05, 0.1, 0.3]) {
      const secs = 20000
      const n = run(7, secs, true, rate).length
      expect(n / secs).toBeGreaterThan(rate * 0.9)
      expect(n / secs).toBeLessThan(rate * 1.1)
    }
  })
  it('never clumps: gaps are at least 0.35 / rate', () => {
    const ev = run(5, 2000, true, 0.1)
    for (let i = 1; i < ev.length; i++) expect(ev[i]!.at - ev[i - 1]!.at).toBeGreaterThanOrEqual(3.5 - 2 * FIXED_DT)
  })
  it('makes no strikes when disabled or at rate 0', () => {
    expect(run(3, 2000, false, 1)).toEqual([])
    expect(run(3, 2000, true, 0)).toEqual([])
  })
  it('strikes are in range, and further ones are softer on average', () => {
    const ev = run(11, 20000, true, 0.3)
    for (const e of ev) {
      expect(e.d).toBeGreaterThanOrEqual(0.4)
      expect(e.d).toBeLessThanOrEqual(3)
      expect(e.intensity).toBeGreaterThan(0)
      expect(e.intensity).toBeLessThanOrEqual(1)
      expect(e.x).toBeGreaterThanOrEqual(0)
      expect(e.x).toBeLessThanOrEqual(1)
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(ev.filter((e) => e.d < 1).map((e) => e.intensity))).toBeGreaterThan(mean(ev.filter((e) => e.d > 2).map((e) => e.intensity)))
  })
  it('the director fires scheduled strikes only while the resolved params enable them, and presets match the brief', () => {
    const r = rig({ audio: 10 })
    const dir = createStrikeDirector(4, r.ports)
    const on = resolve({}, steady('thunder'))
    const off = resolve({}, steady('clear'))
    for (let i = 0; i < 60 * 600; i++) dir.step(FIXED_DT, off.strikesEnabled, off.strikeRate)
    expect(dir.count).toBe(0)
    for (let i = 0; i < 60 * 600; i++) dir.step(FIXED_DT, on.strikesEnabled, on.strikeRate)
    // Thunder: a strike every ~6 to 15 s on average.
    expect(600 / dir.count).toBeGreaterThan(6)
    expect(600 / dir.count).toBeLessThan(15)
    expect(resolve({}, steady('rain')).strikesEnabled).toBe(0)
  })
  it('forcing strikes does not change the scheduled sequence', () => {
    const a = rig({ audio: 10 })
    const b = rig({ audio: 10 })
    const da = createStrikeDirector(8, a.ports)
    const db = createStrikeDirector(8, b.ports)
    const ids: number[] = []
    for (let i = 0; i < 60 * 300; i++) {
      if (i % 500 === 0) db.force()
      da.step(FIXED_DT, 1, 0.2)
      db.step(FIXED_DT, 1, 0.2)
      ids.push(da.count)
    }
    expect(db.count).toBe(da.count + 1 + Math.floor((60 * 300 - 1) / 500))
  })
})

describe('thunder voice', () => {
  const ev = fc.record({ d: num(0.4, 3), intensity: num(0, 1), pick: num(0, 1), pitch: num(0, 1) })
  it('stays in range for any file count', () => {
    fc.assert(
      fc.property(ev, fc.integer({ min: 0, max: 6 }), (s, n) => {
        const v = thunderVoice(s, n)
        expect(v.rate).toBeGreaterThanOrEqual(RATE_MIN)
        expect(v.rate).toBeLessThanOrEqual(RATE_MAX)
        expect(v.gain).toBeGreaterThan(0)
        expect(v.gain).toBeLessThanOrEqual(1)
        expect(v.file).toBeGreaterThanOrEqual(0)
        expect(v.file).toBeLessThan(Math.max(1, n))
      }),
    )
  })
  it('further strikes are duller, louder intensity is louder', () => {
    const base = { intensity: 0.8, pick: 0.5, pitch: 0.5 }
    expect(thunderVoice({ ...base, d: 3 }, 3).lowpassHz).toBeLessThan(thunderVoice({ ...base, d: 0.5 }, 3).lowpassHz)
    expect(thunderVoice({ ...base, intensity: 1, d: 1 }, 3).gain).toBeGreaterThan(thunderVoice({ ...base, intensity: 0.3, d: 1 }, 3).gain)
  })
  it('different picks reach different files', () => {
    const files = new Set([0, 0.4, 0.8].map((pick) => thunderVoice({ d: 1, intensity: 1, pick, pitch: 0 }, 3).file))
    expect(files.size).toBe(3)
  })
})
