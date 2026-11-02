import type { FieldKey, Layer, P, WeatherReport, WeatherState } from "./params/index.ts";
import type { StrikeForce, StrikeReport } from "./strikes/index.ts";
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
  /** Weather state machine: steady (progress 1) or a blend `from` -> `to` (progress 0..1, linear in time). */
  weather: WeatherReport;
  /** Resolved `rainRate` (0..1) right now. */
  rainRate: number;
  /** AudioContext `state` ("none" until the first gesture) and its output latency in seconds (null if unknown). */
  audio: { state: string; outputLatency: number | null };
  /** Strikes fired so far and the latest one's record. */
  strikes: { count: number; last: StrikeReport | null };
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
  /** Blend to `state` over `seconds` of weather time (0 = at once). Weather time advances with sim steps. */
  setWeather(state: WeatherState, seconds: number): void;
  /** Fire a strike now. `intensity` 0..1, `d` seconds from flash to thunder, `x` 0..1 across the screen; missing fields are drawn. */
  forceStrike(o?: StrikeForce): StrikeReport;
  /** The current flash value (0..1), read off the strike clock. */
  flash(): number;
  /** Freeze the latest strike's flash at `tau` seconds from its peak (negative = during the rise); null releases. For screenshots. */
  holdFlash(tau: number | null): void;
  /** The full flat resolved parameter record (numbers), as the game sees it now. */
  resolved(): P;
  /** Dev layer (above weather and user, below the strike flash; any field, interaction included): set overrides, clamped to each field's range. */
  setDev(partial: Layer): void;
  /** Remove dev overrides for `keys` (all when omitted); those fields fall back to weather/scene/defaults. */
  clearDev(keys?: FieldKey[]): void;
  /** The current dev overrides (a copy, as stored: range-clamped; the gate gap is applied only in `resolved()`). */
  getDev(): Layer;
  /** The sim's interaction params: the resolved weather values (or what `setParams` last wrote). */
  getParams(): Params;
  setParams(partial: Partial<Params>): void;
  cloudCentres(): CloudCentre[];
  /** Sim density at a world point (what the renderer draws as cloud). */
  densityAt(x: number, y: number): number;
  /** Shared density constants: the edge threshold the renderer shades around, and the blob influence factor. */
  constants(): { cloudThreshold: number; influenceFactor: number };
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
