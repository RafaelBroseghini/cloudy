import type { FieldKey, Layer, P, WeatherReport, WeatherState } from "./params/index.ts";
import type { StrikeForce, StrikeReport } from "./strikes/index.ts";
import type { TierName } from "./render/tier.ts";
import { CLOUD_TYPES, summarizeClouds, type CloudType, type Params, type SceneName } from "./sim/index.ts";

export interface GameState {
  ready: boolean;
  backend: "webgpu" | "webgl2" | null;
  /** Render quality tier: resolution scales and light-march steps only; gameplay is identical on every tier. */
  tier: TierName;
  /** Rendered frames. */
  frame: number;
  /** Fixed sim steps run since the last scene load. */
  step: number;
  paused: boolean;
  clouds: number;
  /** Clouds by dominant type (a mixed cloud counts once, as the type most of its blobs have). Sums to `clouds`. */
  types: Record<CloudType, number>;
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
  /** Dominant type: the type most of the cloud's blobs have. */
  type: CloudType;
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
  /** `"m1" | "empty" | "clear" | "rain" | "thunder" | "mixed"`: the last four are compositions of cumulus, stratus and cumulonimbus. */
  loadScene(name: SceneName): void;
  /** Blend to `state` over `seconds` of weather time (0 = at once). Weather time advances with sim steps. */
  setWeather(state: WeatherState, seconds: number): void;
  /** Fire a strike now. `intensity` 0..1, `d` seconds from flash to thunder, `x` 0..1 across the screen; missing fields are drawn. */
  forceStrike(o?: StrikeForce): StrikeReport;
  /** The current flash value (0..1), read off the strike clock. */
  flash(): number;
  /** Freeze the latest strike's flash at `tau` seconds from its peak (negative = during the rise); null releases. For screenshots. */
  holdFlash(tau: number | null): void;
  /** Switch the render quality tier now (`hi` | `mid` | `low`): resizes the render targets and sets step counts; compiles nothing. */
  setTier(tier: TierName): void;
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

/** Mass-weighted centre, blob count and dominant type of each live cloud in a blob buffer, ordered by id. */
export function cloudCentresFromBuffer(buf: Float32Array, count: number): CloudCentre[] {
  return summarizeClouds(buf, count).map(({ id, x, y, blobs, type }) => ({ id, x, y, blobs, type }));
}

/** Clouds per dominant type. */
export function typeCounts(buf: Float32Array, count: number): Record<CloudType, number> {
  const out = Object.fromEntries(CLOUD_TYPES.map((t) => [t, 0])) as Record<CloudType, number>;
  for (const c of summarizeClouds(buf, count)) out[c.type] += 1;
  return out;
}
