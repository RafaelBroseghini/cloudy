import { Data3DTexture } from "three/webgpu";
import { uniform } from "three/tsl";
import { describe, expect, it } from "vitest";
import { defaultValues } from "../params/index.ts";
import { createBlobTexture, createCloudMarch, createCloudUniforms, createTileTexture } from "./volume.ts";

describe("volume pass", () => {
  it("builds its shader graph (no throw at construction), with the data textures the CPU fills", () => {
    const march = createCloudMarch({
      u: createCloudUniforms(),
      blobTex: createBlobTexture(),
      tileTex: createTileTexture(),
      noiseTex: new Data3DTexture(new Uint8Array(4 * 8 ** 3), 8, 8, 8),
      aspect: uniform(1.6),
      flash: uniform(0),
      flashX: uniform(0.5),
      flashY: uniform(0.5),
    });
    expect(march.quad).toBeDefined();
    march.dispose();
  });

  it("starts at the field defaults, so the first frame is the resolved clear look before applyLook runs", () => {
    const u = createCloudUniforms();
    const d = defaultValues();
    expect(u.sigma.value).toBe(d.volSigma);
    expect(u.reach.value).toBe(d.volReach);
    expect(u.sunGain.value).toBe(d.volSunGain);
    expect(u.erosion.value).toBe(d.volErosion);
    expect(u.erosionFine.value).toBeCloseTo(d.volErosion * 0.5, 9);
    expect(u.flatBase.value).toBe(d.volFlatBase);
    expect(u.powder.value).toBe(d.volPowder);
    expect(u.phaseG.value).toBe(d.volPhaseG);
    expect(u.msGain.value).toBe(d.volMultiScatter);
    expect(u.ambient.value).toBe(d.volAmbient);
    expect(u.aoK.value).toBe(d.volAO);
    expect(u.silver.value).toBe(d.volSilver);
    expect(u.zScale.value.toArray()).toEqual([d.volHeightCumulus, d.volHeightStratus, d.volHeightNimbus]);
    expect(u.noiseScale.value).toBeCloseTo(1 / d.volLumpScale, 9);
  });

  it("the noise stays off until it is baked", () => {
    expect(createCloudUniforms().noiseMix.value).toBe(0);
  });
});
