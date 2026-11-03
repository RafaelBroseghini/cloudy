// Baked, tileable 3D noise for the clouds' erosion (once, 48^3 RGBA8 = 442 KB). Pure and resumable: `step(budgetMs)` bakes a few
// rows at a time, so the game can bake it across frames after the first render instead of stalling (about 0.5 s in all).
//
//   R: Perlin-Worley (3-octave simplex fbm, remapped by an inverse Worley term: the "billowy but connected" Nubis base)
//   G: Worley fbm, 3/6/12 cells    B: Worley fbm, 6/12 cells    A: Worley, 12 cells (fine detail)
// Nothing is finer than 12 cells per 48 texels: at 4 texels per cell trilinear sampling does not alias (24 cells hatched).
// Recipe after Schneider (Horizon Zero Dawn, Nubis); the Perlin channel is `simplex-noise` (MIT), made periodic by cross-fading
// the 8 shifted copies; the Worley term is the small cellular function below.

import { createNoise3D } from "simplex-noise";
import { mulberry32 } from "../sim/scene.ts";

export const NOISE_SIZE = 48;

/** Worley F1 on a `cells`^3 wrapped lattice: x, y, z in [0, 1) give the distance to the nearest feature point, in cell units, clamped to 1. */
function worleyField(cells: number, rnd: () => number): (x: number, y: number, z: number) => number {
  const pts = new Float32Array(cells ** 3 * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = rnd();
  const wrap = (v: number): number => ((v % cells) + cells) % cells;
  return (x, y, z) => {
    const px = x * cells;
    const py = y * cells;
    const pz = z * cells;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const cz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((wrap(cz + dz) * cells + wrap(cy + dy)) * cells + wrap(cx + dx)) * 3;
          const ex = cx + dx + (pts[i] as number) - px;
          const ey = cy + dy + (pts[i + 1] as number) - py;
          const ez = cz + dz + (pts[i + 2] as number) - pz;
          best = Math.min(best, ex * ex + ey * ey + ez * ez);
        }
      }
    }
    return Math.min(1, Math.sqrt(best));
  };
}

/** Simplex lattice units across one period of the Perlin channel. */
const PERLIN_PERIOD = 4;

export function createNoiseBaker(size: number = NOISE_SIZE) {
  const rnd = mulberry32(1337);
  const simplex = createNoise3D(mulberry32(7));
  const fbm = (x: number, y: number, z: number): number => {
    let a = 0.55;
    let f = 1;
    let s = 0;
    for (let o = 0; o < 3; o++) {
      s += a * simplex(x * f, y * f, z * f);
      a *= 0.5;
      f *= 2;
    }
    return s / 0.875;
  };
  /** Periodic with period 1: the 8 shifted samples are blended by their distance to the cell the point is in. */
  const tile = (x: number, y: number, z: number): number => {
    let acc = 0;
    for (let k = 0; k < 8; k++) {
      const sx = k & 1;
      const sy = (k >> 1) & 1;
      const sz = (k >> 2) & 1;
      const wx = sx ? x : 1 - x;
      const wy = sy ? y : 1 - y;
      const wz = sz ? z : 1 - z;
      acc += wx * wy * wz * fbm((x - sx) * PERLIN_PERIOD, (y - sy) * PERLIN_PERIOD, (z - sz) * PERLIN_PERIOD);
    }
    return acc;
  };
  const w3 = [worleyField(3, rnd), worleyField(6, rnd), worleyField(12, rnd)] as const;
  const w6 = [worleyField(6, rnd), worleyField(12, rnd)] as const;
  const w12 = worleyField(12, rnd);
  const data = new Uint8Array(size ** 3 * 4);
  const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  const rows = size * size;
  let row = 0;

  function bakeRow(r: number): void {
    const z = Math.floor(r / size);
    const y = r % size;
    let i = r * size * 4;
    const v = y / size;
    const w = z / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const per = Math.min(1, Math.max(0, tile(u, v, w) * 0.9 * 0.5 + 0.5));
      const wl = 1 - (w3[0](u, v, w) * 0.625 + w3[1](u, v, w) * 0.25 + w3[2](u, v, w) * 0.125);
      const wm = 1 - (w6[0](u, v, w) * 0.65 + w6[1](u, v, w) * 0.35);
      const wh = 1 - w12(u, v, w);
      // Perlin-Worley: remap the Perlin value from [worley-ish, 1] to [0, 1].
      const pw = Math.min(1, Math.max(0, (per - wl * 0.55) / (1 - wl * 0.55)));
      data[i++] = byte(pw);
      data[i++] = byte(wl);
      data[i++] = byte(wm);
      data[i++] = byte(wh);
    }
  }

  return {
    size,
    data,
    get done(): boolean {
      return row >= rows;
    },
    /** Bake rows until `budgetMs` of `now()` has passed (at least one row). Returns true once the whole volume is baked. */
    step(budgetMs: number, now: () => number = () => performance.now()): boolean {
      const t0 = now();
      do {
        if (row >= rows) break;
        bakeRow(row++);
      } while (now() - t0 < budgetMs);
      return row >= rows;
    },
  };
}
