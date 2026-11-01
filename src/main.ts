import { createPointerInput } from "./input/pointer.ts";
import { createRenderer } from "./render/renderer.ts";
import { createScene } from "./render/scene.ts";
import { VIEW_HEIGHT, viewWidth } from "./render/view.ts";
import {
  cloudCentresFromBuffer,
  installHarness,
  parseBackendParam,
  type GameHarnessApi,
} from "./harness.ts";
import { createBlobBuffer, createSim, FIXED_DT, type Pointer, type SceneName } from "./sim/index.ts";

/** Render at most this often; the sim's fixed step already decouples behaviour from display rate. */
const RENDER_INTERVAL_MS = 1000 / 60;
/** rAF timestamps jitter by a ms or so; without slack a 60 Hz display would skip every other frame. */
const RENDER_SLACK_MS = 2;

async function main(): Promise<void> {
  const canvasHost = document.getElementById("app");
  if (!canvasHost) {
    throw new Error("Missing #app element");
  }

  const { renderer, backend } = await createRenderer(canvasHost, {
    forceWebGL: parseBackendParam(location.search),
  });
  const canvas = renderer.domElement;
  canvas.style.touchAction = "none";

  const scene = await createScene(renderer);
  const sim = await createSim();
  const input = createPointerInput(canvas);
  const blobs = createBlobBuffer();

  const loadScene = (name: SceneName): void => {
    sim.loadScene(name, viewWidth(window.innerWidth / window.innerHeight), VIEW_HEIGHT);
  };
  loadScene("m1");

  // Resize only refits the camera and field; clouds keep their world positions (no scene reload).
  window.addEventListener("resize", () => scene.resize(window.innerWidth, window.innerHeight));

  let paused = false;
  let ready = false;
  let frame = 0;
  // Harness override of the live pointer; null means real input.
  let override: Pointer | null = null;

  const currentPointer = (): Pointer => override ?? input.read();

  /** Push the sim's current state to the renderer. */
  const present = (): void => {
    scene.setBlobs(blobs, sim.writeBlobs(blobs));
    const c = sim.snapshot().cursor;
    scene.setCursor(c.present ? { x: c.x, y: c.y } : null);
  };

  const stepFixed = (n: number): void => {
    for (let i = 0; i < n; i++) sim.step();
  };

  const harness: GameHarnessApi = {
    getState() {
      const s = sim.snapshot();
      return {
        ready,
        backend,
        frame,
        step: s.step,
        paused,
        clouds: s.clouds,
        blobs: s.blobs,
        springs: s.springs,
        cursor: { x: s.cursor.x, y: s.cursor.y, present: s.cursor.present },
        densityAtCursor: s.densityAtCursor,
        view: { width: viewWidth(window.innerWidth / window.innerHeight), height: VIEW_HEIGHT },
      };
    },
    pause(on) {
      paused = on;
    },
    tick(ms) {
      sim.setPointer(currentPointer());
      stepFixed(Math.max(0, Math.round(ms / (FIXED_DT * 1000))));
      present();
    },
    pointer(x, y) {
      override = { kind: "present", x, y };
    },
    pointerAbsent() {
      override = { kind: "absent" };
    },
    pointerRelease() {
      override = null;
    },
    drag(x0, y0, x1, y1, seconds) {
      const n = Math.max(1, Math.round(seconds / FIXED_DT));
      for (let i = 1; i <= n; i++) {
        const u = i / n;
        override = { kind: "present", x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u };
        sim.setPointer(override);
        sim.step();
      }
      present();
    },
    loadScene(name) {
      loadScene(name);
      present();
    },
    getParams: () => sim.getParams(),
    setParams: (partial) => sim.setParams(partial),
    cloudCentres() {
      return cloudCentresFromBuffer(blobs, sim.writeBlobs(blobs));
    },
  };
  installHarness(harness);

  let lastMs: number | null = null;
  let lastRenderMs = -Infinity;

  renderer.setAnimationLoop((ms) => {
    const elapsed = lastMs === null ? 0 : (ms - lastMs) / 1000;
    lastMs = ms;

    // Pointer is drained every rAF, so a skipped render never drops input.
    sim.setPointer(currentPointer());
    if (!paused) sim.advance(elapsed);

    if (ms - lastRenderMs < RENDER_INTERVAL_MS - RENDER_SLACK_MS) return;
    lastRenderMs = ms;
    present();
    scene.setTime(ms / 1000);
    scene.render();
    frame += 1;
  });

  ready = true;
}

void main();
