import { createRenderer } from "./render/renderer.ts";
import { createScene } from "./render/scene.ts";
import { clientToWorld } from "./render/view.ts";
import { installHarness, parseBackendParam, type GameState } from "./harness.ts";
import { BLOB, BLOB_STRIDE, createBlobBuffer } from "./sim/blobBuffer.ts";

const state: GameState = { backend: null, frame: 0, ready: false };

installHarness({
  getState: () => ({ ...state }),
});

const DEMO_CLOUDS = [
  { x: -3.6, y: 0.8, blobs: 30, w: 1.9 },
  { x: 3.2, y: -2.4, blobs: 30, w: 2.2 },
  { x: 0.2, y: 2.9, blobs: 30, w: 1.6 },
] as const;

// TEMPORARY: synthetic blobs until the sim is wired in. Delete this function and its call.
function demoBlobs(buf: Float32Array, t: number): number {
  let n = 0;
  DEMO_CLOUDS.forEach((cloud, cloudId) => {
    for (let i = 0; i < cloud.blobs; i++) {
      // Deterministic pseudo-random layout: a flat-bottomed heap of overlapping blobs.
      const a = Math.sin((i + 1) * 12.9898 + cloudId * 78.233) * 43758.5453;
      const b = Math.sin((i + 1) * 39.346 + cloudId * 11.135) * 24634.6345;
      const ra = a - Math.floor(a);
      const rb = b - Math.floor(b);
      const u = (i + ra * 0.6) / cloud.blobs;
      const px = (u - 0.5) * 2 * cloud.w;
      const dome = Math.sqrt(Math.max(0, 1 - (px / cloud.w) ** 2));
      const py = dome * (0.05 + rb * rb * 1.5);
      const wob = 0.06;
      const o = n * BLOB_STRIDE;
      buf[o + BLOB.x] = cloud.x + px + Math.sin(t * 0.7 + i * 1.7) * wob;
      buf[o + BLOB.y] = cloud.y + py + Math.cos(t * 0.9 + i * 2.3) * wob;
      buf[o + BLOB.radius] = 0.28 + 0.55 * dome * ra * ra;
      buf[o + BLOB.mass] = 1;
      buf[o + BLOB.vx] = 0;
      buf[o + BLOB.vy] = 0;
      buf[o + BLOB.cloudId] = cloudId;
      buf[o + BLOB.alive] = 1;
      n++;
    }
  });
  return n;
}

async function main(): Promise<void> {
  const canvasHost = document.getElementById("app");
  if (!canvasHost) {
    throw new Error("Missing #app element");
  }

  const { renderer, backend } = await createRenderer(canvasHost, {
    forceWebGL: parseBackendParam(location.search),
  });
  renderer.domElement.style.touchAction = "none";

  const scene = await createScene(renderer);
  window.addEventListener("resize", () => scene.resize(window.innerWidth, window.innerHeight));

  // TEMPORARY: the real cursor comes from the input layer; this circles slowly.
  const pointer = { x: 0, y: 0, active: false };
  window.addEventListener("pointermove", (e) => {
    const w = clientToWorld(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    pointer.x = w.x;
    pointer.y = w.y;
    pointer.active = true;
  });

  const blobs = createBlobBuffer();

  state.backend = backend;
  state.ready = true;

  renderer.setAnimationLoop((ms) => {
    const t = ms / 1000;
    const count = demoBlobs(blobs, t);
    scene.setBlobs(blobs, count);
    scene.setCursor(pointer.active ? pointer : { x: Math.cos(t * 0.5) * 3.5, y: Math.sin(t * 0.5) * 2.5 });
    scene.setTime(t);
    scene.render();
    state.frame += 1;
  });
}

void main();
