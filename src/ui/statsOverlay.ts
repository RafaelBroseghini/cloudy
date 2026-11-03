// `?stats`: a small frame-time readout in the top-right corner, for reading numbers off a real phone or tablet without dev
// tools. It shows the render rate beside the display's own rate, so a frame rate capped by the render loop reads
// differently from a slow one. It never takes input (pointer-events: none) and repaints twice a second, not every frame.
import type { FrameStatsReport } from '../render/frameStats.ts'
import type { TierName } from '../render/tier.ts'
import './statsOverlay.css'

export interface StatsHost {
  stats(): FrameStatsReport
  tier(): TierName
  readonly backend: 'webgpu' | 'webgl2' | null
  /** Moving average of one sim step's main-thread cost, ms. */
  simStepMs(): number
}

export interface ScreenInfo {
  width: number
  height: number
  dpr: number
}

/** Repaint period, ms. */
const REPAINT_MS = 500

const ms = (v: number): string => v.toFixed(1)

/** The overlay's lines for a report (pure, so tests can read it). */
export function statsLines(r: FrameStatsReport, tier: TierName, backend: string | null, simMs: number, screen: ScreenInfo): string[] {
  const hz = r.displayHz > 0 ? `${Math.round(r.displayHz)} Hz` : '? Hz'
  return [
    `${Math.round(r.fps)} fps of ${hz}`,
    `p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  max ${ms(r.worst)} ms`,
    `long ${(r.long * 100).toFixed(1)}%  over ${Math.round(r.windowS)} s`,
    `cpu p95 ${ms(r.cpuP95)}  sim ${simMs.toFixed(2)} ms`,
    `${backend ?? '?'} · ${tier} · ${screen.width}×${screen.height} @${+screen.dpr.toFixed(2)}`,
  ]
}

export function createStatsOverlay(host: StatsHost, parent: HTMLElement = document.body): { dispose(): void } {
  const root = document.createElement('pre')
  root.className = 'stats-overlay'
  root.setAttribute('aria-hidden', 'true')
  const paint = (): void => {
    const screen = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }
    root.textContent = statsLines(host.stats(), host.tier(), host.backend, host.simStepMs(), screen).join('\n')
  }
  paint()
  parent.append(root)
  const timer = setInterval(paint, REPAINT_MS)
  return {
    dispose() {
      clearInterval(timer)
      root.remove()
    },
  }
}
