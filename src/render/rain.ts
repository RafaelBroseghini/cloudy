// Rain: stateless analytic streaks, drawn inside the composite shader (no particles, no compute, no extra pass).
// Same code and same integer hash on WebGPU and WebGL2, so both backends draw the same rain, and rain never touches
// sim or interaction state.
//
// How it works: each depth band lives in a frame rotated to the fall direction (u along the fall, v across it),
// tiled into cells of `cell` units. A cell holds at most one streak, placed by an integer hash of the cell index.
// The streaks are static in a frame that slides along u by a CPU-integrated `phase`, so they fall; changing
// the rate, speed or slant never makes them jump (like scenery drift). The shader cost is a few hashes per pixel
// per band, and a uniform branch skips a band entirely at rate 0. No draw calls, so nothing to recompile.
//
// "Count" is the streak density: P(cell has a streak) = rainRate * band.maxFill * tier. A fully dense band fills
// `maxFill` of its cells (about 170 / 70 / 25 streaks on screen for far / mid / near at rate 1, tier 1).

import { Color, Vector2 } from "three/webgpu";
import { clamp, dot, float, floor, Fn, hash, If, max, min, mix, smoothstep, sqrt, uint, uniform, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { VIEW_HEIGHT } from "./view.ts";

interface BandDefaults {
  /** Parallax depth (< 1 behind the play layer, > 1 in front). Shift = parallax * (1 - depth). */
  depth: number;
  /** Cell size across (v) and along (u) the fall, world units. */
  cellV: number;
  cellU: number;
  /** Streak length as a fraction of the cell's u extent, [min, max]. */
  length: [number, number];
  /** Streak half-width, world units. */
  width: number;
  /** Fall speed relative to P.rainSpeed. */
  speed: number;
  /** Peak opacity of a streak head. */
  alpha: number;
  /** 0..1 blend toward the sky horizon colour (atmospheric haze): far streaks are hazier. */
  haze: number;
  /** Fraction of cells that hold a streak at rate 1. */
  maxFill: number;
  /** How much a play cloud under the streak mutes it (keeps the play layer readable). */
  playMute: number;
}

/** Far = thin, dim, slow, hazed. Near = long, bright, fast. */
export const RAIN_BANDS = {
  far: { depth: 0.3, cellV: 0.34, cellU: 1.5, length: [0.3, 0.6], width: 0.011, speed: 0.4, alpha: 0.55, haze: 0.4, maxFill: 0.6, playMute: 0 },
  mid: { depth: 0.75, cellV: 0.6, cellU: 2.4, length: [0.25, 0.5], width: 0.016, speed: 0.62, alpha: 0.65, haze: 0.2, maxFill: 0.6, playMute: 0 },
  near: { depth: 1.5, cellV: 1.1, cellU: 3.6, length: [0.22, 0.42], width: 0.026, speed: 0.95, alpha: 0.55, haze: 0, maxFill: 0.5, playMute: 0.7 },
} as const satisfies Record<string, BandDefaults>;

export type RainBandName = keyof typeof RAIN_BANDS;
const NAMES = Object.keys(RAIN_BANDS) as RainBandName[];

/** Cells per hashed ring along u; the CPU wraps phase by the same amount, so the wrap is seamless. */
const RING = 512;
const V_BIAS = 2048;
/** Horizontal slant per unit of P.windX (tan of the angle), added to tan(rainAngle). */
export const WIND_SLANT = 0.12;

function createRainUniforms() {
  const band = (name: RainBandName) => ({
    /** P(cell holds a streak), already scaled by rate and tier. 0 skips the band in the shader. */
    density: uniform(0),
    /** CPU-integrated slide along the fall, wrapped to RING cells. */
    phase: uniform(0),
    haze: uniform(RAIN_BANDS[name].haze),
  });
  return {
    far: band("far"),
    mid: band("mid"),
    near: band("near"),
    /** Unit fall direction (world, y-up) and its perpendicular. */
    dir: uniform(new Vector2(0, -1)),
    perp: uniform(new Vector2(1, 0)),
    color: uniform(new Color(0.82, 0.9, 1)),
    /** World units per device pixel: streaks never get thinner than a pixel, so they keep their energy. */
    pixel: uniform(VIEW_HEIGHT / 800),
  };
}

export function createRain(parallax: Node<"vec2">) {
  const u = createRainUniforms();
  const state = { rate: 0, speed: 12, tier: 1, slant: 0 };

  function sync(): void {
    for (const n of NAMES) u[n].density.value = Math.min(1, state.rate * state.tier) * RAIN_BANDS[n].maxFill;
  }

  /** Streak colour and alpha at world position `wp` for one band (rgb already hazed toward `horizon`). */
  const makeBand = (name: RainBandName, salt: number) => {
    const d = RAIN_BANDS[name];
    const b = u[name];
    return Fn(([wp, horizon, playBody]: [Node<"vec2">, Node<"color">, Node<"float">]) => {
      const out = vec4(0, 0, 0, 0).toVar();
      If(b.density.greaterThan(0), () => {
        const q = wp.sub(parallax.mul(float(1).sub(d.depth)));
        const v = dot(q, u.perp);
        const s = dot(q, u.dir).sub(b.phase);
        const ci = floor(v.div(d.cellV));
        const cj = floor(s.div(d.cellU));
        const cjm = cj.sub(floor(cj.div(RING)).mul(RING));
        // Integer seed: cell index -> uint, 4 draws per cell. All math below the hash is exact in float32 here.
        const cell = cjm.mul(4096).add(ci.add(V_BIAS)).toUint().mul(uint(4)).add(uint(salt));
        const r0 = hash(cell);
        const r1 = hash(cell.add(uint(1)));
        const r2 = hash(cell.add(uint(2)));
        const r3 = hash(cell.add(uint(3)));
        // Fade in as the density passes this cell's draw, so changing the rate adds streaks gently.
        const present = clamp(b.density.sub(r0).mul(12), 0, 1);
        const lenFrac = mix(float(d.length[0]), float(d.length[1]), r3);
        const len = lenFrac.mul(d.cellU);
        const v0 = ci.add(float(0.12).add(r1.mul(0.76))).mul(d.cellV);
        const u0 = cj.add(float(0.03).add(r2.mul(float(0.94).sub(lenFrac)))).mul(d.cellU);
        const along = clamp(s.sub(u0), 0, len);
        const du = s.sub(u0).sub(along);
        const dv = v.sub(v0);
        const dist = sqrt(du.mul(du).add(dv.mul(dv)));
        const t = along.div(len); // 0 tail .. 1 head
        const wid = max(float(d.width).mul(float(0.45).add(t.mul(0.55))), u.pixel.mul(0.8));
        // A streak thinner than a pixel is dimmed by how much it is thinner, so it still reads as a faint line.
        const keep = min(float(1), float(d.width).mul(float(0.45).add(t.mul(0.55))).div(wid).mul(0.5).add(0.5));
        const line = float(1).sub(smoothstep(wid.mul(0.2), wid, dist));
        const bright = float(0.6).add(r1.mul(0.4)); // per-streak brightness
        // Tail fades out, head is brightest.
        const taper = t.mul(t).mul(0.8).add(0.2);
        let a = line.mul(taper).mul(bright).mul(keep).mul(present).mul(d.alpha);
        a = a.mul(float(1).sub(playBody.mul(d.playMute)));
        out.assign(vec4(mix(u.color, horizon, b.haze), a));
      });
      return out;
    });
  };

  return {
    uniforms: u,
    far: makeBand("far", 0),
    mid: makeBand("mid", 1_000_003),
    near: makeBand("near", 2_000_003),
    /** Pixel size for the min streak width: call on resize with the drawing-buffer height in pixels. */
    setPixelHeight(px: number): void {
      u.pixel.value = VIEW_HEIGHT / Math.max(1, px);
    },
    /** From the resolved params (see applyLook): rate 0..1, fall speed (units/s), slant = tan(angle) + wind. */
    setLook(rate: number, speed: number, slant: number): void {
      state.rate = Math.min(1, Math.max(0, rate));
      state.speed = speed;
      state.slant = slant;
      const len = Math.hypot(slant, 1);
      u.dir.value.set(slant / len, -1 / len);
      u.perp.value.set(1 / len, slant / len);
      sync();
    },
    /** Quality tier: scales the number of streaks (1 = full). */
    setTier(tier: number): void {
      state.tier = Math.min(1, Math.max(0, tier));
      sync();
    },
    /** Per rendered frame. Integrates fall phase on the CPU so a speed change never jumps the streaks. */
    update(dt: number): void {
      const d = Math.min(Math.max(dt, 0), 0.25);
      if (state.rate <= 0) return;
      for (const n of NAMES) {
        const ring = RING * RAIN_BANDS[n].cellU;
        u[n].phase.value = (u[n].phase.value + state.speed * RAIN_BANDS[n].speed * d) % ring;
      }
    },
  };
}

export type Rain = ReturnType<typeof createRain>;
