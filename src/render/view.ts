// The single place that defines the world <-> screen mapping. Pure: no three, no DOM.
// World: y-up, origin at screen centre, the visible play area is exactly VIEW_HEIGHT units tall.
// The play plane is z = 0. The volume pass looks at it through an off-axis perspective camera whose eye sits at
// (eye.x, eye.y, CAMERA_DISTANCE): the plane is fixed on screen whatever the eye does, so the mapping below never changes.

export const VIEW_HEIGHT = 10;
/** Vertical field of view of the volume camera. */
export const CAMERA_FOV_DEG = 30;
/** Largest eye shift (world units, each axis) the volume pass supports. */
export const EYE_MAX = 8;
/** Distance (world units) from the eye to the play plane: the plane is exactly VIEW_HEIGHT tall at this FOV (about 18.66). */
export const CAMERA_DISTANCE = VIEW_HEIGHT / 2 / Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

export function viewWidth(aspect: number): number {
  return VIEW_HEIGHT * aspect;
}

/** Client (CSS) pixels to world units, for a canvas covering `width` x `height` CSS pixels at the page origin. */
export function clientToWorld(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  out.x = (clientX / width - 0.5) * viewWidth(width / height);
  out.y = (0.5 - clientY / height) * VIEW_HEIGHT;
  return out;
}

/** Inverse of `clientToWorld`. */
export function worldToClient(
  x: number,
  y: number,
  width: number,
  height: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  out.x = (x / viewWidth(width / height) + 0.5) * width;
  out.y = (0.5 - y / VIEW_HEIGHT) * height;
  return out;
}
