// The single place that defines the world <-> screen mapping.
// World: y-up, origin at screen centre, the visible play area is exactly VIEW_HEIGHT units tall.

import { OrthographicCamera } from "three/webgpu";

export const VIEW_HEIGHT = 10;

export function viewWidth(aspect: number): number {
  return VIEW_HEIGHT * aspect;
}

export function createViewCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
  fitViewCamera(camera, 1);
  return camera;
}

export function fitViewCamera(camera: OrthographicCamera, aspect: number): void {
  const halfW = viewWidth(aspect) / 2;
  const halfH = VIEW_HEIGHT / 2;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
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
