import { describe, expect, it } from "vitest";
import { parseBackendParam } from "./harness.ts";

describe("parseBackendParam", () => {
  it("returns true only for backend=webgl", () => {
    expect(parseBackendParam("?backend=webgl")).toBe(true);
    expect(parseBackendParam("?backend=webgpu")).toBe(false);
    expect(parseBackendParam("")).toBe(false);
  });
});
