// Density kernel and cursor drag. Pure functions, no wasm.

import { DENSITY_REF_RADIUS, INFLUENCE_FACTOR } from './blobBuffer.ts'

export function influenceRadius(colliderRadius: number): number {
  return INFLUENCE_FACTOR * colliderRadius
}

/** W(q) = (1 - q^2)^3 for q < 1, else 0. Smooth, compact, W(0) = 1. */
export function kernelW(q: number): number {
  if (!(q < 1)) return 0
  const t = 1 - q * q
  return t * t * t
}

/** One blob's contribution m * (DENSITY_REF_RADIUS / r)^2 * W(d / R) at distance d, so density is invariant to layout scale. */
export function blobDensity(mass: number, dist: number, colliderRadius: number): number {
  return mass * (DENSITY_REF_RADIUS / colliderRadius) ** 2 * kernelW(dist / influenceRadius(colliderRadius))
}

/** Drag force on the cursor: -k_r * rho * v. Non-decreasing in rho, zero at rho = 0, opposes v. */
export function dragForce(kr: number, rho: number, vx: number, vy: number): { x: number; y: number } {
  const s = kr * rho
  // `|| 0` avoids -0 when v = 0 or s = 0.
  return { x: -s * vx || 0, y: -s * vy || 0 }
}
