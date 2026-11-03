// CPU side of the volume pass: the RENDER COPY of the blob buffer and the tile lists the raymarch reads. Pure (no three, no DOM).
//
// The sim stays 2D. The renderer gives every blob a 3D ellipsoid (z half-extent r * INFLUENCE_FACTOR * the type's thickness
// scale, plus a stable per-slot depth offset) and, per screen tile, a short list of the blobs whose ellipsoid can reach a ray
// through that tile. The march loops over that list only, so its cost follows local blob density, not the blob count.
//
// Tile texture (one 32x32 RGBA8 texture = 4096 bytes, CSR layout): texel t < cols*rows is tile t's header
// (R,G = u16 offset into the index pool, B = count, A = z half-range / zMax); the pool follows as raw bytes (blob slot per
// byte, EMPTY = 255 in unused entries, so slots 0..253 are addressable). Together with the blob texture (MAX_BLOBS * 48
// bytes) a frame uploads 16,288 of PLAN's 16,384 bytes.

import { BLOB, BLOB_STRIDE, DENSITY_REF_RADIUS, INFLUENCE_FACTOR, MAX_BLOBS } from "../sim/blobBuffer.ts";
import { CAMERA_DISTANCE, VIEW_HEIGHT } from "./view.ts";

/** Marks an unused entry of the index pool; never a valid blob slot (MAX_BLOBS is 254). */
export const EMPTY = 255;
export const TILE_TEX_W = 32;
export const TILE_TEX_H = 32;
export const TILE_TEX_BYTES = TILE_TEX_W * TILE_TEX_H * 4;
/** Headers may use at most this many of the 1024 texels; the rest is the index pool. */
export const MAX_TILES = 340;
/**
 * Hard cap on one tile's list. A pile-up of many blobs would otherwise make one tile loop over all of them for every step
 * of every pixel (a GPU hang). Real scenes peak near 30 entries (the pad below included); the weakest entries drop first.
 */
export const MAX_TILE_LIST = 48;
/** Lists reach this far (world units) past a blob's cut-off radius, so the z-interval pass finds blobs for slanted rays. */
export const LIST_PAD = 0.25;
/** The shader's kernel is cut (and renormalised) at q = QCUT of the blob's reach, so lists need not reach q = 1. */
export const QCUT = 0.9;
/** Stable per-slot z offset, in units of the blob's own z half-extent. */
export const ZOFF_AMP = 0.35;

export interface ZScale {
  cumulus: number;
  stratus: number;
  nimbus: number;
}

/** Integer hash (murmur3 finaliser) to [0, 1): identical in every JS engine, so the same slot always gets the same value. */
export function hash01(i: number): number {
  let h = (i + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Stable depth offset (world units) of blob slot `slot` whose z half-extent is `zh`: in [-ZOFF_AMP, ZOFF_AMP] * zh. */
export const zOffsetOf = (slot: number, zh: number): number => (hash01(slot) * 2 - 1) * ZOFF_AMP * zh;

const extents = new Map<number, { lo: number; hi: number }>();

/**
 * Fill `dst` (a MAX_BLOBS * BLOB_STRIDE buffer) with the render copy of `src`'s first `count` blobs, and `zh` with each blob's
 * z half-extent. `src` is only read. Slots past `count` are zeroed (alive = 0). Layout: see src/sim/blobBuffer.ts.
 */
export function prepareRenderBlobs(src: Float32Array, count: number, dst: Float32Array, zh: Float32Array, zScale: ZScale): void {
  const n = Math.min(count, MAX_BLOBS);
  dst.set(src.subarray(0, n * BLOB_STRIDE));
  dst.fill(0, n * BLOB_STRIDE);
  extents.clear();
  for (let i = 0; i < n; i++) {
    const o = i * BLOB_STRIDE;
    const id = dst[o + BLOB.cloudId] as number;
    const y = dst[o + BLOB.y] as number;
    const r = dst[o + BLOB.radius] as number;
    const e = extents.get(id);
    if (e) {
      e.lo = Math.min(e.lo, y - r);
      e.hi = Math.max(e.hi, y + r);
    } else {
      extents.set(id, { lo: y - r, hi: y + r });
    }
  }
  for (let i = 0; i < n; i++) {
    const o = i * BLOB_STRIDE;
    const e = extents.get(dst[o + BLOB.cloudId] as number);
    const r = dst[o + BLOB.radius] as number;
    dst[o + BLOB.vx] = e ? e.lo : 0;
    dst[o + BLOB.vy] = e ? e.hi : 0;
    const scale =
      (dst[o + BLOB.typeCumulus] as number) * zScale.cumulus +
      (dst[o + BLOB.typeStratus] as number) * zScale.stratus +
      (dst[o + BLOB.typeNimbus] as number) * zScale.nimbus;
    const half = r * INFLUENCE_FACTOR * scale;
    zh[i] = half;
    dst[o + BLOB.spare] = zOffsetOf(i, half);
  }
  zh.fill(0, n);
}

/** Mean radius of the live blobs, weighted by mass: sizes the billows so they follow the clouds' scale (phone layouts are smaller). */
export function meanBlobRadius(buf: Float32Array, count: number): number {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < count; i++) {
    const o = i * BLOB_STRIDE;
    if (buf[o + BLOB.alive] === 0) continue;
    const m = buf[o + BLOB.mass] as number;
    sum += (buf[o + BLOB.radius] as number) * m;
    w += m;
  }
  return w > 0 ? sum / w : 0;
}

export interface TileGrid {
  cols: number;
  rows: number;
  /** Tile edge in world units. */
  size: number;
  /** View width in world units. */
  width: number;
}

/** The smallest tiles (about 0.5 units) whose headers fit MAX_TILES texels: tile size is in world units, so it does not depend on resolution. */
export function tileGrid(aspect: number): TileGrid {
  const width = VIEW_HEIGHT * aspect;
  for (let size = 0.5; ; size += 0.025) {
    const cols = Math.ceil(width / size);
    const rows = Math.ceil(VIEW_HEIGHT / size);
    if (cols * rows <= MAX_TILES) return { cols, rows, size, width };
  }
}

/**
 * How far (world units) from a blob's centre a tile's rectangle may be and still list it. The z-interval pass tests the blob
 * where the pixel's eye ray crosses the blob's own depth `zOffset` (the density lookups use the tile of each sample's own
 * position, so they need no pad): the ray is displaced by |eye - pixel| * |zOffset| / CAMERA_DISTANCE there, which gives the
 * cut-off kernel's reach plus that slant (solved for a pixel whose own distance to the eye grows with the blob's), plus LIST_PAD.
 */
export function listReach(x: number, y: number, radius: number, zOffset: number, eye: { x: number; y: number }): number {
  const k = Math.abs(zOffset) / CAMERA_DISTANCE;
  return (radius * INFLUENCE_FACTOR * QCUT + Math.hypot(eye.x - x, eye.y - y) * k) / (1 - k) + LIST_PAD;
}

export interface TileStats {
  tiles: number;
  nonEmpty: number;
  /** Longest list before any cap. */
  worstBlobsPerTile: number;
  /** Entries stored in the pool. */
  listed: number;
  /** Entries cut by MAX_TILE_LIST or the pool's capacity, weakest first. */
  overflowDropped: number;
  /** z half-range the header's A channel is a fraction of. */
  zMax: number;
}

export function createTileBuilder() {
  // Per tile, entries sorted by strength (kernel weight at the tile's nearest point), strongest first; ties by blob slot.
  const slot = new Uint8Array(MAX_TILES * MAX_BLOBS);
  const weight = new Float64Array(MAX_TILES * MAX_BLOBS);
  const len = new Int32Array(MAX_TILES);
  const zt = new Float32Array(MAX_TILES);
  const stats: TileStats = { tiles: 0, nonEmpty: 0, worstBlobsPerTile: 0, listed: 0, overflowDropped: 0, zMax: 1 };

  /**
   * Build the tile texture bytes into `out` (TILE_TEX_BYTES) from a render copy. Deterministic: the same blobs, grid and eye
   * give the same bytes. When lists do not fit, each is cut to the largest common length that does (weakest entries first).
   */
  function build(buf: Float32Array, zh: Float32Array, count: number, grid: TileGrid, eye: { x: number; y: number }, out: Uint8Array): TileStats {
    const { cols, rows, size } = grid;
    const H = cols * rows;
    const x0 = -grid.width / 2;
    const y0 = -VIEW_HEIGHT / 2;
    const capacity = (TILE_TEX_W * TILE_TEX_H - H) * 4;
    len.fill(0, 0, H);
    zt.fill(0, 0, H);
    let zMax = 0.5;
    const n = Math.min(count, MAX_BLOBS);
    for (let i = 0; i < n; i++) {
      const o = i * BLOB_STRIDE;
      zMax = Math.max(zMax, Math.abs(buf[o + BLOB.spare] as number) + (zh[i] as number));
    }
    for (let i = 0; i < n; i++) {
      const o = i * BLOB_STRIDE;
      if (buf[o + BLOB.alive] === 0) continue;
      const x = buf[o + BLOB.x] as number;
      const y = buf[o + BLOB.y] as number;
      const r = buf[o + BLOB.radius] as number;
      const R = r * INFLUENCE_FACTOR;
      const k = (buf[o + BLOB.mass] as number) * (DENSITY_REF_RADIUS / r) ** 2;
      const zext = Math.abs(buf[o + BLOB.spare] as number) + (zh[i] as number);
      const reach = listReach(x, y, r, buf[o + BLOB.spare] as number, eye);
      const ti0 = Math.max(0, Math.floor((x - reach - x0) / size));
      const ti1 = Math.min(cols - 1, Math.floor((x + reach - x0) / size));
      const tj0 = Math.max(0, Math.floor((y - reach - y0) / size));
      const tj1 = Math.min(rows - 1, Math.floor((y + reach - y0) / size));
      for (let tj = tj0; tj <= tj1; tj++) {
        for (let ti = ti0; ti <= ti1; ti++) {
          const rx0 = x0 + ti * size;
          const ry0 = y0 + tj * size;
          const dx = Math.max(rx0 - x, 0, x - (rx0 + size));
          const dy = Math.max(ry0 - y, 0, y - (ry0 + size));
          const d2 = dx * dx + dy * dy;
          if (d2 >= reach * reach) continue;
          const t = tj * cols + ti;
          const w = (1 - Math.min(1, d2 / (R * R))) ** 3 * k;
          // Insert keeping strongest-first; equal weights keep ascending slot order because slots arrive ascending.
          const base = t * MAX_BLOBS;
          let j = len[t] as number;
          while (j > 0 && (weight[base + j - 1] as number) < w) {
            weight[base + j] = weight[base + j - 1] as number;
            slot[base + j] = slot[base + j - 1] as number;
            j--;
          }
          weight[base + j] = w;
          slot[base + j] = i;
          len[t] = (len[t] as number) + 1;
          zt[t] = Math.max(zt[t] as number, zext);
        }
      }
    }

    let worst = 0;
    let nonEmpty = 0;
    for (let t = 0; t < H; t++) {
      const l = len[t] as number;
      worst = Math.max(worst, l);
      if (l > 0) nonEmpty++;
    }
    let cap = Math.min(worst, MAX_TILE_LIST);
    const total = (c: number): number => {
      let s = 0;
      for (let t = 0; t < H; t++) s += Math.min(len[t] as number, c);
      return s;
    };
    while (cap > 1 && total(cap) > capacity) cap--;

    out.fill(0, 0, H * 4);
    out.fill(EMPTY, H * 4);
    let off = 0;
    let dropped = 0;
    for (let t = 0; t < H; t++) {
      const l = len[t] as number;
      const c = Math.min(l, cap);
      dropped += l - c;
      out[t * 4] = off & 255;
      out[t * 4 + 1] = off >> 8;
      out[t * 4 + 2] = c;
      out[t * 4 + 3] = l > 0 ? Math.min(255, Math.ceil(((zt[t] as number) / zMax) * 255)) : 0;
      const base = t * MAX_BLOBS;
      for (let j = 0; j < c; j++) out[H * 4 + off + j] = slot[base + j] as number;
      off += c;
    }
    stats.tiles = H;
    stats.nonEmpty = nonEmpty;
    stats.worstBlobsPerTile = worst;
    stats.listed = off;
    stats.overflowDropped = dropped;
    stats.zMax = zMax;
    return stats;
  }
  return { build, stats };
}

/** Decoded header of tile `t` from tile-texture bytes (for tests and debugging). */
export function readTile(out: Uint8Array, cols: number, rows: number, t: number): { offset: number; count: number; zFrac: number; slots: number[] } {
  const H = cols * rows;
  const offset = (out[t * 4] as number) + ((out[t * 4 + 1] as number) << 8);
  const count = out[t * 4 + 2] as number;
  const slots: number[] = [];
  for (let j = 0; j < count; j++) slots.push(out[H * 4 + offset + j] as number);
  return { offset, count, zFrac: (out[t * 4 + 3] as number) / 255, slots };
}
