import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createParallax, layerShift, PARALLAX_DEFAULTS, REDUCED_CURSOR_SCALE } from "./parallax.ts";

const run = (p: ReturnType<typeof createParallax>, seconds: number, hz: number): void => {
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) p.step(1 / hz);
};

describe("parallax", () => {
  it("starts at rest", () => {
    const p = createParallax();
    p.step(0);
    expect(p.offset).toEqual({ x: 0, y: 0 });
  });

  it("settles on the cursor target without overshoot", () => {
    const p = createParallax({ maxSway: 0 });
    p.setTarget({ x: 1, y: 0 });
    let prev = 0;
    for (let i = 0; i < 600; i++) {
      p.step(1 / 60);
      expect(p.offset.x).toBeGreaterThanOrEqual(prev);
      expect(p.offset.x).toBeLessThanOrEqual(PARALLAX_DEFAULTS.maxCursor + 1e-12);
      prev = p.offset.x;
    }
    expect(p.offset.x).toBeCloseTo(PARALLAX_DEFAULTS.maxCursor, 3);
  });

  it("caps the offset for any pointer, including garbage", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.double({ noNaN: false }), y: fc.double({ noNaN: false }), dt: fc.double({ min: -1, max: 5 }) }), {
          maxLength: 120,
        }),
        (samples) => {
          const p = createParallax();
          const bound = PARALLAX_DEFAULTS.maxCursor + PARALLAX_DEFAULTS.maxSway + 1e-9;
          for (const s of samples) {
            p.setTarget({ x: s.x, y: s.y });
            p.step(s.dt);
            expect(Math.abs(p.offset.x)).toBeLessThanOrEqual(bound);
            expect(Math.abs(p.offset.y)).toBeLessThanOrEqual(bound);
            expect(Number.isFinite(p.offset.x) && Number.isFinite(p.offset.y)).toBe(true);
          }
        },
      ),
    );
  });

  it("is frame-rate independent", () => {
    const a = createParallax();
    const b = createParallax();
    a.setTarget({ x: 0.7, y: -0.4 });
    b.setTarget({ x: 0.7, y: -0.4 });
    run(a, 3, 60);
    run(b, 3, 120);
    expect(a.offset.x).toBeCloseTo(b.offset.x, 6);
    expect(a.offset.y).toBeCloseTo(b.offset.y, 6);
  });

  it("returns to the idle sway when the pointer leaves", () => {
    const p = createParallax({ maxSway: 0 });
    p.setTarget({ x: 1, y: 1 });
    run(p, 5, 60);
    p.setTarget(null);
    run(p, 10, 60);
    expect(Math.abs(p.offset.x)).toBeLessThan(1e-3);
    expect(Math.abs(p.offset.y)).toBeLessThan(1e-3);
  });

  it("sways slowly on its own and the sway stays small", () => {
    const p = createParallax();
    let min = Infinity;
    let max = -Infinity;
    let maxStep = 0;
    let last = 0;
    for (let i = 0; i < 60 * 120; i++) {
      p.step(1 / 60);
      min = Math.min(min, p.offset.x);
      max = Math.max(max, p.offset.x);
      maxStep = Math.max(maxStep, Math.abs(p.offset.x - last));
      last = p.offset.x;
    }
    expect(max - min).toBeGreaterThan(PARALLAX_DEFAULTS.maxSway);
    expect(max).toBeLessThanOrEqual(PARALLAX_DEFAULTS.maxSway + 1e-9);
    // Well under a thousandth of the view height per frame: no visible jitter.
    expect(maxStep).toBeLessThan(1e-3);
  });

  it("reduced motion: no sway, smaller cursor parallax", () => {
    const p = createParallax({ reducedMotion: true });
    run(p, 60, 60);
    expect(p.offset).toEqual({ x: 0, y: 0 });
    p.setTarget({ x: 1, y: 0 });
    run(p, 10, 60);
    expect(p.offset.x).toBeCloseTo(PARALLAX_DEFAULTS.maxCursor * REDUCED_CURSOR_SCALE, 4);
  });

  it("toggling reduced motion eases instead of popping", () => {
    const p = createParallax();
    run(p, 20, 60);
    const before = p.offset.x;
    p.setReducedMotion(true);
    p.step(1 / 60);
    expect(Math.abs(p.offset.x - before)).toBeLessThan(2e-3);
  });

  it("layerShift: the play layer (depth 1) never moves; far and near move opposite ways", () => {
    fc.assert(fc.property(fc.double({ min: -1, max: 1, noNaN: true }), (o) => layerShift(o, 1) === 0));
    expect(layerShift(0.5, 0.2)).toBeGreaterThan(0);
    expect(layerShift(0.5, 1.8)).toBeLessThan(0);
  });
});
