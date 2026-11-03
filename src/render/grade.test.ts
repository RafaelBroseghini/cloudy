import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contrastCurve, fillLut, gradeColor, LUT_SIZE, NEUTRAL_GRADE, sameGrade, type Grade } from "./grade.ts";

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const tint = fc.tuple(fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }));
const grade: fc.Arbitrary<Grade> = fc.record({
  contrast: fc.double({ min: 0.5, max: 2, noNaN: true }),
  saturation: fc.double({ min: 0, max: 2, noNaN: true }),
  temperature: fc.double({ min: -1, max: 1, noNaN: true }),
  lift: fc.double({ min: -0.2, max: 0.2, noNaN: true }),
  shadow: tint,
  highlight: tint,
});
const out = (): [number, number, number] => [0, 0, 0];

describe("grade", () => {
  it("the neutral grade is the identity", () => {
    fc.assert(
      fc.property(unit, unit, unit, (r, g, b) => {
        const o = gradeColor(NEUTRAL_GRADE, r, g, b, out());
        expect(o[0]).toBeCloseTo(r, 12);
        expect(o[1]).toBeCloseTo(g, 12);
        expect(o[2]).toBeCloseTo(b, 12);
      }),
    );
  });

  it("the neutral LUT holds each texel's own coordinates, within rounding", () => {
    const data = fillLut(NEUTRAL_GRADE, LUT_SIZE, new Uint8Array(LUT_SIZE ** 3 * 4));
    const s = LUT_SIZE - 1;
    for (let b = 0; b < LUT_SIZE; b++)
      for (let g = 0; g < LUT_SIZE; g++)
        for (let r = 0; r < LUT_SIZE; r++) {
          const o = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4;
          expect(Math.abs(data[o]! - (r / s) * 255)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(data[o + 1]! - (g / s) * 255)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(data[o + 2]! - (b / s) * 255)).toBeLessThanOrEqual(0.5);
          expect(data[o + 3]).toBe(255);
        }
  });

  it("every grade stays in 0..1", () => {
    fc.assert(
      fc.property(grade, unit, unit, unit, (gr, r, g, b) => {
        for (const v of gradeColor(gr, r, g, b, out())) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("the contrast curve is monotone and keeps black, the pivot and white", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 4, noNaN: true }), unit, unit, (k, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(contrastCurve(lo, k)).toBeLessThanOrEqual(contrastCurve(hi, k) + 1e-12);
        expect(contrastCurve(0, k)).toBe(0);
        expect(contrastCurve(1, k)).toBeCloseTo(1, 12);
        expect(contrastCurve(0.45, k)).toBeCloseTo(0.45, 12);
      }),
    );
  });

  it("a grey ramp stays ordered under any grade without tints (no tone reversal)", () => {
    fc.assert(
      fc.property(grade, unit, unit, (gr, a, b) => {
        const plain = { ...gr, temperature: 0, shadow: [1, 1, 1] as const, highlight: [1, 1, 1] as const };
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(gradeColor(plain, lo, lo, lo, out())[1]).toBeLessThanOrEqual(gradeColor(plain, hi, hi, hi, out())[1] + 1e-12);
      }),
    );
  });

  it("saturation 0 gives grey, and positive temperature warms a grey", () => {
    const o = gradeColor({ ...NEUTRAL_GRADE, saturation: 0 }, 0.8, 0.3, 0.1, out());
    expect(o[0]).toBeCloseTo(o[1], 12);
    expect(o[1]).toBeCloseTo(o[2], 12);
    const w = gradeColor({ ...NEUTRAL_GRADE, temperature: 0.5 }, 0.5, 0.5, 0.5, out());
    expect(w[0]).toBeGreaterThan(w[1]);
    expect(w[2]).toBeLessThan(w[1]);
  });

  it("sameGrade compares every field", () => {
    expect(sameGrade(NEUTRAL_GRADE, { ...NEUTRAL_GRADE })).toBe(true);
    expect(sameGrade(NEUTRAL_GRADE, { ...NEUTRAL_GRADE, lift: 0.01 })).toBe(false);
    expect(sameGrade(NEUTRAL_GRADE, { ...NEUTRAL_GRADE, highlight: [1, 1, 0.9] })).toBe(false);
  });
});
