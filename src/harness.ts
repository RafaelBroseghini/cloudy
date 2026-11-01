import { BLOB, BLOB_STRIDE, type Params, type SceneName } from "./sim/index.ts";

export interface GameState {
  ready: boolean;
  backend: "webgpu" | "webgl2" | null;
  /** Rendered frames. */
  frame: number;
  /** Fixed sim steps run since the last scene load. */
  step: number;
  paused: boolean;
  clouds: number;
  blobs: number;
  springs: number;
  /** The sim cursor (what is drawn), in world units. */
  cursor: { x: number; y: number; present: boolean };
  densityAtCursor: number;
  /** Visible world size in units. */
  view: { width: number; height: number };
}

export interface CloudCentre {
  id: number;
  x: number;
  y: number;
  blobs: number;
}

export interface GameHarnessApi {
  getState(): GameState;
  /** While paused the rAF loop renders but does not advance the sim. */
  pause(on: boolean): void;
  /** Advance exactly round(ms / (1000 / 60)) fixed steps synchronously; works while paused. */
  tick(ms: number): void;
  /** Override the live pointer (world units) until `pointerRelease`. */
  pointer(x: number, y: number): void;
  /** Override the live pointer with "absent" until `pointerRelease`. */
  pointerAbsent(): void;
  /** Hand pointer control back to real input. */
  pointerRelease(): void;
  /** Move the overridden pointer linearly over `seconds` of fixed steps, stepping the sim. Leaves the pointer at the end point. */
  drag(x0: number, y0: number, x1: number, y1: number, seconds: number): void;
  loadScene(name: SceneName): void;
  getParams(): Params;
  setParams(partial: Partial<Params>): void;
  cloudCentres(): CloudCentre[];
}

declare global {
  interface Window {
    __GAME__?: GameHarnessApi;
  }
}

export function installHarness(api: GameHarnessApi): void {
  window.__GAME__ = api;
}

export function parseBackendParam(search: string): boolean {
  return new URLSearchParams(search).get("backend") === "webgl";
}

/** Mass-weighted centre of each live cloud in a blob buffer, ordered by id. */
export function cloudCentresFromBuffer(buf: Float32Array, count: number): CloudCentre[] {
  const acc = new Map<number, { sx: number; sy: number; m: number; n: number }>();
  for (let i = 0; i < count; i++) {
    const o = i * BLOB_STRIDE;
    if ((buf[o + BLOB.alive] ?? 0) === 0) continue;
    const id = buf[o + BLOB.cloudId] ?? 0;
    const m = buf[o + BLOB.mass] ?? 1;
    const a = acc.get(id) ?? { sx: 0, sy: 0, m: 0, n: 0 };
    a.sx += (buf[o + BLOB.x] ?? 0) * m;
    a.sy += (buf[o + BLOB.y] ?? 0) * m;
    a.m += m;
    a.n += 1;
    acc.set(id, a);
  }
  return [...acc]
    .map(([id, a]) => ({ id, x: a.sx / a.m, y: a.sy / a.m, blobs: a.n }))
    .sort((p, q) => p.id - q.id);
}
