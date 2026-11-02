// Time of day (the sun-height slider): a keyframe table of sky, sun and cloud-lighting values, interpolated piecewise
// linearly in t. Pure. t = 0 dawn, .25 morning, .5 midday, .78 sunset, 1 purple dusk. The midday row IS the field
// defaults (same hex strings as src/params/fields.ts, same conversion), so t = .5 resolves to today's look exactly.
import { srgbHexToLinear, type SkyKey, type SkyLayer } from '../params/index.ts'

/** Keyframe times, strictly increasing. */
export const SKY_TIMES = [0, 0.25, 0.5, 0.78, 1] as const

type Hex3 = readonly [string, string, string]
interface Frame {
  readonly top: string
  readonly horizon: string
  readonly bottom: string
  readonly sun: string
  readonly sunPos: readonly [number, number]
  readonly sunSize: number
  readonly sunStrength: number
  /** In front of (+) or behind (-) the clouds; negative at the horizon gives the silver-lining backlight. */
  readonly sunDepth: number
  /** Cloud lit / mid / shade colours (warm at sunset, rosy at dusk). */
  readonly cloud: Hex3
}

// Sky colours are the mockup's table. The sun climbs from the left, passes today's default spot (.78, .8) at midday
// and sets low on the right; its x is strictly increasing so the slider can be read back from it.
const FRAMES: readonly Frame[] = [
  { top: '#7a86c9', horizon: '#ffc9a8', bottom: '#ffe7cf', sun: '#ffd2a8', sunPos: [0.06, 0.4], sunSize: 0.3, sunStrength: 0.7, sunDepth: -0.1, cloud: ['#fff0e6', '#f0d6d8', '#a4a2cc'] },
  { top: '#5aa0e6', horizon: '#cfe8f7', bottom: '#f2f6ee', sun: '#fff3d6', sunPos: [0.38, 0.66], sunSize: 0.24, sunStrength: 0.6, sunDepth: 0.25, cloud: ['#ffffff', '#e6eef8', '#a6b8da'] },
  { top: '#4f9be0', horizon: '#bfe3f7', bottom: '#e9f3f2', sun: '#fff1c9', sunPos: [0.78, 0.8], sunSize: 0.22, sunStrength: 0.55, sunDepth: 0.35, cloud: ['#ffffff', '#dfe9f6', '#9fb3d6'] },
  { top: '#5a6fb8', horizon: '#ffb27a', bottom: '#ffd9a8', sun: '#ffa65a', sunPos: [0.92, 0.48], sunSize: 0.34, sunStrength: 0.85, sunDepth: -0.1, cloud: ['#ffe8c8', '#fad0b6', '#b49ab8'] },
  { top: '#3b2f6e', horizon: '#b36ab4', bottom: '#f2a6b8', sun: '#ff8f8a', sunPos: [0.97, 0.34], sunSize: 0.36, sunStrength: 0.75, sunDepth: -0.15, cloud: ['#fbd6e2', '#dba8c8', '#8e78b4'] },
]

const lin = (hex: string): readonly [number, number, number] => srgbHexToLinear(hex)

/** Every SKY_KEYS value of one frame, in SKY_KEYS terms. */
function frameValues(f: Frame): Record<SkyKey, number> {
  const [skyTop, skyHorizon, skyBottom, skySun] = [lin(f.top), lin(f.horizon), lin(f.bottom), lin(f.sun)]
  const [cloudLit, cloudMid, cloudShade] = f.cloud.map(lin) as [ReturnType<typeof lin>, ReturnType<typeof lin>, ReturnType<typeof lin>]
  return {
    skyTopR: skyTop[0], skyTopG: skyTop[1], skyTopB: skyTop[2],
    skyHorizonR: skyHorizon[0], skyHorizonG: skyHorizon[1], skyHorizonB: skyHorizon[2],
    skyBottomR: skyBottom[0], skyBottomG: skyBottom[1], skyBottomB: skyBottom[2],
    skySunR: skySun[0], skySunG: skySun[1], skySunB: skySun[2],
    skySunPosX: f.sunPos[0], skySunPosY: f.sunPos[1], skySunSize: f.sunSize, skySunStrength: f.sunStrength, skySunDepth: f.sunDepth,
    cloudLitR: cloudLit[0], cloudLitG: cloudLit[1], cloudLitB: cloudLit[2],
    cloudMidR: cloudMid[0], cloudMidG: cloudMid[1], cloudMidB: cloudMid[2],
    cloudShadeR: cloudShade[0], cloudShadeG: cloudShade[1], cloudShadeB: cloudShade[2],
  }
}

const TABLE = FRAMES.map(frameValues)
const KEYS = Object.keys(TABLE[0] as object) as SkyKey[]

/**
 * The sky layer for a time of day t (clamped to 0..1; non-finite counts as midday). `(1 - u) a + u b` is exact at both
 * ends, so a keyframe time returns that frame's values bit for bit.
 */
export function skyLayerAt(t: number): SkyLayer {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5
  let i = 1
  while (i < SKY_TIMES.length - 1 && x > (SKY_TIMES[i] as number)) i++
  const t0 = SKY_TIMES[i - 1] as number
  const t1 = SKY_TIMES[i] as number
  const u = (x - t0) / (t1 - t0)
  const a = TABLE[i - 1] as Record<SkyKey, number>
  const b = TABLE[i] as Record<SkyKey, number>
  const out: SkyLayer = {}
  for (const k of KEYS) out[k] = (1 - u) * a[k] + u * b[k]
  return out
}

/** Inverse of the sun's x along the arc: the time of day whose `skySunPosX` is `x` (clamped to the arc's ends). */
export function timeOfDayFromSunX(x: number): number {
  const xs = FRAMES.map((f) => f.sunPos[0])
  if (!Number.isFinite(x) || x <= (xs[0] as number)) return 0
  if (x >= (xs[xs.length - 1] as number)) return 1
  let i = 1
  while (x > (xs[i] as number)) i++
  const x0 = xs[i - 1] as number
  const x1 = xs[i] as number
  const t0 = SKY_TIMES[i - 1] as number
  const t1 = SKY_TIMES[i] as number
  return t0 + ((x - x0) / (x1 - x0)) * (t1 - t0)
}
