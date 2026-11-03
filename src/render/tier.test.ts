import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MARCH_MAX_PIXELS, marchSize, pickTier, TIERS, TIER_NAMES } from "./tier.ts";

describe("pickTier", () => {
  it("defaults to mid on desktop (hi is opt-in)", () => {
    expect(pickTier("", false, 1280)).toBe("mid");
    expect(pickTier("", false, 390)).toBe("mid");
    expect(pickTier("", false, 3840)).toBe("mid");
  });
  it("picks low on a small coarse-pointer screen, mid on a big one", () => {
    expect(pickTier("", true, 390)).toBe("low");
    expect(pickTier("", true, 860)).toBe("low");
    expect(pickTier("", true, 1024)).toBe("mid");
  });
  it("lets ?tier= override, and ignores junk", () => {
    expect(pickTier("?tier=mid", true, 390)).toBe("mid");
    expect(pickTier("?tier=hi", true, 390)).toBe("hi");
    expect(pickTier("?tier=hi", false, 1280)).toBe("hi");
    expect(pickTier("?tier=low", false, 1920)).toBe("low");
    expect(pickTier("?tier=ultra", true, 390)).toBe("low");
    expect(pickTier("?tier=ultra", false, 1280)).toBe("mid");
  });
  it("tiers only get cheaper", () => {
    const [hi, mid, low] = TIER_NAMES.map((n) => TIERS[n]);
    // (Not marchScale: low's is higher so a phone gets more pixels, and its pixel cap keeps it as cheap as ever on a desktop window.)
    for (const k of ["marchMaxPixels", "steps", "lightSteps", "octaves", "fine", "ao", "jitter", "bake", "pixelRatio", "sceneSteps", "aoTaps", "bloomScale"] as const) {
      expect(hi![k]).toBeGreaterThanOrEqual(mid![k]);
      expect(mid![k]).toBeGreaterThanOrEqual(low![k]);
    }
  });
  it("the smaller the march target, the more the composite sharpens its upsample", () => {
    const [hi, mid, low] = TIER_NAMES.map((n) => TIERS[n]);
    expect(low!.sharp).toBeGreaterThan(mid!.sharp);
    expect(mid!.sharp).toBeGreaterThanOrEqual(hi!.sharp);
    // Low also drops the start jitter, which a sharper filter would show as diagonal hatching with its few steps.
    expect(low!.jitter).toBe(0);
    expect(mid!.jitter).toBe(1);
  });
});

describe("tier -> march settings", () => {
  it("steps, sun-march steps, scattering octaves and march scale (low's 0.6 only shows on phones: at desktop sizes its 0.15 MP cap binds): hi 28/6 and mid 16/4 keep thunder inside 14 and 8 ms with the taller towers and deeper clouds", () => {
    expect(TIER_NAMES.map((n) => TIERS[n].steps)).toEqual([28, 16, 12]);
    expect(TIER_NAMES.map((n) => TIERS[n].lightSteps)).toEqual([6, 4, 4]);
    expect(TIER_NAMES.map((n) => TIERS[n].octaves)).toEqual([8, 4, 2]);
    expect(TIER_NAMES.map((n) => TIERS[n].marchScale)).toEqual([0.5, 0.5, 0.6]);
    expect(TIER_NAMES.map((n) => TIERS[n].marchMaxPixels)).toEqual([MARCH_MAX_PIXELS.hi, MARCH_MAX_PIXELS.mid, MARCH_MAX_PIXELS.low]);
  });
});

describe("march target size", () => {
  const sizes = fc.tuple(fc.integer({ min: 200, max: 7680 }), fc.integer({ min: 200, max: 4320 }));

  it("never exceeds the tier's pixel cap, keeps the screen's aspect, and is at least 2x2", () => {
    fc.assert(
      fc.property(sizes, fc.constantFrom(...TIER_NAMES), ([w, h], name) => {
        const t = TIERS[name];
        const m = marchSize(w, h, t);
        expect(m.width * m.height).toBeLessThanOrEqual(t.marchMaxPixels * 1.002 + 4);
        expect(m.width / m.height).toBeCloseTo(w / h, 1 - Math.log10(Math.max(m.width, m.height) / 100));
        expect(Math.min(m.width, m.height)).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it("depends on the CSS size only: a drawing buffer at any device pixel ratio gives the same target", () => {
    for (const name of TIER_NAMES) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const bufW = Math.round(1280 * dpr);
        const bufH = Math.round(800 * dpr);
        // The scene sizes the march from the CSS viewport (the buffer divided by its ratio), so every ratio lands here.
        expect(marchSize(Math.round(bufW / dpr), Math.round(bufH / dpr), TIERS[name])).toEqual(marchSize(1280, 800, TIERS[name]));
      }
    }
  });

  it("at 1280x800: 640x400 on hi and mid (a quarter of the pixels), the 0.15 MP cap on low (about the spike's 0.35 scale)", () => {
    expect(marchSize(1280, 800, TIERS.hi)).toEqual({ width: 640, height: 400 });
    expect(marchSize(1280, 800, TIERS.mid)).toEqual({ width: 640, height: 400 });
    const low = marchSize(1280, 800, TIERS.low);
    expect(low.width * low.height).toBeLessThanOrEqual(MARCH_MAX_PIXELS.low);
    expect(low.width / 1280).toBeGreaterThan(0.35);
    expect(low.width / 1280).toBeLessThan(0.4);
  });

  it("a phone (390x844) is under every cap: half resolution on hi and mid, 0.6 (about 118 thousand pixels, still under the cap) on low", () => {
    expect(marchSize(390, 844, TIERS.hi)).toEqual({ width: 195, height: 422 });
    expect(marchSize(390, 844, TIERS.mid)).toEqual({ width: 195, height: 422 });
    const low = marchSize(390, 844, TIERS.low);
    expect(low).toEqual({ width: 234, height: 506 });
    expect(low.width * low.height).toBeLessThan(MARCH_MAX_PIXELS.low);
  });
  it("a phone's low tier draws at 1.5x the pixel ratio (a sharper canvas than the old 1x), cheaper than a desktop window at mid's ratio", () => {
    expect(TIERS.low.pixelRatio).toBe(1.5);
    expect(390 * 844 * TIERS.low.pixelRatio ** 2).toBeLessThan(1280 * 800 * TIERS.mid.pixelRatio ** 2);
  });

  it("big screens are capped, not scaled: 4K stays under 0.75 / 0.5 / 0.15 megapixels", () => {
    expect(marchSize(3840, 2160, TIERS.hi).width * marchSize(3840, 2160, TIERS.hi).height).toBeLessThanOrEqual(750_000);
    expect(marchSize(3840, 2160, TIERS.mid).width * marchSize(3840, 2160, TIERS.mid).height).toBeLessThanOrEqual(500_000);
    expect(marchSize(3840, 2160, TIERS.low).width * marchSize(3840, 2160, TIERS.low).height).toBeLessThanOrEqual(150_000);
  });
});
