// Ambient air for the play clouds: a steady prevailing drift plus slowly evolving 2D curl noise. Pure and deterministic.
//
// Noise: `simplex-noise` (3D simplex, seeded with our own PRNG) rather than hand-rolled value noise, per the project
// rule. Its (x, y, phase) input gives a smooth scalar potential psi that evolves with `phase`.
// The velocity is the curl of psi, u = (dpsi/dy, -dpsi/dx), so the turbulence is divergence-free: it swirls and shears
// clouds but never piles them up or thins them out. The tornado's vortex can reuse `curl` and `Flow` as is.

import { createNoise3D } from 'simplex-noise'
import { mulberry32 } from './scene.ts'

export interface FlowParams {
  /** Prevailing drift speed (units/s). */
  readonly speed: number
  /** Prevailing direction (radians, 0 = +x/right, counter-clockwise, y up). */
  readonly angle: number
  /** RMS speed of the curl noise (units/s). */
  readonly turbulence: number
  /** Eddy height (units): the noise wavelength across the flow. Eddies are EDDY_STRETCH times wider. */
  readonly scale: number
  /** Evolution rate: noise lattice cells swept per second along the phase axis (about 1 / eddy lifetime in s). */
  readonly rate: number
}

export interface Vec2 {
  x: number
  y: number
}

/** Central-difference step as a fraction of the noise scale. */
const CURL_STEP = 0.02
/**
 * Eddies are this many times wider than tall, so the turbulence is mostly horizontal shear (streaky, like banded winds).
 * Isotropic eddies carried clouds up and down by whole rows within minutes and merged them; this keeps rows apart.
 */
export const EDDY_STRETCH = 2.5
/** RMS of one component of the curl of unit-scale 3D simplex noise (measured over 200k samples: |curl| is 2.46, so 2.46 / sqrt 2). */
export const CURL_COMPONENT_RMS = 1.74
/** RMS speed of the curl at amplitude 1 and scale 1, so `turbulence` is the RMS speed. */
export const CURL_RMS = CURL_COMPONENT_RMS * Math.sqrt(1 + 1 / (EDDY_STRETCH * EDDY_STRETCH))

/** Curl of a scalar potential by central differences: (dpsi/dy, -dpsi/dx). Divergence is zero to O(h^2) for smooth psi. */
export function curl(psi: (x: number, y: number) => number, x: number, y: number, h: number, out: Vec2): Vec2 {
  out.x = (psi(x, y + h) - psi(x, y - h)) / (2 * h)
  out.y = -(psi(x + h, y) - psi(x - h, y)) / (2 * h)
  return out
}

export interface Flow {
  setParams(p: FlowParams): void
  /** Advance the stored phase and air offset by dt of sim time. Integrated (not `t * rate`), so changing params never jumps the field. */
  advance(dt: number): void
  /** Air velocity (prevailing + curl) at a world point. Writes into and returns `out`. */
  sample(x: number, y: number, out: Vec2): Vec2
  /** Turbulence only (divergence-free). */
  curlAt(x: number, y: number, out: Vec2): Vec2
  /** Prevailing velocity (units/s). */
  readonly mean: Readonly<Vec2>
  /** Distance the air has travelled since reset: eddies ride along, and the renderer anchors cloud noise to it. */
  readonly offset: Readonly<Vec2>
  readonly phase: number
  reset(): void
}

const OFF: FlowParams = { speed: 0, angle: 0, turbulence: 0, scale: 6, rate: 0 }

export function createFlow(seed = 7): Flow {
  const noise = createNoise3D(mulberry32(seed))
  let p = OFF
  let phase = 0
  const offset: Vec2 = { x: 0, y: 0 }
  const mean: Vec2 = { x: 0, y: 0 }
  // psi(x, y) at the current phase, in the frame that rides with the air.
  const psi = (x: number, y: number): number => noise((x - offset.x) / (p.scale * EDDY_STRETCH), (y - offset.y) / p.scale, phase)

  const flow: Flow = {
    setParams(next) {
      p = { ...next, scale: Math.max(0.1, next.scale) }
      mean.x = p.speed * Math.cos(p.angle)
      mean.y = p.speed * Math.sin(p.angle)
    },
    advance(dt) {
      phase += p.rate * dt
      offset.x += mean.x * dt
      offset.y += mean.y * dt
    },
    curlAt(x, y, out) {
      if (p.turbulence === 0) {
        out.x = 0
        out.y = 0
        return out
      }
      curl(psi, x, y, CURL_STEP * p.scale, out)
      // psi = A N(x / (k scale), y / scale): its curl has RMS A CURL_RMS / scale.
      const g = (p.turbulence * p.scale) / CURL_RMS
      out.x *= g
      out.y *= g
      return out
    },
    sample(x, y, out) {
      flow.curlAt(x, y, out)
      out.x += mean.x
      out.y += mean.y
      return out
    },
    mean,
    offset,
    get phase() {
      return phase
    },
    reset() {
      phase = 0
      offset.x = 0
      offset.y = 0
    },
  }
  return flow
}
