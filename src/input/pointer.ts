// Pointer Events -> the sim's Pointer union. Primary pointer only.
// Mouse and pen are "present" while over the canvas; touch only while a finger is down.
// Events just record the latest client-space sample; conversion to world units happens once per frame in `read`.

import type { Pointer } from "../sim/index.ts";
import { clientToWorld } from "../render/view.ts";

export interface PointerInput {
  /** Latest pointer state in world units. Call once per frame. */
  read(): Pointer;
  dispose(): void;
}

export function createPointerInput(canvas: HTMLCanvasElement): PointerInput {
  let present = false;
  let cx = 0;
  let cy = 0;

  function sample(e: PointerEvent): void {
    // The latest coalesced sample is the freshest position; the sim takes one target per step anyway.
    // Never use getPredictedEvents: predicted points are guesses and must not reach the sim.
    const coalesced = e.getCoalescedEvents?.();
    const last = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : undefined;
    const s = last ?? e;
    cx = s.clientX;
    cy = s.clientY;
  }

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    sample(e);
    present = true;
  };
  const onMove = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    // A touch pointer only generates moves while down, so this cannot make a lifted finger present.
    sample(e);
    present = true;
  };
  // Touch fires pointerenter just before pointerdown; the finger is not "down" yet, so ignore it.
  const onEnter = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") onMove(e);
  };
  const onUp = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    if (e.pointerType === "touch") present = false;
  };
  const onCancel = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    present = false;
  };
  const onLeave = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    present = false;
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerenter", onEnter);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);

  const world = { x: 0, y: 0 };
  return {
    read() {
      if (!present) return { kind: "absent" };
      const r = canvas.getBoundingClientRect();
      clientToWorld(cx - r.left, cy - r.top, r.width, r.height, world);
      return { kind: "present", x: world.x, y: world.y };
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
    },
  };
}
