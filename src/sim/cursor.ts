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
 * Backward-Euler step of m a = k_p (ptr - x) + c_p (v_ptr - v) - k_r rho v. The damper acts on the velocity relative to the
 * pointer, so in free space (rho = 0) the cursor settles onto a moving pointer with no steady lag; the only lag left is
 * k_r rho v / k_p, i.e. the density drag. The spring term is implicit too, so a very stiff k_p stays stable at 60 Hz and a
 * large k_r * rho slows the cursor without flipping the sign of its velocity.
 */
export function stepCursor(
  s: CursorState,
  ptr: Pointer,
  ptrVel: { readonly x: number; readonly y: number },
  p: CursorParams,
  rho: number,
  dt: number,
): CursorState {
  if (ptr.kind === 'absent') return { x: s.x, y: s.y, vx: 0, vy: 0 }
  const m = p.m_c
  const denom = m / dt + p.k_p * dt + p.c_p + p.k_r * rho
  let vx = ((m / dt) * s.vx + p.k_p * (ptr.x - s.x) + p.c_p * ptrVel.x) / denom
  let vy = ((m / dt) * s.vy + p.k_p * (ptr.y - s.y) + p.c_p * ptrVel.y) / denom
  const sp = Math.hypot(vx, vy)
  if (sp > p.cursorMaxSpeed) {
    const f = p.cursorMaxSpeed / sp
    vx *= f
    vy *= f
  }
  return { x: s.x + dt * vx, y: s.y + dt * vy, vx, vy }
}
