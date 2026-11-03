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
    for (const k of ["marchScale", "marchMaxPixels", "steps", "lightSteps", "octaves", "fine", "ao", "bake", "pixelRatio", "sceneSteps", "aoTaps"] as const) {
      expect(hi![k]).toBeGreaterThanOrEqual(mid![k]);
      expect(mid![k]).toBeGreaterThanOrEqual(low![k]);
    }
  });
});

describe("tier -> march settings", () => {
  it("steps, sun-march steps, scattering octaves and march scale 0.5 (low is capped to the spike's ~0.35 at desktop sizes by its 0.15 MP cap): the spike's hi and low; mid trimmed from the spike's 20/6/4 to 16/5/4 so thunder fits in about 7 ms", () => {
    expect(TIER_NAMES.map((n) => TIERS[n].steps)).toEqual([32, 16, 12]);
    expect(TIER_NAMES.map((n) => TIERS[n].lightSteps)).toEqual([8, 5, 4]);
    expect(TIER_NAMES.map((n) => TIERS[n].octaves)).toEqual([8, 4, 2]);
    expect(TIER_NAMES.map((n) => TIERS[n].marchScale)).toEqual([0.5, 0.5, 0.5]);
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

  it("a phone (390x844) is under every cap and gets half resolution, even on low", () => {
    for (const name of TIER_NAMES) expect(marchSize(390, 844, TIERS[name])).toEqual({ width: 195, height: 422 });
  });

  it("big screens are capped, not scaled: 4K stays under 0.75 / 0.5 / 0.15 megapixels", () => {
    expect(marchSize(3840, 2160, TIERS.hi).width * marchSize(3840, 2160, TIERS.hi).height).toBeLessThanOrEqual(750_000);
    expect(marchSize(3840, 2160, TIERS.mid).width * marchSize(3840, 2160, TIERS.mid).height).toBeLessThanOrEqual(500_000);
    expect(marchSize(3840, 2160, TIERS.low).width * marchSize(3840, 2160, TIERS.low).height).toBeLessThanOrEqual(150_000);
  });
});
