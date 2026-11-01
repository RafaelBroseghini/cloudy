export interface GameState {
  backend: "webgpu" | "webgl2" | null;
  frame: number;
  ready: boolean;
}

export interface GameHarnessApi {
  getState(): GameState;
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
