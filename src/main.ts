import * as THREE from "three/webgpu";
import { createRenderer } from "./render/renderer.ts";
import { installHarness, parseBackendParam, type GameState } from "./harness.ts";

const state: GameState = { backend: null, frame: 0, ready: false };

installHarness({
  getState: () => ({ ...state }),
});

async function main(): Promise<void> {
  const canvasHost = document.getElementById("app");
  if (!canvasHost) {
    throw new Error("Missing #app element");
  }

  const { renderer, backend } = await createRenderer(canvasHost, {
    forceWebGL: parseBackendParam(location.search),
  });
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#6fa8dc");

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;

  const onResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    const aspect = width / height;
    camera.left = -aspect;
    camera.right = aspect;
    camera.top = 1;
    camera.bottom = -1;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);
  onResize();

  state.backend = backend;
  state.ready = true;

  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    state.frame += 1;
  });
}

void main();
