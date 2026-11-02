import { describe, expect, it } from "vitest";
import { cloudCentresFromBuffer, parseBackendParam, typeCounts } from "./harness.ts";
import { BLOB, BLOB_STRIDE, createBlobBuffer } from "./sim/index.ts";

describe("parseBackendParam", () => {
  it("returns true only for backend=webgl", () => {
    expect(parseBackendParam("?backend=webgl")).toBe(true);
    expect(parseBackendParam("?backend=webgpu")).toBe(false);
    expect(parseBackendParam("")).toBe(false);
  });
});

describe("cloudCentresFromBuffer", () => {
  it("groups blobs by cloud id and averages positions", () => {
    const buf = createBlobBuffer();
    const put = (i: number, x: number, y: number, id: number, type = 0) => {
      const o = i * BLOB_STRIDE;
      buf[o + BLOB.radius] = 0.5;
      buf[o + BLOB.typeCumulus + type] = 1;
      buf[o + BLOB.x] = x;
      buf[o + BLOB.y] = y;
      buf[o + BLOB.mass] = 1;
      buf[o + BLOB.cloudId] = id;
      buf[o + BLOB.alive] = 1;
    };
    put(0, 0, 0, 3);
    put(1, 2, 4, 3);
    put(2, 10, 10, 5, 2);
    expect(cloudCentresFromBuffer(buf, 3)).toEqual([
      { id: 3, x: 1, y: 2, blobs: 2, type: "cumulus" },
      { id: 5, x: 10, y: 10, blobs: 1, type: "cumulonimbus" },
    ]);
    expect(typeCounts(buf, 3)).toEqual({ cumulus: 1, stratus: 0, cumulonimbus: 1 });
  });

  it("reports a mixed cloud as the type most of its blobs have", () => {
    const buf = createBlobBuffer();
    [1, 1, 2].forEach((type, i) => {
      const o = i * BLOB_STRIDE;
      buf[o + BLOB.mass] = 1;
      buf[o + BLOB.cloudId] = 1;
      buf[o + BLOB.alive] = 1;
      buf[o + BLOB.typeCumulus + type] = 1;
    });
    expect(cloudCentresFromBuffer(buf, 3).map((c) => c.type)).toEqual(["stratus"]);
  });
});
