// Play clouds as real volumes. Every blob is a 3D ellipsoid (its z half-extent is r * INFLUENCE_FACTOR * the type's thickness
// scale, centred on a stable per-slot depth offset); a fragment pass marches an off-axis perspective ray through the ones that
// can reach it and lights each sample with a short march toward the sun. The CPU sim stays 2D and authoritative.
//
//   tiles (tiles.ts)    per screen tile, the blobs that can reach a ray through it (one 32x32 RGBA8 texture)
//   blob texture        the render copy of the blob buffer, 3 RGBA32F texels per blob
//   density             sum of the listed blobs' kernels; the mid plane (z = 0) is pinned to the sim's 2D density, so the
//                       silhouette is the sim contour; off the plane it is the sum of the 3D ellipsoids. Baked 3D noise only
//                       ERODES it (Nubis envelope: noise subtracts, never adds), so the silhouette never grows past the sim's
//   march               front to back, energy-conserving Beer-Lambert (Hillaire 2016); sun march (geometric spacing, no
//                       jitter, so thin sheets do not hatch); Wrenninge multiple-scattering octaves with a dual-lobe
//                       Henyey-Greenstein phase; powder; a narrow forward lobe for the silver lining; ambient from the height
//                       in the cloud; the lightning's internal glow
//
// Output is premultiplied (rgb, alpha) at the march target's resolution; the composite upsamples it. Everything tunable is a
// uniform (artist fields in src/params/fields.ts, step counts and octaves from the tier): nothing recompiles.
// Pattern after three.js `webgpu_volume_cloud` (MIT): texture3D + Loop/Break in plain fragment TSL, so WebGPU and WebGL2 share it.

import {
  Color,
  Data3DTexture,
  DataTexture,
  FloatType,
  NearestFilter,
  NodeMaterial,
  QuadMesh,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Node,
} from "three/webgpu";
import {
  Break,
  clamp,
  dot,
  exp,
  float,
  floor,
  Fn,
  fract,
  If,
  int,
  ivec2,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  pow,
  round,
  screenCoordinate,
  screenUV,
  select,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { BLOB_STRIDE, CLOUD_THRESHOLD, INFLUENCE_FACTOR, MAX_BLOBS } from "../sim/blobBuffer.ts";
import { QCUT, TILE_TEX_H, TILE_TEX_W } from "./tiles.ts";
import { CAMERA_DISTANCE, VIEW_HEIGHT } from "./view.ts";

/** Blob data texture: 3 RGBA32F texels per blob (the render copy), one row. */
export function createBlobTexture(): DataTexture {
  const tex = new DataTexture(new Float32Array(MAX_BLOBS * BLOB_STRIDE), MAX_BLOBS * 3, 1, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Tile lists, see tiles.ts. */
export function createTileTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array(TILE_TEX_W * TILE_TEX_H * 4), TILE_TEX_W, TILE_TEX_H, RGBAFormat, UnsignedByteType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** All of the pass's uniforms. Artist values arrive through `applyLook`, step counts through the tier, tile geometry from the scene. */
export function createCloudUniforms() {
  return {
    // tile grid and the eye (the z = 0 plane stays fixed on screen)
    cols: uniform(23),
    rows: uniform(14),
    tileSize: uniform(0.725),
    zMax: uniform(2.5),
    eye: uniform(new Vector2(0, 0)),
    // tier
    steps: uniform(20, "int"),
    lightSteps: uniform(6, "int"),
    octaves: uniform(4, "int"),
    /** 1 = sample the fine erosion octave in the view march, 0 = skip it. */
    fine: uniform(1),
    /** 1 = one ambient-occlusion tap per sample, 0 = none. */
    aoOn: uniform(1),
    // light
    /** Unit vector toward the sun (x right, y up, z toward the viewer). */
    sun: uniform(new Vector3(0.63, 0.67, 0.39)),
    sigma: uniform(12),
    reach: uniform(2.8),
    sunGain: uniform(1.5),
    ambient: uniform(0.9),
    powder: uniform(0.6),
    phaseG: uniform(0.72),
    msGain: uniform(0.45),
    silver: uniform(1),
    aoK: uniform(0.55),
    // shape
    /** Noise frequency per world unit (one period of the baked texture is 1 / noiseScale units). */
    noiseScale: uniform(1 / 2.4),
    erosion: uniform(0.7),
    erosionFine: uniform(0.35),
    flatBase: uniform(0.4),
    /** z half-extent per blob radius, by type (cumulus, stratus, cumulonimbus): the same values the tile builder uses. */
    zScale: uniform(new Vector3(0.95, 0.38, 1.7)),
    /** The air's travelled distance (from the sim): the noise rides with it, so the erosion stays put on a drifting cloud. */
    air: uniform(new Vector2(0, 0)),
    /** CPU-integrated noise phase (z): changing the rate never jumps the pattern. */
    billow: uniform(0),
    /** 0 until the 3D noise is baked, then ramps to 1: no erosion without noise. */
    noiseMix: uniform(0),
    // colours (linear)
    /** The sunlit colour: the cloud's lit colour times the sunlight's tint (see applyLook). */
    litColor: uniform(new Color("#ffffff")),
    midColor: uniform(new Color("#dfe9f6")),
    shadeColor: uniform(new Color("#9fb3d6")),
  };
}

export type CloudUniforms = ReturnType<typeof createCloudUniforms>;

/** Interleaved gradient noise: the view march's start jitter (blurred away by the composite's 3x3 tent). */
const jitter = () => float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))).fract();

/** Density ramp from the sim's density: where the cloud is "solid" (ramp x) to "full" (ramp y), in units of the contour density. */
const RAMP = [0.4, 1.9] as const;
/** Above the contour, density grows only logarithmically, so deep tower cores stay erodable instead of saturating the ramp. */
const COMPRESS = 0.9;
/** Reference z half-extent for the optical-depth scale: thin sheets and towers go from lit to dark over a similar optical depth. */
const TAU_REF = 0.85;
/** Wrenninge multiple scattering: extinction, contribution and phase-anisotropy attenuation per octave (roles, not Oz's letters). */
const MS_EXTINCTION = 0.5;
const MS_CONTRIBUTION = 0.5;
const MS_ANISOTROPY = 0.5;
const G_BACK = -0.25;
const W_FWD = 0.45;

export function createCloudMarch(o: {
  u: CloudUniforms;
  blobTex: DataTexture;
  tileTex: DataTexture;
  noiseTex: Data3DTexture;
  aspect: Node<"float">;
  /** The lightning: strength (0..1) and the glow's screen position (0..1, y up), the same uniforms the composite reads. */
  flash: Node<"float">;
  flashX: Node<"float">;
  flashY: Node<"float">;
}) {
  const { u, aspect } = o;
  const bt = texture(o.blobTex);
  const tt = texture(o.tileTex);
  const nz = texture3D(o.noiseTex);

  const qc = float(QCUT * QCUT);
  const wcut = float((1 - QCUT * QCUT) ** 3);
  /** (1 - q^2)^3 cut at QCUT and renormalised to 1 at the centre: zero beyond the cut, so tile lists need not reach q = 1. */
  const kern = (q2: Node<"float">) => max(pow(max(float(1).sub(q2), 0), 3).sub(wcut), 0).div(float(1).sub(wcut));

  /** Header texel of the tile holding world xy: (offset lo, offset hi, count, z half-range) in 0..1. */
  const tileHeader = (xy: Node<"vec2">) => {
    const ti = clamp(floor(xy.x.add(aspect.mul(VIEW_HEIGHT / 2)).div(u.tileSize)), 0, u.cols.sub(1));
    const tj = clamp(floor(xy.y.add(VIEW_HEIGHT / 2).div(u.tileSize)), 0, u.rows.sub(1));
    const t = tj.mul(u.cols).add(ti);
    const row = floor(t.div(TILE_TEX_W));
    return tt.load(ivec2(int(t.sub(row.mul(TILE_TEX_W))), int(row)));
  };

  /** Base texel (x of the blob's 3-texel record) of the i-th entry of a tile's list (bytes after the headers, 4 per texel). */
  const listBlob = (off: Node<"float">, i: Node<"int">) => {
    const k = off.add(float(i));
    const tx = floor(k.div(4)).add(u.cols.mul(u.rows));
    const trow = floor(tx.div(TILE_TEX_W));
    const tv = tt.load(ivec2(int(tx.sub(trow.mul(TILE_TEX_W))), int(trow)));
    const ch = k.sub(floor(k.div(4)).mul(4));
    const idx = select(ch.lessThan(0.5), tv.r, select(ch.lessThan(1.5), tv.g, select(ch.lessThan(2.5), tv.b, tv.a)));
    return int(round(idx.mul(255))).mul(3);
  };

  /**
   * Cloud density at a world point (x, y, z). Returns vec4(density 0..1, stratus share, nimbus share, height in cloud 0..1).
   * `fine`: also sample the fine erosion octave (the sun march does not).
   */
  const makeDensity = (fine: boolean) =>
    Fn(([p]: [Node<"vec3">]) => {
      const hd = tileHeader(p.xy);
      const count = round(hd.b.mul(255));
      const off = round(hd.r.mul(255)).add(round(hd.g.mul(255)).mul(256));
      const rho2 = float(0).toVar();
      const d3 = float(0).toVar();
      const sw = float(0).toVar();
      const zhw = float(0).toVar();
      const zcw = float(0).toVar();
      const baseW = float(0).toVar();
      const topW = float(0).toVar();
      const stW = float(0).toVar();
      const nbW = float(0).toVar();
      Loop({ start: int(0), end: int(count), type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
        const bi = listBlob(off, i);
        const b0 = bt.load(ivec2(bi, 0)); // x, y, radius, mass
        const dxy = p.xy.sub(b0.xy);
        const d2 = dot(dxy, dxy);
        const R = b0.z.mul(INFLUENCE_FACTOR);
        const q2 = d2.div(R.mul(R));
        If(q2.lessThan(qc), () => {
          const b1 = bt.load(ivec2(bi.add(1), 0)); // cloud base y, cloud top y, cloud id, alive
          const b2 = bt.load(ivec2(bi.add(2), 0)); // type one-hot, z offset
          const kk = b0.w.mul(float(0.5).div(b0.z).pow(2));
          const w2 = kk.mul(kern(q2));
          const zh = R.mul(dot(b2.xyz, u.zScale));
          const dz = p.z.sub(b2.w).div(zh);
          const w3 = kk.mul(kern(q2.add(dz.mul(dz))));
          rho2.addAssign(w2);
          d3.addAssign(w3);
          sw.addAssign(w2);
          zhw.addAssign(w2.mul(zh));
          zcw.addAssign(w2.mul(b2.w));
          baseW.addAssign(w2.mul(b1.x));
          topW.addAssign(w2.mul(b1.y));
          stW.addAssign(w2.mul(b2.y));
          nbW.addAssign(w2.mul(b2.z));
        });
      });
      const out = vec4(0).toVar();
      If(rho2.greaterThan(0.02), () => {
        const isw = float(1).div(sw);
        const zhL = zhw.mul(isw);
        const zcL = zcw.mul(isw);
        const fSt = stW.mul(isw);
        const fNb = nbW.mul(isw);
        const base = baseW.mul(isw);
        const top = topW.mul(isw);
        const h = clamp(p.y.sub(base).div(max(top.sub(base), 0.05)), 0, 1);
        // Pin the mid plane to the sim's 2D field (so the silhouette is the sim contour); off the plane it is the 3D ellipsoids.
        const dzc = p.z.sub(zcL).div(zhL.mul(0.55));
        const S = d3.add(rho2.sub(d3).mul(exp(dzc.mul(dzc).negate())));
        // Flat-ish bases: thin the underside of cumulus and nimbus (not stratus sheets) over the lowest part of the cloud.
        const flat = mix(float(1), smoothstep(0.0, 0.22, h), u.flatBase.mul(float(1).sub(fSt)));
        const Sraw = S.mul(flat).div(CLOUD_THRESHOLD);
        const Sn = select(Sraw.lessThan(1), Sraw, float(1).add(Sraw.max(1).log().mul(COMPRESS)));
        const edge = float(1).sub(smoothstep(0.9, 3.2, Sn));
        const hGain = mix(0.55, 1.25, h).mul(float(1).add(fNb.mul(0.5)));
        const q = p.sub(vec3(u.air, 0)).mul(u.noiseScale).add(vec3(0, 0, u.billow));
        const n1 = nz.sample(q);
        const disp = n1.r.mul(0.45).add(n1.g.mul(0.55)).sub(1).mul(u.erosion).mul(hGain).mul(mix(0.4, 1, edge)).toVar();
        if (fine) {
          If(u.fine.greaterThan(0.5), () => {
            const n2 = nz.sample(q.mul(2.35).add(vec3(0.31, -0.17, 0.53)));
            disp.addAssign(n2.b.mul(0.5).add(n2.a.mul(0.5)).sub(1).mul(u.erosionFine).mul(edge).mul(hGain));
          });
        }
        const dens = smoothstep(RAMP[0], RAMP[1], Sn.add(disp.mul(u.noiseMix)));
        const tauK = clamp(float(TAU_REF).div(zhL), 0.45, 1.6);
        out.assign(vec4(dens.mul(tauK), fSt, fNb, h));
      });
      return out;
    });
  const densFull = makeDensity(true);
  const densLight = makeDensity(false);

  /** Henyey-Greenstein, normalised so an isotropic phase is 1. */
  const hg = (g: Node<"float">, c: Node<"float">) =>
    float(1).sub(g.mul(g)).div(pow(max(float(1).add(g.mul(g)).sub(g.mul(c).mul(2)), 1e-3), 1.5));

  const cloudColor = Fn(() => {
    const uvUp = vec2(screenUV.x, screenUV.y.oneMinus());
    const wp = uvUp.sub(0.5).mul(vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT));
    const jit = jitter();
    // The sun march is NOT jittered: a fixed offset gives smooth spatial banding on thin sheets where jitter gave visible hatch.
    const jitL = float(0.5);
    const hd = tileHeader(wp);
    const zt = hd.a.mul(u.zMax);
    const count0 = round(hd.b.mul(255));
    const off0 = round(hd.r.mul(255)).add(round(hd.g.mul(255)).mul(256));
    const T = float(1).toVar();
    const acc = vec3(0).toVar();
    const tauV = float(0).toVar();
    const flashPos = vec2(o.flashX.sub(0.5).mul(aspect).mul(VIEW_HEIGHT), o.flashY.sub(0.5).mul(VIEW_HEIGHT));
    If(zt.greaterThan(0.01).and(count0.greaterThan(0)), () => {
      // Tight z interval: the union of the chords of the listed blobs along this pixel's ray (each at its own depth).
      const zlo = float(1000).toVar();
      const zhi = float(-1000).toVar();
      Loop({ start: int(0), end: int(count0), type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
        const bi = listBlob(off0, i);
        const b0 = bt.load(ivec2(bi, 0));
        const b2 = bt.load(ivec2(bi.add(2), 0));
        const rxy = wp.add(u.eye.sub(wp).mul(b2.w.div(CAMERA_DISTANCE)));
        const dd = rxy.sub(b0.xy);
        const R = b0.z.mul(INFLUENCE_FACTOR);
        const q2 = dot(dd, dd).div(R.mul(R));
        If(q2.lessThan(qc), () => {
          const half = R.mul(dot(b2.xyz, u.zScale)).mul(sqrt(qc.sub(q2)));
          zlo.assign(min(zlo, b2.w.sub(half)));
          zhi.assign(max(zhi, b2.w.add(half)));
        });
      });
      const zA = min(zhi.add(0.06), zt);
      const zB = max(zlo.sub(0.06), zt.negate());
      const zspan = max(zA.sub(zB), 0.0);
      const eye3 = vec3(u.eye, CAMERA_DISTANCE);
      const P3 = vec3(wp, 0);
      const pathPerZ = length(P3.sub(eye3)).div(CAMERA_DISTANCE);
      const rd = normalize(P3.sub(eye3));
      const L = u.sun;
      const cosT = dot(L, rd); // > 0: looking toward the sun (forward scattering)
      const N = float(u.steps);
      const dz = zspan.div(N);
      const ds = dz.mul(pathPerZ);
      Loop({ start: int(0), end: u.steps, type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
        const z = zA.sub(float(i).add(jit).mul(dz));
        const pos = vec3(wp.add(u.eye.sub(wp).mul(z.div(CAMERA_DISTANCE))), z);
        const d = densFull(pos);
        If(d.x.greaterThan(0.003), () => {
          const sig = d.x.mul(u.sigma);
          // Sun march, geometric spacing (0.5 t + 0.5 t^2: far steps stay bounded, because a step wider than a thin sheet aliases).
          const tauL = float(0).toVar();
          const LN = float(u.lightSteps);
          Loop({ start: int(0), end: u.lightSteps, type: "int", condition: "<" }, ({ i: j }: { i: Node<"int"> }) => {
            const t0 = float(j).add(jitL).div(LN);
            const s = t0.mul(t0.mul(0.5).add(0.5)).mul(u.reach);
            const step = t0.add(0.5).div(LN).mul(u.reach);
            tauL.addAssign(densLight(pos.add(L.mul(s))).x.mul(u.sigma).mul(step));
          });
          // Ambient occlusion: one tap straight up.
          const occ = float(1).toVar();
          If(u.aoOn.greaterThan(0.5), () => {
            const up = densLight(pos.add(vec3(0, 0.45, 0.1))).x.mul(u.sigma).mul(0.45);
            occ.assign(exp(up.mul(u.aoK.negate())));
          });
          // Multiple scattering octaves (Wrenninge): extinction a^n, contribution b^n, phase anisotropy c^n.
          const Ls = float(0).toVar();
          const a = float(1).toVar();
          const b = float(1).toVar();
          const c = float(1).toVar();
          const first = float(0).toVar();
          Loop({ start: int(0), end: u.octaves, type: "int", condition: "<" }, () => {
            const ph = mix(hg(c.mul(G_BACK), cosT), hg(c.mul(u.phaseG), cosT), W_FWD);
            Ls.addAssign(b.mul(ph).mul(exp(tauL.mul(a).negate())));
            a.mulAssign(MS_EXTINCTION);
            b.mulAssign(select(first.lessThan(0.5), u.msGain.mul(MS_CONTRIBUTION), MS_CONTRIBUTION));
            c.mulAssign(MS_ANISOTROPY);
            first.addAssign(1);
          });
          // Silver lining: a narrow forward lobe that survives deep paths when the sun is behind the cloud.
          Ls.addAssign(hg(float(0.92), cosT).mul(0.05).mul(exp(tauL.mul(0.35).negate())).mul(u.silver));
          // Powder: the thin, low-density skin scatters less toward the viewer (local density, so the start jitter cannot flicker it).
          const powder = mix(float(1), float(0.35).add(float(1).sub(exp(sig.mul(-0.35))).mul(0.65)), u.powder.mul(float(1).sub(cosT.max(0)).mul(0.6).add(0.4)));
          const sunL = Ls.mul(powder).mul(u.sunGain);
          // Ambient sky light: brighter higher in the cloud, dimmer under it and where it is occluded.
          const ambMix = clamp(d.w.mul(0.75).add(0.2), 0, 1).mul(mix(0.55, 1, occ));
          const amb = mix(u.shadeColor, u.midColor, ambMix).mul(mix(0.55, 1, occ)).mul(u.ambient);
          // Stratus greys out; cumulonimbus is dark at its base and bright at its top.
          const nimbus = mix(float(0.55), float(1.0), smoothstep(0.3, 0.9, d.w));
          const grey = mix(float(1), float(0.82), d.y).mul(mix(float(1), nimbus, d.z));
          let col: Node<"vec3"> = u.litColor.mul(sunL).add(amb).mul(grey);
          // Lightning: an unshadowed internal glow near the strike, strongest in the cloud body.
          const fd = pos.xy.sub(flashPos);
          col = col.add(vec3(0.75, 0.82, 1.0).mul(o.flash.mul(exp(dot(fd, fd).negate().div(2.2))).mul(0.9).mul(exp(tauV.mul(-0.35)))));
          // Energy-conserving slab integration: the step's in-scattered light is the source integrated over the step.
          const Te = exp(sig.mul(ds).negate());
          acc.addAssign(col.mul(T).mul(float(1).sub(Te)));
          T.mulAssign(Te);
          tauV.addAssign(sig.mul(ds));
          If(T.lessThan(0.02), () => {
            Break();
          });
        });
      });
    });
    return vec4(acc, float(1).sub(T));
  });

  const material = new NodeMaterial();
  material.fragmentNode = cloudColor();
  material.depthTest = false;
  material.depthWrite = false;
  const quad = new QuadMesh(material);
  return { quad, dispose: () => material.dispose() };
}
