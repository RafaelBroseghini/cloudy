import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPacer, renderEvery, TARGET_HZ } from "./pacing.ts";

/** Run `seconds` of callbacks at `hz` (with optional jitter in ms) and return the render rate and the render intervals. */
function run(hz: number, seconds = 3, jitter: (i: number) => number = () => 0) {
  const p = createPacer();
  const period = 1000 / hz;
  const renders: number[] = [];
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    const t = 1000 + i * period + jitter(i);
    if (p.frame(t)) renders.push(t);
  }
  // Skip the warm-up before the estimate exists.
  const steady = renders.filter((t) => t > 1000 + 1000);
  const gaps = steady.slice(1).map((t, i) => t - steady[i]!);
  return { fps: (gaps.length * 1000) / (steady.at(-1)! - steady[0]!), gaps, every: p.state().every };
}

describe("render pacing", () => {
  it("renders every refresh up to the first whole multiple of 60, then divides evenly", () => {
    expect([60, 75, 90, 110, 120, 144, 165, 240].map(renderEvery)).toEqual([1, 1, 1, 1, 2, 2, 2, 4]);
    expect(run(90).fps).toBeCloseTo(90, 3);
    expect(run(75).fps).toBeCloseTo(75, 3);
    expect(run(60).fps).toBeCloseTo(60, 3);
    expect(run(120).fps).toBeCloseTo(60, 3);
    expect(run(144).fps).toBeCloseTo(72, 3);
    expect(run(240).fps).toBeCloseTo(60, 3);
  });

  it("a slightly slow 120 Hz screen still renders every other refresh", () => {
    expect(renderEvery(119.5)).toBe(2);
    expect(run(119.5).every).toBe(2);
  });

  it("never renders faster than the display or above the target by a whole multiple, and spaces frames evenly", () => {
    fc.assert(
      fc.property(fc.double({ min: 30, max: 360, noNaN: true }), (hz) => {
        const r = run(hz);
        const k = renderEvery(hz);
        expect(r.fps).toBeLessThanOrEqual(hz + 1e-6);
        expect(r.fps).toBeCloseTo(hz / k, 3);
        expect(r.fps).toBeLessThan(2 * TARGET_HZ + DIVISOR_MARGIN);
        for (const g of r.gaps) expect(g).toBeCloseTo((1000 / hz) * k, 6);
      }),
    );
  });

  it("holds its divisor through timestamp jitter", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        let s = seed;
        const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 1.5; // +-0.75 ms
        const r = run(120, 3, rnd);
        expect(r.every).toBe(2);
        expect(r.fps).toBeGreaterThan(58);
        expect(r.fps).toBeLessThan(62);
      }),
      { numRuns: 50 },
    );
  });

  it("a stall or a hidden tab does not change the divisor", () => {
    const p = createPacer();
    let t = 0;
    for (let i = 0; i < 60; i++) p.frame((t += 1000 / 120));
    p.frame((t += 5000));
    expect(p.state().every).toBe(2);
  });
});

/** renderEvery(hz) is floor(hz / 60 + slack), so hz / k stays under 2 * 60 plus the slack's share. */
const DIVISOR_MARGIN = 10;
