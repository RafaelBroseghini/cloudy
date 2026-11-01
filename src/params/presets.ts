// One weather preset per state, as sparse layers over the field defaults. Values are game feel: moderate and in range.
// Cursor params (m_c, k_p, c_p, cursorMaxSpeed) and the merge gate (d_touch, d_release, tau) are never touched.
import { FIELD_KEYS, srgbHexToLinear, type FieldKey, type Layer } from './fields.ts'
import type { WeatherState } from './weather.ts'

function col(prefix: string, hex: string): Layer {
  const [r, g, b] = srgbHexToLinear(hex)
  return { [`${prefix}R`]: r, [`${prefix}G`]: g, [`${prefix}B`]: b } as Layer
}

export const WEATHER_PRESETS: Readonly<Record<WeatherState, Layer>> = {
  // Today's look: sets nothing, so the scene layer (or the defaults) shows through.
  clear: {},
  // Grey, low-contrast sky and flatter light; heavy clouds: more drag and creep, softer springs; steady rain; dense lower banks.
  rain: {
    ...col('skyTop', '#7f8c9a'),
    ...col('skyHorizon', '#aeb7bf'),
    ...col('skyBottom', '#c4cacd'),
    skySunStrength: 0.12,
    skySunSize: 0.32,
    lightGain: 2,
    ...col('cloudLit', '#e6eaef'),
    ...col('cloudMid', '#b7c0cc'),
    ...col('cloudShade', '#7e8a9e'),
    farOpacity: 0.75,
    farDensity: 0.8,
    midOpacity: 0.85,
    midDensity: 0.7,
    nearDensity: 0.5,
    rainRate: 0.7,
    rainAngle: 0.08,
    windX: 0.3,
    fxExposure: 0.95,
    k_r: 150,
    k_s: 65,
    c: 3.5,
    yieldStrain: 0.38,
    creep: 0.05,
    alpha: 0.05,
    blobDamping: 3,
  },
  // Dark, heavy rain; stiff clouds that tear sooner and snap harder; strikes enabled (rate unused until M3).
  thunder: {
    ...col('skyTop', '#3a4352'),
    ...col('skyHorizon', '#5a6370'),
    ...col('skyBottom', '#6d747d'),
    skySunStrength: 0.04,
    skySunSize: 0.35,
    lightGain: 1.7,
    ...col('cloudLit', '#c3c9d3'),
    ...col('cloudMid', '#8a93a3'),
    ...col('cloudShade', '#566074'),
    farOpacity: 0.85,
    farDensity: 0.9,
    midOpacity: 0.9,
    midDensity: 0.85,
    nearDensity: 0.65,
    rainRate: 0.9,
    rainAngle: 0.15,
    rainSpeed: 16,
    windX: 0.5,
    strikeRate: 0.15,
    strikesEnabled: 1,
    fxExposure: 0.85,
    k_r: 150,
    k_s: 130,
    c: 3.5,
    yieldStrain: 0.4,
    splitStrain: 0.7,
    flickCut: 0.12,
    creep: 0.03,
    alpha: 0.07,
  },
  // Green-grey sky, strong wind, loose springs; vortex strength is a placeholder until M4.
  tornado: {
    ...col('skyTop', '#5c6b55'),
    ...col('skyHorizon', '#8a9a7a'),
    ...col('skyBottom', '#9aa58d'),
    skySunStrength: 0.08,
    lightGain: 1.9,
    ...col('cloudLit', '#d6dccb'),
    ...col('cloudMid', '#a1ab98'),
    ...col('cloudShade', '#6b7a68'),
    farOpacity: 0.8,
    farDensity: 0.7,
    midDensity: 0.65,
    farDrift: 0.08,
    midDrift: 0.12,
    nearDrift: 0.2,
    rainRate: 0.25,
    windX: 1.6,
    windY: 0.2,
    vortexStrength: 0.6,
    fxExposure: 0.9,
    k_r: 135,
    k_s: 55,
    c: 2.5,
    yieldStrain: 0.4,
    splitStrain: 0.8,
    creep: 0.04,
    alpha: 0.04,
    blobDamping: 2,
  },
}

/** Every key some preset sets: the fields the weather layer owns. Others fall through to scene/defaults. */
export const WEATHER_KEYS: readonly FieldKey[] = FIELD_KEYS.filter((k) => Object.values(WEATHER_PRESETS).some((p) => p[k] !== undefined))
