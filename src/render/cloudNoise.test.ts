import { describe, expect, it } from "vitest";
import { createNoiseBaker } from "./cloudNoise.ts";

describe("cloud noise baker", () => {
  it("is deterministic, and the same however the bake is sliced across frames", () => {
    const whole = createNoiseBaker(10);
    whole.step(Infinity);
    const sliced = createNoiseBaker(10);
    let calls = 0;
    // A clock that jumps 1 ms per read: every step() bakes exactly one row before it runs out of budget.
    let t = 0;
    while (!sliced.step(0.5, () => (t += 1))) calls++;
    expect(calls).toBeGreaterThan(10);
    expect(whole.done).toBe(true);
    expect(sliced.done).toBe(true);
    expect(sliced.data).toEqual(whole.data);
    const again = createNoiseBaker(10);
    again.step(Infinity);
    expect(again.data).toEqual(whole.data);
  });

  it("fills RGBA8 for size^3 voxels, with real structure in every channel", () => {
    const b = createNoiseBaker(12);
    expect(b.done).toBe(false);
    b.step(Infinity);
    expect(b.data.length).toBe(12 ** 3 * 4);
    for (let c = 0; c < 4; c++) {
      let lo = 255;
      let hi = 0;
      for (let i = c; i < b.data.length; i += 4) {
        lo = Math.min(lo, b.data[i]!);
        hi = Math.max(hi, b.data[i]!);
      }
      expect(hi - lo, `channel ${c}`).toBeGreaterThan(60);
    }
  });

  it("is tileable: the first and last voxel along an axis differ about as much as neighbours do", () => {
    const n = 16;
    const b = createNoiseBaker(n);
    b.step(Infinity);
    const at = (x: number, y: number, z: number, c: number): number => b.data[((z * n + y) * n + x) * 4 + c]!;
    let wrap = 0;
    let near = 0;
    let count = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        wrap += Math.abs(at(0, y, z, 0) - at(n - 1, y, z, 0));
        near += Math.abs(at(n / 2, y, z, 0) - at(n / 2 - 1, y, z, 0));
        count++;
      }
    }
    expect(wrap / count).toBeLessThan((near / count) * 2.5 + 3);
  });
});
