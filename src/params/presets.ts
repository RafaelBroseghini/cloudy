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
  // Dark blue-grey sky behind bright clouds with heavy, dark undersides, so the play clouds keep their edges; the scenery
  // banks go hazy and thin (they blend toward the horizon colour). Heavy clouds: more drag and creep, softer springs; steady rain.
  rain: {
    ...col('skyTop', '#3f4f64'),
    ...col('skyHorizon', '#76879b'),
    ...col('skyBottom', '#8997a7'),
    skySunStrength: 0.05,
    skySunSize: 0.32,
    lightGain: 3.4,
    ...col('cloudLit', '#f4f7fb'),
    ...col('cloudMid', '#c0cbdb'),
    ...col('cloudShade', '#4f5d76'),
    farOpacity: 0.55,
    farTint: 0.7,
    farDensity: 0.8,
    midOpacity: 0.6,
    midTint: 0.55,
    midDensity: 0.7,
    nearOpacity: 0.25,
    nearTint: 0.5,
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
  // Darker and heavier than rain: near-black blue sky, bright cloud tops over very dark undersides, thin hazy banks;
  // stiff clouds that tear sooner and snap harder; strikes enabled (rate unused until M3).
  thunder: {
    ...col('skyTop', '#232c3b'),
    ...col('skyHorizon', '#465264'),
    ...col('skyBottom', '#55616f'),
    skySunStrength: 0.03,
    skySunSize: 0.35,
    lightGain: 3.6,
    ...col('cloudLit', '#e3e8f1'),
    ...col('cloudMid', '#9ba7ba'),
    ...col('cloudShade', '#39435a'),
    farOpacity: 0.6,
    farTint: 0.75,
    farDensity: 0.9,
    midOpacity: 0.62,
    midTint: 0.6,
    midDensity: 0.85,
    nearOpacity: 0.28,
    nearTint: 0.55,
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
  // Green-grey sky darker than the clouds, which stay bright on top with dark undersides; hazy banks; strong wind, loose
  // springs; vortex strength is a placeholder until M4.
  tornado: {
    ...col('skyTop', '#3d4c3b'),
    ...col('skyHorizon', '#68795d'),
    ...col('skyBottom', '#7a8a6e'),
    skySunStrength: 0.05,
    lightGain: 3.4,
    ...col('cloudLit', '#f0f5e6'),
    ...col('cloudMid', '#b4c0a6'),
    ...col('cloudShade', '#46553f'),
    farOpacity: 0.6,
    farTint: 0.7,
    farDensity: 0.7,
    midOpacity: 0.6,
    midTint: 0.55,
    midDensity: 0.65,
    nearOpacity: 0.25,
    nearTint: 0.5,
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
