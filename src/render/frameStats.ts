// Frame-time statistics for the `?stats` overlay and `getState().stats` (pure: no DOM, no three). It times the frames that
// are actually rendered, not rAF callbacks: the loop renders at most `RENDER_INTERVAL_MS` apart, so on a fast screen most
// callbacks draw nothing and a rAF counter would report the display's rate, not the game's. The display's rate is kept
// separately so a reader can tell a capped frame rate from a slow one.

/** How far back the percentiles look: PLAN's target is a p95 over 60 s. */
export const STATS_WINDOW_MS = 60_000;
/** How far back the headline fps looks, so it reacts within a second. */
export const FPS_WINDOW_MS = 1_000;
/** A render interval longer than this missed at least one 60 Hz deadline. */
export const LONG_FRAME_MS = (1000 / 60) * 1.5;
/** rAF intervals kept to estimate the display's refresh rate (a couple of seconds at 60 Hz). */
const RAF_SAMPLES = 120;
/** Render samples held; more than the window needs at the render cap, so the window, not the buffer, bounds it. */
const RENDER_CAPACITY = 8192;

export interface FrameStatsReport {
  /** Rendered frames per second over the last `FPS_WINDOW_MS` (0 until two renders). */
  fps: number;
  /** Render intervals in the window, and the window's span in seconds (under 60 just after load or a gap). */
  samples: number;
  windowS: number;
  /** Render interval percentiles and maximum over the window, in ms (0 with no samples). */
  p50: number;
  p95: number;
  worst: number;
  /** Fraction (0..1) of the window's render intervals longer than `LONG_FRAME_MS`. */
  long: number;
  /** p95 of the main-thread time spent in a rendering rAF callback (sim steps plus encoding the frame), ms. */
  cpuP95: number;
  /** The display's refresh rate from the median rAF interval, Hz (0 until enough callbacks). */
  displayHz: number;
}

export interface FrameStats {
  /** Every rAF callback, with its timestamp (ms). */
  tick(ms: number): void;
  /** A rendered frame at rAF time `ms`, which cost `cpuMs` of main-thread time. */
  render(ms: number, cpuMs: number): void;
  /** The next tick and render start fresh intervals: a hidden tab or a harness benchmark is not a slow frame. */
  gap(): void;
  report(): FrameStatsReport;
}

/** Nearest-rank percentile of an ascending array (q in 0..1). */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[i]!;
}

export function createFrameStats(): FrameStats {
  const rafIntervals = new Float64Array(RAF_SAMPLES);
  let rafCount = 0;
  let rafHead = 0;
  let lastTick: number | null = null;

  // Ring of renders: time, interval to the previous render, main-thread cost.
  const at = new Float64Array(RENDER_CAPACITY);
  const interval = new Float64Array(RENDER_CAPACITY);
  const cpu = new Float64Array(RENDER_CAPACITY);
  let head = 0; // next write
  let len = 0;
  let lastRender: number | null = null;

  const evict = (now: number): void => {
    while (len > 0 && at[(head - len + RENDER_CAPACITY) % RENDER_CAPACITY]! < now - STATS_WINDOW_MS) len--;
  };

  return {
    tick(ms) {
      if (lastTick !== null && ms > lastTick) {
        rafIntervals[rafHead] = ms - lastTick;
        rafHead = (rafHead + 1) % RAF_SAMPLES;
        rafCount = Math.min(RAF_SAMPLES, rafCount + 1);
      }
      lastTick = ms;
    },
    render(ms, cpuMs) {
      if (lastRender !== null && ms > lastRender) {
        at[head] = ms;
        interval[head] = ms - lastRender;
        cpu[head] = cpuMs;
        head = (head + 1) % RENDER_CAPACITY;
        len = Math.min(RENDER_CAPACITY, len + 1);
        evict(ms);
      }
      lastRender = ms;
    },
    gap() {
      lastTick = null;
      lastRender = null;
    },
    report() {
      const first = (head - len + RENDER_CAPACITY) % RENDER_CAPACITY;
      const iv = new Float64Array(len);
      const cv = new Float64Array(len);
      let long = 0;
      let total = 0;
      let recentSum = 0;
      let recentN = 0;
      const newest = len > 0 ? at[(head - 1 + RENDER_CAPACITY) % RENDER_CAPACITY]! : 0;
      for (let k = 0; k < len; k++) {
        const j = (first + k) % RENDER_CAPACITY;
        iv[k] = interval[j]!;
        cv[k] = cpu[j]!;
        total += interval[j]!;
        if (interval[j]! > LONG_FRAME_MS) long++;
        if (at[j]! > newest - FPS_WINDOW_MS) {
          recentSum += interval[j]!;
          recentN++;
        }
      }
      iv.sort();
      cv.sort();
      const raf = rafIntervals.slice(0, rafCount).sort();
      const rafMedian = percentile(raf, 0.5);
      return {
        fps: recentSum > 0 ? (1000 * recentN) / recentSum : 0,
        samples: len,
        windowS: total / 1000,
        p50: percentile(iv, 0.5),
        p95: percentile(iv, 0.95),
        worst: len > 0 ? iv[len - 1]! : 0,
        long: len > 0 ? long / len : 0,
        cpuP95: percentile(cv, 0.95),
        displayHz: rafCount >= 10 && rafMedian > 0 ? 1000 / rafMedian : 0,
      };
    },
  };
}
