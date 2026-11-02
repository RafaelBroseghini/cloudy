// Thunder voice choice for one strike: which file, how fast, how loud, how dull. Pure, from the record alone.
import { D_MAX, D_MIN } from './scheduler.ts'

export const MAX_VOICES = 3
export const RATE_MIN = 0.85
export const RATE_MAX = 1.1

export interface ThunderVoice {
  /** Index into the file list (0 when there are none). */
  readonly file: number
  readonly rate: number
  readonly gain: number
  /** Low-pass cutoff (Hz): further strikes are duller. */
  readonly lowpassHz: number
}

export function thunderVoice(s: { readonly d: number; readonly intensity: number; readonly pick: number; readonly pitch: number }, fileCount: number): ThunderVoice {
  const far = Math.min(1, Math.max(0, (s.d - D_MIN) / (D_MAX - D_MIN)))
  const u = Math.min(1, Math.max(0, s.pitch))
  return {
    file: fileCount > 0 ? Math.min(fileCount - 1, Math.floor(Math.min(0.999999, Math.max(0, s.pick)) * fileCount)) : 0,
    rate: RATE_MIN + (RATE_MAX - RATE_MIN) * u,
    gain: 0.2 + 0.8 * Math.min(1, Math.max(0, s.intensity)) ** 1.5,
    lowpassHz: 1200 + 14800 * (1 - far) ** 2,
  }
}
