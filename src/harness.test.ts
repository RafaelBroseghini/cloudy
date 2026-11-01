import { describe, expect, it } from "vitest";
import { cloudCentresFromBuffer, parseBackendParam } from "./harness.ts";
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
    const put = (i: number, x: number, y: number, id: number) => {
      const o = i * BLOB_STRIDE;
      buf[o + BLOB.x] = x;
      buf[o + BLOB.y] = y;
      buf[o + BLOB.mass] = 1;
      buf[o + BLOB.cloudId] = id;
      buf[o + BLOB.alive] = 1;
    };
    put(0, 0, 0, 3);
    put(1, 2, 4, 3);
    put(2, 10, 10, 5);
    expect(cloudCentresFromBuffer(buf, 3)).toEqual([
      { id: 3, x: 1, y: 2, blobs: 2 },
      { id: 5, x: 10, y: 10, blobs: 1 },
    ]);
  });
});
