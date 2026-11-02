import { describe, expect, it } from "vitest";
import { pickTier, TIERS, TIER_NAMES } from "./tier.ts";

describe("pickTier", () => {
  it("defaults to hi on desktop", () => {
    expect(pickTier("", false, 1280)).toBe("hi");
    expect(pickTier("", false, 390)).toBe("hi");
  });
  it("picks low on a small coarse-pointer screen", () => {
    expect(pickTier("", true, 390)).toBe("low");
    expect(pickTier("", true, 860)).toBe("low");
    expect(pickTier("", true, 1024)).toBe("hi");
  });
  it("lets ?tier= override, and ignores junk", () => {
    expect(pickTier("?tier=mid", true, 390)).toBe("mid");
    expect(pickTier("?tier=hi", true, 390)).toBe("hi");
    expect(pickTier("?tier=low", false, 1920)).toBe("low");
    expect(pickTier("?tier=ultra", true, 390)).toBe("low");
  });
  it("tiers only get cheaper", () => {
    const [hi, mid, low] = TIER_NAMES.map((n) => TIERS[n]);
    for (const k of ["field", "bake", "pixelRatio", "steps", "sceneSteps", "aoTaps"] as const) {
      expect(hi![k]).toBeGreaterThanOrEqual(mid![k]);
      expect(mid![k]).toBeGreaterThanOrEqual(low![k]);
    }
  });
});
