// Cursor dynamics: m_c a = F_intent - k_r rho v, with F_intent a damped spring toward the pointer.
// Pure: takes density as input and has no wind parameter, so wind cannot reach the cursor by construction.

export type Pointer = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly x: number; readonly y: number }

export interface CursorState {
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
}

export interface CursorParams {
  readonly k_r: number
  readonly m_c: number
  readonly k_p: number
  readonly c_p: number
  readonly cursorMaxSpeed: number
}

/**
 * Semi-implicit step. Every velocity-proportional term (pointer damping and density drag) is treated implicitly,
 * so a large k_r * rho slows the cursor but can never flip the sign of its velocity.
 */
export function stepCursor(s: CursorState, ptr: Pointer, p: CursorParams, rho: number, dt: number): CursorState {
  if (ptr.kind === 'absent') return { x: s.x, y: s.y, vx: 0, vy: 0 }
  const ax = (p.k_p * (ptr.x - s.x)) / p.m_c
  const ay = (p.k_p * (ptr.y - s.y)) / p.m_c
  const damp = (p.c_p + p.k_r * rho) / p.m_c
  const inv = 1 / (1 + dt * damp)
  let vx = (s.vx + dt * ax) * inv
  let vy = (s.vy + dt * ay) * inv
  const sp = Math.hypot(vx, vy)
  if (sp > p.cursorMaxSpeed) {
    const f = p.cursorMaxSpeed / sp
    vx *= f
    vy *= f
  }
  return { x: s.x + dt * vx, y: s.y + dt * vy, vx, vy }
}
