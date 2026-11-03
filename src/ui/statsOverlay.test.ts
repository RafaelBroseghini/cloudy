// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { FrameStatsReport } from '../render/frameStats.ts'
import { createStatsOverlay, statsLines } from './statsOverlay.ts'

const report: FrameStatsReport = { fps: 45, samples: 2700, windowS: 60, p50: 22.2, p95: 22.4, worst: 41, long: 0.004, cpuP95: 1.38, displayHz: 90 }

describe('stats overlay', () => {
  it('puts the render rate beside the display rate, and names the device setup', () => {
    const lines = statsLines(report, 'low', 'webgpu', 0.31, { width: 390, height: 844, dpr: 3 })
    expect(lines[0]).toBe('45 fps of 90 Hz')
    expect(lines[1]).toBe('p50 22.2  p95 22.4  max 41.0 ms')
    expect(lines[2]).toBe('long 0.4%  over 60 s')
    expect(lines[3]).toBe('cpu p95 1.4  sim 0.31 ms')
    expect(lines[4]).toBe('webgpu · low · 390×844 @3')
  })

  it('says when the display rate is not known yet', () => {
    expect(statsLines({ ...report, displayHz: 0 }, 'mid', null, 0, { width: 1, height: 1, dpr: 1 })[0]).toBe('45 fps of ? Hz')
  })

  it('mounts a non-interactive readout and removes it', () => {
    const o = createStatsOverlay({ stats: () => report, tier: () => 'mid', backend: 'webgl2', simStepMs: () => 0.2 })
    const el = document.querySelector('.stats-overlay')
    expect(el?.textContent).toContain('45 fps of 90 Hz')
    expect(el?.getAttribute('aria-hidden')).toBe('true')
    o.dispose()
    expect(document.querySelector('.stats-overlay')).toBeNull()
  })
})
