import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createFrameStats, LONG_FRAME_MS, percentile, STATS_WINDOW_MS } from "./frameStats.ts";

const intervals = fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 400 });

/** Feed renders `iv` ms apart (each also a rAF tick), starting at t = 1000. */
function feed(iv: readonly number[], cpu = 1) {
  const s = createFrameStats();
  let t = 1000;
  s.tick(t);
  s.render(t, cpu);
  for (const d of iv) {
    t += d;
    s.tick(t);
    s.render(t, cpu);
  }
  return { s, t };
}

describe("frame stats", () => {
  it("percentiles are ordered and inside the samples", () => {
    fc.assert(
      fc.property(intervals, (iv) => {
        const r = feed(iv).s.report();
        expect(r.samples).toBe(iv.length);
        expect(r.p50).toBeLessThanOrEqual(r.p95);
        expect(r.p95).toBeLessThanOrEqual(r.worst);
        expect(r.p50).toBeGreaterThanOrEqual(Math.min(...iv));
        expect(r.worst).toBe(Math.max(...iv));
        expect(r.long).toBeGreaterThanOrEqual(0);
        expect(r.long).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("a steady rate reads as that rate", () => {
    fc.assert(
      fc.property(fc.double({ min: 5, max: 100, noNaN: true }), fc.integer({ min: 70, max: 300 }), (d, n) => {
        const r = feed(Array.from({ length: n }, () => d)).s.report();
        expect(r.p50).toBeCloseTo(d, 9);
        expect(r.p95).toBeCloseTo(d, 9);
        expect(r.fps).toBeCloseTo(1000 / d, 6);
        expect(r.displayHz).toBeCloseTo(1000 / d, 6);
        expect(r.long).toBe(d > LONG_FRAME_MS ? 1 : 0);
      }),
    );
  });

  it("forgets renders older than the window", () => {
    const { s } = feed(Array.from({ length: 5000 }, () => 20)); // 100 s at 50 fps
    const r = s.report();
    expect(r.windowS).toBeLessThanOrEqual(STATS_WINDOW_MS / 1000 + 0.02);
    expect(r.windowS).toBeGreaterThan(STATS_WINDOW_MS / 1000 - 0.1);
  });

  it("a gap (hidden tab, benchmark) is not a slow frame", () => {
    const s = createFrameStats();
    for (let t = 0; t <= 1000; t += 16) s.render(t, 1);
    s.gap();
    for (let t = 31_000; t <= 32_000; t += 16) s.render(t, 1);
    expect(s.report().worst).toBe(16);
  });

  it("tells the display's rate from the render rate (a 90 Hz screen rendering every other callback)", () => {
    const s = createFrameStats();
    const d = 1000 / 90;
    for (let i = 0; i < 400; i++) {
      s.tick(i * d);
      if (i % 2 === 0) s.render(i * d, 1);
    }
    const r = s.report();
    expect(r.displayHz).toBeCloseTo(90, 6);
    expect(r.fps).toBeCloseTo(45, 6);
  });

  it("reports zeros before any interval", () => {
    const s = createFrameStats();
    s.render(0, 1);
    expect(s.report()).toMatchObject({ fps: 0, samples: 0, p95: 0, worst: 0, displayHz: 0 });
  });

  it("nearest-rank percentile", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([], 0.5)).toBe(0);
  });
});
