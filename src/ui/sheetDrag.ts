// Dragging the Sky panel open or shut (pure). The panel is anchored at the bottom, so dragging up opens it and dragging
// down folds it. While the pointer moves, the open part follows it 1:1; on release the panel snaps to whichever end it
// is past, or the way it was flicked, so a short quick swipe is enough and a slow drag back cancels.

/** Pointer travel (px) before a press on the header becomes a drag, so a click on the header's buttons stays a click. */
export const DRAG_SLOP = 6
/** Fraction of the travel past which a release snaps to the other state. */
export const SNAP_FRACTION = 0.3
/** Release speed (px/ms) that snaps toward the flick whatever the distance. */
export const FLING_SPEED = 0.45

/** How much of the panel's body (0..full px) shows when a drag that started `open` has moved `dy` px (down is positive). */
export function dragExtent(startOpen: boolean, full: number, dy: number): number {
  const shown = startOpen ? full - dy : -dy
  return Math.min(full, Math.max(0, shown))
}

/** Whether the panel ends open after a drag released at `dy` px, moving at `vy` px/ms (down is positive). */
export function releaseOpen(startOpen: boolean, full: number, dy: number, vy: number): boolean {
  if (vy <= -FLING_SPEED) return true
  if (vy >= FLING_SPEED) return false
  const moved = startOpen ? dy : -dy
  return moved > full * SNAP_FRACTION ? !startOpen : startOpen
}
