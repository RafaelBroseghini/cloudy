import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  baseFlat,
  erosionGain,
  GAIN_STRATUS,
  GAIN_TOWER,
  lumpOut,
  smoothstep,
  stratusLayer,
  STRATUS_GREY,
  TOWER_GREY,
  typeGrey,
} from "./cloudShape.ts";

const unit = fc.double({ min: 0, max: 1, noNaN: true });
/** A type mix: stratus share and nimbus share that sum to at most 1 (the rest is cumulus). */
const mixArb = fc.tuple(unit, unit).map(([a, b]) => ({ st: a, nb: Math.min(b, 1 - a) }));

describe("erosion gain by height and type", () => {
  it("a tower is carved lightly at its base and hard at its top, more than a cumulus at the top and less at the base", () => {
    expect(erosionGain(0, 0, 1)).toBeLessThan(erosionGain(1, 0, 1));
    expect(erosionGain(1, 0, 1)).toBeCloseTo(GAIN_TOWER[1], 9);
    expect(erosionGain(0, 0, 1)).toBeCloseTo(GAIN_TOWER[0], 9);
    expect(erosionGain(1, 0, 1)).toBeGreaterThan(erosionGain(1, 0, 0));
    expect(erosionGain(0, 0, 1)).toBeLessThan(erosionGain(0, 0, 0));
  });
  it("a sheet is carved the same at every height", () => {
    for (const h of [0, 0.3, 0.7, 1]) expect(erosionGain(h, 1, 0)).toBeCloseTo(GAIN_STRATUS, 9);
  });
  it("never decreases with height for a cumulus or a tower, and stays between the type values for any mix", () => {
    fc.assert(
      fc.property(unit, unit, fc.constantFrom(0, 1), (a, b, nb) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(erosionGain(lo, 0, nb)).toBeLessThanOrEqual(erosionGain(hi, 0, nb) + 1e-12);
      }),
    );
    fc.assert(
      fc.property(unit, mixArb, (h, m) => {
        const g = erosionGain(h, m.st, m.nb);
        expect(g).toBeGreaterThanOrEqual(Math.min(GAIN_TOWER[0], GAIN_STRATUS, 0.55) - 1e-9);
        expect(g).toBeLessThanOrEqual(Math.max(GAIN_TOWER[1], GAIN_STRATUS, 1.25) + 1e-9);
      }),
    );
  });
});

describe("flat bases", () => {
  it("a tower's density is cut to a sliver (15%) at its base and left alone above the cut, whatever flatBase says", () => {
    for (const fb of [0, 0.4, 1]) {
      expect(baseFlat(0, 0, 1, fb, 0)).toBeCloseTo(fb >= 0.85 ? 0 : 0.15, 9);
      expect(baseFlat(0.3, 0, 1, fb, 0)).toBeCloseTo(1, 9);
    }
  });
  it("the cut is ragged: noise moves it up and down a little, never beyond the ragged budget", () => {
    const h = 0.1;
    expect(baseFlat(h, 0, 1, 0.4, -0.5)).toBeGreaterThan(baseFlat(h, 0, 1, 0.4, 0.5));
    expect(baseFlat(0.3, 0, 1, 0.4, 0.5)).toBeCloseTo(1, 9);
    expect(baseFlat(0.01, 0, 1, 0.4, -0.5)).toBeLessThan(0.3);
  });
  it("a sheet keeps its full base, and a cumulus thins by flatBase only", () => {
    expect(baseFlat(0, 1, 0, 1, 0)).toBe(1);
    expect(baseFlat(0, 0, 0, 0, 0)).toBe(1);
    expect(baseFlat(0, 0, 0, 1, 0)).toBeCloseTo(0, 9);
    expect(baseFlat(0, 0, 0, 0.4, 0)).toBeCloseTo(0.6, 9);
  });
  it("is in 0..1 and does not decrease with height", () => {
    fc.assert(
      fc.property(unit, unit, mixArb, unit, fc.double({ min: -0.5, max: 0.5, noNaN: true }), (a, b, m, fb, r) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const f0 = baseFlat(lo, m.st, m.nb, fb, r);
        const f1 = baseFlat(hi, m.st, m.nb, fb, r);
        expect(f0).toBeGreaterThanOrEqual(-1e-12);
        expect(f1).toBeLessThanOrEqual(1 + 1e-12);
        expect(f0).toBeLessThanOrEqual(f1 + 1e-9);
      }),
    );
  });
});

describe("type grey", () => {
  it("a tower is dark at its base and bright on top; a sheet is grey under and lighter above, but darker than the open sky's white", () => {
    expect(typeGrey(0, 0, 1)).toBeCloseTo(TOWER_GREY[0], 9);
    expect(typeGrey(1, 0, 1)).toBeCloseTo(TOWER_GREY[1], 9);
    expect(typeGrey(0.5, 0, 1)).toBeGreaterThan(typeGrey(0.1, 0, 1));
    expect(typeGrey(0, 1, 0)).toBeCloseTo(STRATUS_GREY[0], 9);
    expect(typeGrey(1, 1, 0)).toBeCloseTo(STRATUS_GREY[1], 9);
    expect(STRATUS_GREY[1]).toBeLessThan(1);
  });
  it("a cumulus is not tinted", () => {
    for (const h of [0, 0.5, 1]) expect(typeGrey(h, 0, 0)).toBe(1);
  });
});

describe("stratus layering", () => {
  it("without layering the sheet is just a thickness variation; with it, bands cut the density between 0 and the unbanded value", () => {
    fc.assert(
      fc.property(fc.double({ min: -3, max: 3, noNaN: true }), fc.double({ min: -9, max: 9, noNaN: true }), unit, unit, unit, (y, x, n, along, amount) => {
        const plain = stratusLayer(y, x, n, along, 0);
        const banded = stratusLayer(y, x, n, along, amount);
        expect(banded).toBeGreaterThanOrEqual(-1e-12);
        expect(banded).toBeLessThanOrEqual(plain + 1e-9);
      }),
    );
  });
  it("bands repeat along y (about 0.5 units apart) and tilt along x", () => {
    const f = (y: number, x: number): number => stratusLayer(y, x, 0.5, 0.5, 0.9);
    const period = (2 * Math.PI) / 12;
    for (const y of [-1, 0.2, 0.9]) expect(f(y + period, 0)).toBeCloseTo(f(y, 0), 9);
    expect(f(0, 3)).not.toBeCloseTo(f(0, 0), 3);
  });
  it("is not flat: a layered sheet varies by a lot across its height", () => {
    const vals = Array.from({ length: 40 }, (_, i) => stratusLayer(i * 0.04, 0, 0.5, 0.5, 0.7));
    expect(Math.max(...vals) / Math.min(...vals)).toBeGreaterThan(2);
  });
});

describe("outward lumpiness", () => {
  it("is bounded by the budget and never negative, for any noise, depth, height and mix", () => {
    fc.assert(
      fc.property(unit, fc.double({ min: 0, max: 5, noNaN: true }), unit, mixArb, fc.double({ min: 0, max: 1.2, noNaN: true }), (bill, sn, h, m, budget) => {
        const v = lumpOut(bill, sn, h, m.nb, m.st, budget);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(budget + 1e-12);
      }),
    );
  });
  it("only acts near the contour: nothing in the sky (density under half the contour) or deep inside, and nothing on a sheet", () => {
    expect(lumpOut(1, 0.3, 1, 1, 0, 1)).toBe(0);
    expect(lumpOut(1, 3, 1, 1, 0, 1)).toBe(0);
    expect(lumpOut(1, 1.1, 1, 0, 1, 1)).toBe(0);
    expect(lumpOut(1, 1.1, 1, 1, 0, 1)).toBeGreaterThan(0.9);
  });
  it("is strongest high on a tower: more at the top than the base, more on a tower than a cumulus", () => {
    expect(lumpOut(1, 1.1, 1, 1, 0, 1)).toBeGreaterThan(lumpOut(1, 1.1, 0, 1, 0, 1));
    expect(lumpOut(1, 1.1, 0.5, 1, 0, 1)).toBeGreaterThan(lumpOut(1, 1.1, 0.5, 0, 0, 1));
  });
  it("a budget of 0 turns it off", () => {
    expect(lumpOut(1, 1.1, 1, 1, 0, 0)).toBe(0);
  });
});

describe("smoothstep", () => {
  it("is 0 before, 1 after, monotone between", () => {
    expect(smoothstep(0.2, 0.8, 0)).toBe(0);
    expect(smoothstep(0.2, 0.8, 1)).toBe(1);
    expect(smoothstep(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 9);
  });
});
