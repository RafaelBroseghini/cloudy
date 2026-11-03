// Render pacing (pure). The loop gets a callback per display refresh; rendering every one would double the GPU work on a
// 120 Hz screen for little gain, so it renders every `renderEvery(hz)`-th refresh: as often as it can without going over
// `TARGET_HZ` by a whole multiple. Frames stay evenly spaced on any screen. 60, 75 and 90 Hz render every refresh;
// 120 and 240 Hz settle at 60; 144 Hz at 72. A fixed 60 Hz time cap would instead skip every other refresh on any screen
// between about 68 and 120 Hz (90 Hz rendered 45 fps). The sim does not care: it runs on its own fixed step.

/** The rate a fast display is divided down toward. */
export const TARGET_HZ = 60;
/** Recent callback intervals the refresh estimate is the median of. */
const SAMPLES = 30;
/** Intervals needed before dividing at all; until then every callback renders. */
const MIN_SAMPLES = 10;
/** Intervals longer than this are a stall or a hidden tab, not the refresh period. */
const MAX_PERIOD_MS = 100;
/** Slack on the divisor, so a 120 Hz screen measured at 119.5 Hz still renders every other refresh. */
const DIVISOR_SLACK = 0.1;

/** Render every n-th refresh of a display at `hz` (n >= 1). */
export function renderEvery(hz: number): number {
  if (!(hz > 0)) return 1;
  return Math.max(1, Math.floor(hz / TARGET_HZ + DIVISOR_SLACK));
}

export interface Pacer {
  /** Called on every rAF callback at `ms`; true when this one should render. */
  frame(ms: number): boolean;
  /** The current divisor and the refresh period it was picked from (0 until estimated). */
  state(): { every: number; periodMs: number };
}

export function createPacer(): Pacer {
  const iv = new Float64Array(SAMPLES);
  let n = 0;
  let head = 0;
  let lastTick: number | null = null;
  let lastRender: number | null = null;
  let periodMs = 0;
  let every = 1;

  const estimate = (): void => {
    if (n < MIN_SAMPLES) return;
    const sorted = iv.slice(0, n).sort();
    periodMs = sorted[n >> 1]!;
    every = renderEvery(1000 / periodMs);
  };

  return {
    frame(ms) {
      if (lastTick !== null) {
        const d = ms - lastTick;
        if (d > 0 && d <= MAX_PERIOD_MS) {
          iv[head] = d;
          head = (head + 1) % SAMPLES;
          n = Math.min(SAMPLES, n + 1);
          estimate();
        }
      }
      lastTick = ms;
      // Half a period of slack: rAF timestamps jitter, and a late callback should still render rather than wait a whole one.
      const due = lastRender === null || every === 1 || ms - lastRender >= (every - 0.5) * periodMs;
      if (due) lastRender = ms;
      return due;
    },
    state: () => ({ every, periodMs }),
  };
}
