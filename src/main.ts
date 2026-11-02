import { createAudioEngine, installUnlock } from "./audio/engine.ts";
import { installDevPanel, isTypingTarget } from "./dev/toggle.ts";
import { createPointerInput } from "./input/pointer.ts";
import { createDriveRunner, parseWeatherParam, reportWeather, sceneForWeather, WEATHER_STATES } from "./params/index.ts";
import { flashLayer, createStrikeDirector, nimbusAnchors } from "./strikes/index.ts";
import { applyLook } from "./render/look.ts";
import { createRenderer } from "./render/renderer.ts";
import { createScene } from "./render/scene.ts";
import { VIEW_HEIGHT, viewWidth } from "./render/view.ts";
import {
  cloudCentresFromBuffer,
  installHarness,
  typeCounts,
  parseBackendParam,
  type GameHarnessApi,
} from "./harness.ts";
import { CLOUD_THRESHOLD, createBlobBuffer, createSim, INFLUENCE_FACTOR, FIXED_DT, summarizeClouds, type Pointer, type SceneName } from "./sim/index.ts";
import { createFixedStepper } from "./sim/fixedStep.ts";

/** Render at most this often; the sim's fixed step already decouples behaviour from display rate. */
const RENDER_INTERVAL_MS = 1000 / 60;
/** rAF timestamps jitter by a ms or so; without slack a 60 Hz display would skip every other frame. */
const RENDER_SLACK_MS = 2;
/** Dev shortcut: keys 1..4 blend to clear, rain, thunder, tornado over this many seconds. */
const KEY_TRANSITION_S = 4;
/** Seed of the strike process: a run replays the same strikes for a seed. */
const STRIKE_SEED = 20260;

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
  // The opening scene matches the weather it opens in; switching weather later does not respawn clouds.
  const initialWeather = parseWeatherParam(location.search);
  loadScene(sceneForWeather(initialWeather));

  // Resize refits the camera, field and containment rect; clouds keep their world positions (no scene reload).
  const fitView = (): void => {
    scene.resize(window.innerWidth, window.innerHeight);
    sim.setBounds(viewWidth(window.innerWidth / window.innerHeight), VIEW_HEIGHT);
  };
  window.addEventListener("resize", fitView);
  fitView();

  // Weather: the drive resolves P (defaults + scene + weather) and pushes interaction params and wind to the sim.
  const drive = createDriveRunner(sim, {}, initialWeather);

  // Lightning: one strike record feeds the flash (transient layer, post-FX only) and the thunder (Web Audio).
  const audio = createAudioEngine(import.meta.env.BASE_URL);
  installUnlock(audio);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const strikes = createStrikeDirector(STRIKE_SEED, {
    clocks: audio.clocks,
    latency: audio.latency,
    currentTime: audio.currentTime,
    thunder: audio.thunder,
    reducedMotion: () => reducedMotion.matches,
    // Lightning starts in the storm towers on screen (none on screen: the strike keeps its own x).
    anchors: () => nimbusAnchors(summarizeClouds(blobs, sim.writeBlobs(blobs)), viewWidth(window.innerWidth / window.innerHeight), VIEW_HEIGHT),
  });
  let flashValue = 0;
  let flashX = 0.5;
  /** Per rendered frame: read the flash off the clock and write it to the transient layer, only while it changes. */
  const updateFlash = (): void => {
    const f = strikes.flash();
    if (f.value === flashValue && (f.value === 0 || f.x === flashX)) return;
    flashValue = f.value;
    flashX = f.x;
    drive.setLayers({ transient: flashLayer(f) });
  };
  const stepper = createFixedStepper();
  let lookP: unknown = null;
  /** CPU-side look push: uniforms only, and only when the resolved params changed. */
  const pushLook = (): void => {
    const p = drive.drive.p;
    if (p === lookP) return;
    lookP = p;
    applyLook(scene, p);
  };
  pushLook();
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    const state = WEATHER_STATES[Number(e.key) - 1];
    if (state) drive.setWeather(state, KEY_TRANSITION_S);
  }, true); // capture: the dev panel's controls stop keydown bubbling, and 1..4 must still work with one focused

  let paused = false;
  let ready = false;
  let frame = 0;
  // Harness override of the live pointer; null means real input.
  let override: Pointer | null = null;

  const currentPointer = (): Pointer => override ?? input.read();

  /** Push the sim's current state to the renderer. */
  const present = (): void => {
    pushLook();
    scene.setBlobs(blobs, sim.writeBlobs(blobs));
    const c = sim.snapshot().cursor;
    scene.setCursor(c.present ? { x: c.x, y: c.y } : null);
    const air = sim.flowState();
    scene.setAir(air.x, air.y);
  };

  /** One fixed step of the world: weather time advances with the sim, so ticks and rAF stay in lockstep. */
  let simStepMs = 0;
  const stepWorld = (): void => {
    drive.step(FIXED_DT);
    strikes.step(FIXED_DT, drive.drive.p.strikesEnabled, drive.drive.p.strikeRate);
    const t0 = performance.now();
    sim.step();
    simStepMs += (performance.now() - t0 - simStepMs) * 0.05; // EMA for the dev panel's stats line
  };
  const stepFixed = (n: number): void => {
    for (let i = 0; i < n; i++) stepWorld();
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
        types: typeCounts(blobs, sim.writeBlobs(blobs)),
        blobs: s.blobs,
        springs: s.springs,
        cursor: { x: s.cursor.x, y: s.cursor.y, present: s.cursor.present },
        densityAtCursor: s.densityAtCursor,
        view: { width: viewWidth(window.innerWidth / window.innerHeight), height: VIEW_HEIGHT },
        weather: reportWeather(drive.drive.weather),
        rainRate: drive.drive.p.rainRate,
        audio: audio.report(),
        strikes: { count: strikes.count, last: strikes.last },
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
        stepWorld();
      }
      present();
    },
    loadScene(name) {
      loadScene(name);
      stepper.reset();
      present();
    },
    setWeather(state, seconds) {
      drive.setWeather(state, seconds);
      present();
    },
    forceStrike(o) {
      const rec = strikes.force(o);
      updateFlash();
      present();
      return rec;
    },
    flash: () => strikes.flash().value,
    holdFlash(tau) {
      strikes.hold(tau);
      updateFlash();
      present();
    },
    resolved: () => ({ ...drive.drive.p }),
    setDev(partial) {
      drive.setDev(partial);
      present();
    },
    clearDev(keys) {
      drive.clearDev(keys);
      present();
    },
    getDev: () => ({ ...drive.drive.layers.dev }),
    getParams: () => sim.getParams(),
    setParams: (partial) => sim.setParams(partial),
    cloudCentres() {
      return cloudCentresFromBuffer(blobs, sim.writeBlobs(blobs));
    },
    densityAt: (x, y) => sim.densityAt(x, y),
    constants: () => ({ cloudThreshold: CLOUD_THRESHOLD, influenceFactor: INFLUENCE_FACTOR }),
  };
  installHarness(harness);
  installDevPanel({ api: harness, simStepMs: () => simStepMs });

  let lastMs: number | null = null;
  let lastRenderMs = -Infinity;

  renderer.setAnimationLoop((ms) => {
    const elapsed = lastMs === null ? 0 : (ms - lastMs) / 1000;
    lastMs = ms;

    // Pointer is drained every rAF, so a skipped render never drops input.
    sim.setPointer(currentPointer());
    if (!paused) stepper.advance(elapsed, stepWorld);

    if (ms - lastRenderMs < RENDER_INTERVAL_MS - RENDER_SLACK_MS) return;
    const renderDt = Number.isFinite(lastRenderMs) ? (ms - lastRenderMs) / 1000 : 0;
    lastRenderMs = ms;
    updateFlash();
    present();
    const ptr = currentPointer();
    scene.updateScenery(ptr.kind === "present" ? { x: ptr.x, y: ptr.y } : null, renderDt);
    scene.setTime(ms / 1000);
    scene.render();
    frame += 1;
  });

  ready = true;
}

void main();
