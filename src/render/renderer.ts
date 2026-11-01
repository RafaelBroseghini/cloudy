import { WebGPURenderer } from "three/webgpu";

export async function createRenderer(
  canvasHost: HTMLElement,
  opts: { forceWebGL: boolean },
): Promise<{ renderer: WebGPURenderer; backend: "webgpu" | "webgl2" }> {
  const renderer = new WebGPURenderer({
    antialias: true,
    forceWebGL: opts.forceWebGL,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvasHost.appendChild(renderer.domElement);
  await renderer.init();
  const backend: "webgpu" | "webgl2" = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? "webgpu"
    : "webgl2";
  return { renderer, backend };
}
