import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BLOB, BLOB_STRIDE, DENSITY_REF_RADIUS, INFLUENCE_FACTOR, MAX_BLOBS, createBlobBuffer } from "../sim/blobBuffer.ts";
import { sceneSpec, buildLayout, type SceneName } from "../sim/scene.ts";
import {
  EMPTY,
  MAX_TILE_LIST,
  MAX_TILES,
  QCUT,
  TILE_TEX_BYTES,
  TILE_TEX_H,
  TILE_TEX_W,
  ZOFF_AMP,
  createTileBuilder,
  hash01,
  listReach,
  meanBlobRadius,
  prepareRenderBlobs,
  rayKernelChord,
  readTile,
  tileGrid,
  zOffsetOf,
  type ZScale,
} from "./tiles.ts";
import { CAMERA_DISTANCE, EYE_MAX, VIEW_HEIGHT } from "./view.ts";
import { createBlobTexture, createTileTexture } from "./volume.ts";

const Z: ZScale = { cumulus: 1.15, stratus: 0.38, nimbus: 1.9 };
const NO_EYE = { x: 0, y: 0 };

interface TestBlob {
  x: number;
  y: number;
  r: number;
  type: 0 | 1 | 2;
  cloud: number;
}

/** A sim-style blob buffer (the layout of src/sim/blobBuffer.ts) from a list of blobs. */
function simBuffer(blobs: readonly TestBlob[]): Float32Array {
  const buf = createBlobBuffer();
  blobs.forEach((b, i) => {
    const o = i * BLOB_STRIDE;
    buf[o + BLOB.x] = b.x;
    buf[o + BLOB.y] = b.y;
    buf[o + BLOB.radius] = b.r;
    buf[o + BLOB.mass] = Math.PI * b.r * b.r;
    buf[o + BLOB.vx] = 0.37 * i; // the sim's velocities: the render copy must overwrite them, the sim's buffer must keep them
    buf[o + BLOB.vy] = -0.11 * i;
    buf[o + BLOB.cloudId] = b.cloud;
    buf[o + BLOB.alive] = 1;
    buf[o + BLOB.typeCumulus + b.type] = 1;
  });
  return buf;
}

function renderCopy(blobs: readonly TestBlob[], z: ZScale = Z): { buf: Float32Array; zh: Float32Array } {
  const src = simBuffer(blobs);
  const buf = new Float32Array(MAX_BLOBS * BLOB_STRIDE);
  const zh = new Float32Array(MAX_BLOBS);
  prepareRenderBlobs(src, blobs.length, buf, zh, z);
  return { buf, zh };
}

const blobArb = (halfW: number): fc.Arbitrary<TestBlob> =>
  fc.record({
    x: fc.double({ min: -halfW, max: halfW, noNaN: true }),
    y: fc.double({ min: -VIEW_HEIGHT / 2, max: VIEW_HEIGHT / 2, noNaN: true }),
    r: fc.double({ min: 0.2, max: 0.7, noNaN: true }),
    type: fc.constantFrom(0, 1, 2) as fc.Arbitrary<0 | 1 | 2>,
    cloud: fc.integer({ min: 0, max: 5 }),
  });
const eyeArb = fc.record({ x: fc.double({ min: -EYE_MAX, max: EYE_MAX, noNaN: true }), y: fc.double({ min: -EYE_MAX, max: EYE_MAX, noNaN: true }) });
const aspectArb = fc.double({ min: 0.46, max: 2.4, noNaN: true });

describe("slots and the empty marker", () => {
  it("MAX_BLOBS leaves 255 free as the empty marker", () => {
    expect(MAX_BLOBS).toBe(254);
    expect(EMPTY).toBe(255);
    expect(MAX_BLOBS - 1).toBeLessThan(EMPTY);
  });

  it("every named scene fits, at any view", () => {
    for (const name of ["m1", "clear", "rain", "thunder", "mixed", "lone"] as SceneName[]) {
      for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [2560, 1080], [320, 568], [1024, 1366]] as const) {
        const spec = sceneSpec(name, (VIEW_HEIGHT * w) / h, VIEW_HEIGHT);
        expect(buildLayout(spec).blobs.length).toBeLessThanOrEqual(MAX_BLOBS);
      }
    }
  });
});

describe("per-slot z hash", () => {
  it("is stable: the same slot always gets the same value, in [0, 1)", () => {
    // Pinned: integer math only, so every engine agrees, and a slot keeps its offset for as long as the code does.
    expect([0, 1, 2, 253].map(hash01)).toEqual([0, 1, 2, 253].map(hash01));
    expect(hash01(0)).toBeCloseTo(0.5734, 4);
    expect(hash01(1)).toBeCloseTo(0.5884, 4);
    fc.assert(fc.property(fc.integer({ min: 0, max: MAX_BLOBS - 1 }), (i) => hash01(i) >= 0 && hash01(i) < 1 && hash01(i) === hash01(i)));
  });

  it("spreads the slots (not all alike) and keeps every offset within ZOFF_AMP of the blob's z half-extent", () => {
    const vals = Array.from({ length: MAX_BLOBS }, (_, i) => hash01(i));
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.9);
    expect(vals.reduce((a, b) => a + b, 0) / vals.length).toBeCloseTo(0.5, 1);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_BLOBS - 1 }), fc.double({ min: 0, max: 4, noNaN: true }), (i, zh) => {
        expect(Math.abs(zOffsetOf(i, zh))).toBeLessThanOrEqual(ZOFF_AMP * zh + 1e-12);
      }),
    );
  });

  it("does not depend on the blob's position, type or the other blobs: only the slot", () => {
    const a = renderCopy([{ x: 0, y: 0, r: 0.5, type: 0, cloud: 1 }, { x: 3, y: 1, r: 0.4, type: 2, cloud: 2 }]);
    const b = renderCopy([{ x: -2, y: 4, r: 0.5, type: 0, cloud: 1 }, { x: 5, y: -1, r: 0.4, type: 2, cloud: 2 }]);
    for (let i = 0; i < 2; i++) {
      expect(a.buf[i * BLOB_STRIDE + BLOB.spare]! / a.zh[i]!).toBeCloseTo(b.buf[i * BLOB_STRIDE + BLOB.spare]! / b.zh[i]!, 5);
    }
  });
});

describe("render copy of the blob buffer", () => {
  const blobs: TestBlob[] = [
    { x: 0, y: 0, r: 0.5, type: 0, cloud: 4 },
    { x: 1, y: 1.5, r: 0.4, type: 0, cloud: 4 },
    { x: -3, y: -2, r: 0.3, type: 1, cloud: 7 },
    { x: 4, y: 2, r: 0.6, type: 2, cloud: 9 },
  ];

  it("leaves the sim's buffer byte for byte as it was, and never aliases it", () => {
    const src = simBuffer(blobs);
    const before = src.slice();
    const dst = new Float32Array(MAX_BLOBS * BLOB_STRIDE);
    prepareRenderBlobs(src, blobs.length, dst, new Float32Array(MAX_BLOBS), Z);
    expect(new Uint8Array(src.buffer)).toEqual(new Uint8Array(before.buffer));
    expect(dst.buffer).not.toBe(src.buffer);
    dst.fill(7);
    expect(new Uint8Array(src.buffer)).toEqual(new Uint8Array(before.buffer));
  });

  it("copies x, y, radius, mass, cloud id, alive and the type one-hot unchanged", () => {
    const src = simBuffer(blobs);
    const { buf } = renderCopy(blobs);
    for (let i = 0; i < blobs.length; i++) {
      for (const k of [BLOB.x, BLOB.y, BLOB.radius, BLOB.mass, BLOB.cloudId, BLOB.alive, BLOB.typeCumulus, BLOB.typeStratus, BLOB.typeNimbus]) {
        expect(buf[i * BLOB_STRIDE + k]).toBe(src[i * BLOB_STRIDE + k]);
      }
    }
  });

  it("puts the cloud's base and top y in slots 4 and 5, and the z offset in slot 11", () => {
    const { buf, zh } = renderCopy(blobs);
    // Cloud 4 is blobs 0 and 1: base = min(y - r), top = max(y + r).
    for (const i of [0, 1]) {
      expect(buf[i * BLOB_STRIDE + BLOB.vx]).toBeCloseTo(-0.5, 6);
      expect(buf[i * BLOB_STRIDE + BLOB.vy]).toBeCloseTo(1.9, 6);
    }
    expect(buf[2 * BLOB_STRIDE + BLOB.vx]).toBeCloseTo(-2.3, 6);
    expect(buf[2 * BLOB_STRIDE + BLOB.vy]).toBeCloseTo(-1.7, 6);
    // z half-extent = r * INFLUENCE_FACTOR * the type's scale; the offset is the hash of the slot times it.
    expect(zh[0]).toBeCloseTo(0.5 * INFLUENCE_FACTOR * Z.cumulus, 5);
    expect(zh[2]).toBeCloseTo(0.3 * INFLUENCE_FACTOR * Z.stratus, 5);
    expect(zh[3]).toBeCloseTo(0.6 * INFLUENCE_FACTOR * Z.nimbus, 5);
    for (let i = 0; i < blobs.length; i++) expect(buf[i * BLOB_STRIDE + BLOB.spare]).toBeCloseTo(zOffsetOf(i, zh[i]!), 5);
  });

  it("zeroes the slots past the live count, so they are dead", () => {
    const src = simBuffer(blobs);
    const dst = new Float32Array(MAX_BLOBS * BLOB_STRIDE).fill(3);
    prepareRenderBlobs(src, blobs.length, dst, new Float32Array(MAX_BLOBS).fill(3), Z);
    for (let i = blobs.length; i < MAX_BLOBS; i++) expect(dst[i * BLOB_STRIDE + BLOB.alive]).toBe(0);
  });

  it("mass-weighted mean radius ignores dead slots", () => {
    expect(meanBlobRadius(simBuffer(blobs), 4)).toBeGreaterThan(0.3);
    expect(meanBlobRadius(createBlobBuffer(), 0)).toBe(0);
  });
});

describe("the z-interval chord of an eye ray through a blob's kernel", () => {
  const blobArb2 = fc.record({
    x: fc.double({ min: -3, max: 3, noNaN: true }),
    y: fc.double({ min: -3, max: 3, noNaN: true }),
    z: fc.double({ min: -1, max: 1, noNaN: true }),
    R: fc.double({ min: 0.3, max: 1.8, noNaN: true }),
    H: fc.double({ min: 0.2, max: 3, noNaN: true }),
  });
  const pxArb = fc.record({ x: fc.double({ min: -5, max: 5, noNaN: true }), y: fc.double({ min: -4, max: 4, noNaN: true }) });
  /** Is the sample the ray has at depth z inside the kernel's support? */
  const inside = (p: { x: number; y: number }, eye: { x: number; y: number }, b: { x: number; y: number; z: number; R: number; H: number }, z: number): boolean => {
    const sx = p.x + ((eye.x - p.x) * z) / CAMERA_DISTANCE;
    const sy = p.y + ((eye.y - p.y) * z) / CAMERA_DISTANCE;
    return ((sx - b.x) / b.R) ** 2 + ((sy - b.y) / b.R) ** 2 + ((z - b.z) / b.H) ** 2 < QCUT * QCUT;
  };

  it("its ends lie on the kernel's cut-off and every depth between them is inside it, for any eye", () => {
    fc.assert(
      fc.property(blobArb2, pxArb, eyeArb, (b, p, eye) => {
        const c = rayKernelChord(p, eye, b);
        if (!c) return;
        expect(c.hi).toBeGreaterThan(c.lo);
        for (const z of [c.lo, c.hi]) {
          const sx = p.x + ((eye.x - p.x) * z) / CAMERA_DISTANCE;
          const sy = p.y + ((eye.y - p.y) * z) / CAMERA_DISTANCE;
          expect(((sx - b.x) / b.R) ** 2 + ((sy - b.y) / b.R) ** 2 + ((z - b.z) / b.H) ** 2).toBeCloseTo(QCUT * QCUT, 6);
        }
        for (const f of [0.02, 0.25, 0.5, 0.75, 0.98]) expect(inside(p, eye, b, c.lo + (c.hi - c.lo) * f)).toBe(true);
        expect(inside(p, eye, b, c.lo - 1e-3)).toBe(false);
        expect(inside(p, eye, b, c.hi + 1e-3)).toBe(false);
      }),
      // Seeded: a ray that grazes the kernel (a root pair closer than the 1e-6 closeness test resolves) can legitimately trip it.
      { numRuns: 200, seed: 20261102 },
    );
  });

  it("a ray that is never inside the kernel misses: no chord", () => {
    fc.assert(
      fc.property(blobArb2, pxArb, eyeArb, (b, p, eye) => {
        if (rayKernelChord(p, eye, b)) return;
        for (let z = -4; z <= 4; z += 0.05) expect(inside(p, eye, b, z)).toBe(false);
      }),
      { numRuns: 100, seed: 20261103 },
    );
  });

  it("with the eye straight on it is the vertical chord R-free half-extent H * sqrt(QCUT^2 - q^2) around the blob's depth", () => {
    const b = { x: 0.3, y: -0.2, z: 0.1, R: 1, H: 1.5 };
    const p = { x: 0.6, y: 0.1 };
    const c = rayKernelChord(p, p, b); // eye straight above the pixel: e = 0
    const q2 = ((p.x - b.x) / b.R) ** 2 + ((p.y - b.y) / b.R) ** 2;
    const half = b.H * Math.sqrt(QCUT * QCUT - q2);
    expect(c?.lo).toBeCloseTo(b.z - half, 9);
    expect(c?.hi).toBeCloseTo(b.z + half, 9);
  });

  it("a slanted ray's chord is shifted and shortened compared with the vertical one", () => {
    const b = { x: 0, y: 0, z: 0, R: 1, H: 1 };
    const p = { x: 0, y: 0 };
    const straight = rayKernelChord(p, p, b) as { lo: number; hi: number };
    const slanted = rayKernelChord(p, { x: EYE_MAX, y: 0 }, b) as { lo: number; hi: number };
    expect(slanted.hi - slanted.lo).toBeLessThan(straight.hi - straight.lo);
  });
});

describe("tile lists", () => {
  const build = (blobs: readonly TestBlob[], aspect: number, eye = NO_EYE, z: ZScale = Z) => {
    const { buf, zh } = renderCopy(blobs, z);
    const grid = tileGrid(aspect);
    const out = new Uint8Array(TILE_TEX_BYTES);
    const stats = createTileBuilder().build(buf, zh, blobs.length, grid, eye, out);
    return { buf, zh, grid, out, stats };
  };
  const tileOf = (grid: ReturnType<typeof tileGrid>, x: number, y: number): number => {
    const ti = Math.min(grid.cols - 1, Math.max(0, Math.floor((x + grid.width / 2) / grid.size)));
    const tj = Math.min(grid.rows - 1, Math.max(0, Math.floor((y + VIEW_HEIGHT / 2) / grid.size)));
    return tj * grid.cols + ti;
  };

  it("the grid keeps its headers within MAX_TILES and tiles about half a unit, at any aspect", () => {
    fc.assert(
      fc.property(aspectArb, (a) => {
        const g = tileGrid(a);
        expect(g.cols * g.rows).toBeLessThanOrEqual(MAX_TILES);
        expect(g.cols * g.size).toBeGreaterThanOrEqual(g.width);
        expect(g.rows * g.size).toBeGreaterThanOrEqual(VIEW_HEIGHT);
        expect(g.size).toBeLessThan(1.1);
      }),
    );
    expect(TILE_TEX_W * TILE_TEX_H).toBe(1024);
  });

  it("every blob is listed in every tile its 3D influence overlaps (when nothing overflows)", () => {
    fc.assert(
      fc.property(aspectArb, eyeArb, fc.array(blobArb(8), { minLength: 1, maxLength: 30 }), (aspect, eye, blobs) => {
        const { buf, grid, out, stats } = build(blobs, aspect, eye);
        fc.pre(stats.overflowDropped === 0);
        for (let i = 0; i < blobs.length; i++) {
          const o = i * BLOB_STRIDE;
          const x = buf[o + BLOB.x]!;
          const y = buf[o + BLOB.y]!;
          const reach = listReach(x, y, buf[o + BLOB.radius]!, buf[o + BLOB.spare]!, eye);
          for (let t = 0; t < grid.cols * grid.rows; t++) {
            const tx0 = -grid.width / 2 + (t % grid.cols) * grid.size;
            const ty0 = -VIEW_HEIGHT / 2 + Math.floor(t / grid.cols) * grid.size;
            const d = Math.hypot(Math.max(tx0 - x, 0, x - (tx0 + grid.size)), Math.max(ty0 - y, 0, y - (ty0 + grid.size)));
            if (d < reach * 0.999) expect(readTile(out, grid.cols, grid.rows, t).slots, `blob ${i} tile ${t}`).toContain(i);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("any point inside a blob's cut-off kernel finds the blob in its own tile (the density lookups)", () => {
    fc.assert(
      fc.property(aspectArb, eyeArb, fc.array(blobArb(8), { minLength: 1, maxLength: 30 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: Math.PI * 2, noNaN: true }), (aspect, eye, blobs, f, ang) => {
        const { buf, grid, out, stats } = build(blobs, aspect, eye);
        fc.pre(stats.overflowDropped === 0);
        for (let i = 0; i < blobs.length; i++) {
          const R = buf[i * BLOB_STRIDE + BLOB.radius]! * INFLUENCE_FACTOR;
          const px = buf[i * BLOB_STRIDE + BLOB.x]! + Math.cos(ang) * R * QCUT * f * 0.999;
          const py = buf[i * BLOB_STRIDE + BLOB.y]! + Math.sin(ang) * R * QCUT * f * 0.999;
          // The shader clamps a point outside the view onto the edge tile; a point past it has no tile of its own.
          if (Math.abs(px) > grid.width / 2 || Math.abs(py) > VIEW_HEIGHT / 2) continue;
          expect(readTile(out, grid.cols, grid.rows, tileOf(grid, px, py)).slots).toContain(i);
        }
      }),
      { numRuns: 80 },
    );
  });

  it("eye rays find their blobs: the chord test of the z-interval pass never misses a blob that is not listed", () => {
    fc.assert(
      fc.property(
        aspectArb,
        eyeArb,
        fc.array(blobArb(8), { minLength: 1, maxLength: 40 }),
        fc.array(fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true })), { minLength: 20, maxLength: 20 }),
        (aspect, eye, blobs, px) => {
          const { buf, grid, out, stats } = build(blobs, aspect, eye);
          fc.pre(stats.overflowDropped === 0);
          for (const [u, v] of px) {
            const wx = (u * grid.width) / 2;
            const wy = (v * VIEW_HEIGHT) / 2;
            const slots = readTile(out, grid.cols, grid.rows, tileOf(grid, wx, wy)).slots;
            for (let i = 0; i < blobs.length; i++) {
              const o = i * BLOB_STRIDE;
              const zc = buf[o + BLOB.spare]!;
              const rx = wx + ((eye.x - wx) * zc) / CAMERA_DISTANCE;
              const ry = wy + ((eye.y - wy) * zc) / CAMERA_DISTANCE;
              const R = buf[o + BLOB.radius]! * INFLUENCE_FACTOR;
              if (Math.hypot(rx - buf[o + BLOB.x]!, ry - buf[o + BLOB.y]!) < R * QCUT * 0.999) expect(slots, `pixel ${wx},${wy} blob ${i}`).toContain(i);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("is deterministic, and the CSR offsets and counts are consistent", () => {
    fc.assert(
      fc.property(aspectArb, eyeArb, fc.array(blobArb(8), { minLength: 0, maxLength: 60 }), (aspect, eye, blobs) => {
        const a = build(blobs, aspect, eye);
        const b = build(blobs, aspect, eye);
        expect(a.out).toEqual(b.out);
        const H = a.grid.cols * a.grid.rows;
        let off = 0;
        for (let t = 0; t < H; t++) {
          const h = readTile(a.out, a.grid.cols, a.grid.rows, t);
          expect(h.offset).toBe(off);
          expect(h.count).toBeLessThanOrEqual(MAX_TILE_LIST);
          off += h.count;
        }
        expect(off).toBe(a.stats.listed);
        expect(off).toBeLessThanOrEqual((TILE_TEX_W * TILE_TEX_H - H) * 4);
        // Everything after the last list is the empty marker; every listed entry is a live slot, below it.
        for (let k = H * 4 + off; k < TILE_TEX_BYTES; k++) expect(a.out[k]).toBe(EMPTY);
        for (let k = H * 4; k < H * 4 + off; k++) {
          expect(a.out[k]).toBeLessThan(Math.max(1, blobs.length));
          expect(a.out[k]).not.toBe(EMPTY);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("an empty sky lists nothing and never reads a blob", () => {
    const { out, stats, grid } = build([], 1.6);
    expect(stats.listed).toBe(0);
    for (let t = 0; t < grid.cols * grid.rows; t++) expect(readTile(out, grid.cols, grid.rows, t).count).toBe(0);
  });

  it("a pile-up overflows deterministically and drops the weakest first", () => {
    // 254 blobs in a 3 x 1.5 patch: far past MAX_TILE_LIST per tile.
    const pile: TestBlob[] = Array.from({ length: MAX_BLOBS }, (_, i) => ({
      x: ((i * 0.6180339887) % 1) * 3 - 1.5,
      y: ((i * 0.7548776662) % 1) * 1.5 - 0.75,
      r: 0.4 + (i % 5) * 0.02,
      type: (i % 3) as 0 | 1 | 2,
      cloud: i % 4,
    }));
    const { buf, grid, out, stats } = build(pile, 1.6);
    expect(stats.worstBlobsPerTile).toBeGreaterThan(MAX_TILE_LIST);
    expect(stats.overflowDropped).toBeGreaterThan(0);
    expect(stats.listed + stats.overflowDropped).toBeGreaterThan(stats.listed);
    // Brute force: every tile's list is a prefix of all candidates sorted by (weight desc, slot asc).
    for (let t = 0; t < grid.cols * grid.rows; t++) {
      const tx0 = -grid.width / 2 + (t % grid.cols) * grid.size;
      const ty0 = -VIEW_HEIGHT / 2 + Math.floor(t / grid.cols) * grid.size;
      const all: Array<{ i: number; w: number }> = [];
      for (let i = 0; i < pile.length; i++) {
        const o = i * BLOB_STRIDE;
        const x = buf[o + BLOB.x]!;
        const y = buf[o + BLOB.y]!;
        const r = buf[o + BLOB.radius]!;
        const reach = listReach(x, y, r, buf[o + BLOB.spare]!, NO_EYE);
        const d2 = Math.max(tx0 - x, 0, x - (tx0 + grid.size)) ** 2 + Math.max(ty0 - y, 0, y - (ty0 + grid.size)) ** 2;
        if (d2 < reach * reach) all.push({ i, w: (1 - Math.min(1, d2 / (r * INFLUENCE_FACTOR) ** 2)) ** 3 * buf[o + BLOB.mass]! * (DENSITY_REF_RADIUS / r) ** 2 });
      }
      all.sort((a, b) => b.w - a.w || a.i - b.i);
      const got = readTile(out, grid.cols, grid.rows, t).slots;
      expect(got).toEqual(all.slice(0, got.length).map((e) => e.i));
    }
    const again = build(pile, 1.6);
    expect(again.out).toEqual(out);
  });

  it("the tile and blob textures together upload at most 16 KiB, counted from the real arrays", () => {
    const bytes = (createBlobTexture().image.data as Float32Array).byteLength + (createTileTexture().image.data as Uint8Array).byteLength;
    expect(bytes).toBe(MAX_BLOBS * BLOB_STRIDE * 4 + TILE_TEX_BYTES);
    expect(bytes).toBe(16_288);
    expect(bytes).toBeLessThanOrEqual(16_384);
  });

  it("every shipped scene fits its tile lists without dropping anything, at any view and any eye", () => {
    const eyes = [NO_EYE, { x: EYE_MAX, y: EYE_MAX }, { x: -EYE_MAX, y: EYE_MAX }, { x: EYE_MAX, y: -EYE_MAX }, { x: -EYE_MAX, y: -EYE_MAX }];
    let worst = 0;
    for (const name of ["m1", "clear", "rain", "thunder", "mixed", "lone"] as SceneName[]) {
      for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [1920, 1080], [2560, 1080], [3440, 1440]] as const) {
        const layout = buildLayout(sceneSpec(name, (VIEW_HEIGHT * w) / h, VIEW_HEIGHT));
        const blobs: TestBlob[] = layout.blobs.map((b) => ({ x: b.x, y: b.y, r: b.radius, type: b.type === "cumulus" ? 0 : b.type === "stratus" ? 1 : 2, cloud: b.cloud }));
        for (const eye of eyes) {
          const { stats } = build(blobs, w / h, eye);
          expect(stats.overflowDropped, `${name} ${w}x${h}`).toBe(0);
          worst = Math.max(worst, stats.worstBlobsPerTile);
        }
      }
    }
    // MAX_TILE_LIST has headroom over the real worst case (about 41, at the widest eye and the smallest tiles).
    expect(worst).toBeLessThanOrEqual(MAX_TILE_LIST * 0.9);
  });
});
