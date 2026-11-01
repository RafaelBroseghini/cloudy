// Shape matching per cloud: goal g_i = centroid + R q_i, with q_i the rest offsets and R the best-fit rotation (2D closed form).

export interface ShapeData {
  readonly px: Float64Array
  readonly py: Float64Array
  readonly mass: Float64Array
  /** Rest offsets from the cloud's mass-weighted centroid. */
  readonly qx: Float64Array
  readonly qy: Float64Array
}

/** Store current offsets from the centroid as the rest shape. Call on load, split and merge. */
export function computeRestOffsets(members: readonly number[], d: ShapeData): void {
  let m = 0
  let cx = 0
  let cy = 0
  for (const i of members) {
    const mi = d.mass[i] ?? 0
    m += mi
    cx += mi * (d.px[i] ?? 0)
    cy += mi * (d.py[i] ?? 0)
  }
  if (m === 0) return
  cx /= m
  cy /= m
  for (const i of members) {
    d.qx[i] = (d.px[i] ?? 0) - cx
    d.qy[i] = (d.py[i] ?? 0) - cy
  }
}

/**
 * Add the shape-matching velocity nudge alpha * (g_i - p_i) / dt to dvx/dvy for every member.
 * Mass-weighted centroid and a mass-independent nudge conserve the cloud's linear momentum.
 * Returns the goal-error potential sum(0.5 * m * (alpha / dt^2) * |g - p|^2), used for energy bookkeeping.
 */
export function shapeMatchNudge(
  members: readonly number[],
  d: ShapeData,
  alpha: number,
  dt: number,
  dvx: Float64Array,
  dvy: Float64Array,
): number {
  if (members.length < 2) return 0
  let m = 0
  let cx = 0
  let cy = 0
  for (const i of members) {
    const mi = d.mass[i] ?? 0
    m += mi
    cx += mi * (d.px[i] ?? 0)
    cy += mi * (d.py[i] ?? 0)
  }
  cx /= m
  cy /= m
  let sc = 0
  let ss = 0
  for (const i of members) {
    const mi = d.mass[i] ?? 0
    const rx = (d.px[i] ?? 0) - cx
    const ry = (d.py[i] ?? 0) - cy
    const qx = d.qx[i] ?? 0
    const qy = d.qy[i] ?? 0
    sc += mi * (qx * rx + qy * ry)
    ss += mi * (qx * ry - qy * rx)
  }
  const cos = Math.cos(Math.atan2(ss, sc))
  const sin = Math.sin(Math.atan2(ss, sc))
  const k = alpha / dt
  let pe = 0
  for (const i of members) {
    const qx = d.qx[i] ?? 0
    const qy = d.qy[i] ?? 0
    const ex = cx + cos * qx - sin * qy - (d.px[i] ?? 0)
    const ey = cy + sin * qx + cos * qy - (d.py[i] ?? 0)
    dvx[i] = (dvx[i] ?? 0) + k * ex
    dvy[i] = (dvy[i] ?? 0) + k * ey
    pe += 0.5 * (d.mass[i] ?? 0) * (alpha / (dt * dt)) * (ex * ex + ey * ey)
  }
  return pe
}
