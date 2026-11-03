// GPU frame-time probe for the harness (`__GAME__.bench`) and for measuring tiers. Waits for the queue to drain after each
// batch of frames, so it times the GPU, not the CPU's submit. Nothing is read back: WebGPU uses onSubmittedWorkDone,
// WebGL2 polls a fence (gl.finish() does not block in Chrome).

import type { WebGPURenderer } from "three/webgpu";

interface WebGPUBackendLike {
  isWebGPUBackend?: boolean;
  device?: { queue: { onSubmittedWorkDone(): Promise<void> } };
  gl?: WebGL2RenderingContext;
}

/** Resolves once everything submitted so far has finished on the GPU. */
export function createGpuSync(renderer: WebGPURenderer): () => Promise<void> {
  const backend = renderer.backend as unknown as WebGPUBackendLike;
  return async () => {
    if (backend.device) {
      await backend.device.queue.onSubmittedWorkDone();
      return;
    }
    const gl = backend.gl;
    if (!gl) return;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!fence) return;
    while (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) await yieldToEventLoop();
    gl.deleteSync(fence);
  };
}

/** A macrotask without the 4 ms setTimeout clamp. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

export interface BenchResult {
  frames: number;
  median: number;
  min: number;
  p90: number;
}

/** Time `frame()` in batches (so one sync amortises over `batch` frames); returns per-frame milliseconds. */
export async function benchFrames(frame: () => void, sync: () => Promise<void>, frames = 60, batch = 6): Promise<BenchResult> {
  await sync();
  const times: number[] = [];
  for (let b = 0; b < Math.max(1, Math.floor(frames / batch)); b++) {
    const t = performance.now();
    for (let i = 0; i < batch; i++) frame();
    await sync();
    times.push((performance.now() - t) / batch);
  }
  times.sort((a, b) => a - b);
  const r = (v: number): number => Math.round(v * 100) / 100;
  return { frames: times.length * batch, median: r(times[times.length >> 1] ?? 0), min: r(times[0] ?? 0), p90: r(times[Math.floor(times.length * 0.9)] ?? 0) };
}
