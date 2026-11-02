// Pure helpers for the dev panel (no DOM, no lil-gui), so the field -> control mapping is unit-testable.
import { FIELD_KEYS, FIELD_SPECS, srgbHexToLinear, type FieldKey, type Group, type Layer } from '../params/index.ts'

/** Linear-light channel to the sRGB-encoded 0..255 byte a colour picker shows (HDR values above 1 clip). */
export function linearToSrgbByte(c: number): number {
  const x = Math.min(1, Math.max(0, c))
  const e = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055
  return Math.round(e * 255)
}

/** Linear RGB to `#rrggbb` for display. Inverse of `srgbHexToLinear` (to 8-bit precision, inside 0..1). */
export function linearToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => linearToSrgbByte(c).toString(16).padStart(2, '0')).join('')}`
}

export { srgbHexToLinear }

/** Slider step for a range: a power of ten near range/200 (k_s 5..400 -> 1, 0..1 -> 0.001, 0..2 -> 0.01). */
export function stepFor(min: number, max: number): number {
  const raw = (max - min) / 200
  if (!(raw > 0)) return 1
  return 10 ** Math.floor(Math.log10(raw))
}

export type Row =
  | { readonly kind: 'number'; readonly key: FieldKey; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'color'; readonly name: string; readonly keys: readonly [FieldKey, FieldKey, FieldKey] }

export interface GroupRows {
  readonly group: Group
  readonly rows: readonly Row[]
}

/** `<name>R/G/B` present together in one group is one colour; anything else is a number field. */
function triplet(key: FieldKey): readonly [FieldKey, FieldKey, FieldKey] | null {
  if (!key.endsWith('R')) return null
  const base = key.slice(0, -1)
  const g = `${base}G` as FieldKey
  const b = `${base}B` as FieldKey
  const spec = FIELD_SPECS[key]
  if (!(g in FIELD_SPECS) || !(b in FIELD_SPECS)) return null
  return FIELD_SPECS[g].group === spec.group && FIELD_SPECS[b].group === spec.group ? [key, g, b] : null
}

/** Every field of FIELD_SPECS as rows, grouped in first-appearance order. New fields appear without touching this file. */
export function buildRows(): GroupRows[] {
  const used = new Set<FieldKey>()
  const groups = new Map<Group, Row[]>()
  for (const key of FIELD_KEYS) {
    if (used.has(key)) continue
    const spec = FIELD_SPECS[key]
    const rows = groups.get(spec.group) ?? []
    groups.set(spec.group, rows)
    const t = triplet(key)
    if (t) {
      for (const k of t) used.add(k)
      rows.push({ kind: 'color', name: key.slice(0, -1), keys: t })
    } else {
      used.add(key)
      const step = spec.kind === 'step' ? 1 : stepFor(spec.min, spec.max)
      rows.push({ kind: 'number', key, min: spec.min, max: spec.max, step })
    }
  }
  return [...groups].map(([group, rows]) => ({ group, rows }))
}

/** The overrides as paste-ready JSON: field order of FIELD_SPECS, values rounded to 5 significant digits. */
export function overridesJson(dev: Layer): string {
  const out: Record<string, number> = {}
  for (const k of FIELD_KEYS) {
    const v = dev[k]
    if (typeof v === 'number') out[k] = Number(v.toPrecision(5))
  }
  return JSON.stringify(out, null, 2)
}

/** True when the resolved value differs from the stored override: the gate gap clamp kicked in. */
export function isClamped(dev: Layer, resolved: Readonly<Record<FieldKey, number>>, key: FieldKey): boolean {
  const v = dev[key]
  return typeof v === 'number' && Math.abs(v - resolved[key]) > 1e-9
}
