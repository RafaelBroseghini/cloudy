// Play clouds as 2.5D volumes: every cloud is a slab whose half-thickness H(x, y) is known per pixel, lit by marching
// toward the sun through that thickness map. No 3D raymarch: the cost is a few taps per pixel, on both backends.
//
//   splat (cloudField.ts)  field RT   R density, G stratus part, B nimbus part, A height in cloud (the sim's contract)
//   hemisphere splat       height RT  R = sum of (h / H_REF)^8 over blobs: H = A^(1/8) is a soft max of per-blob domes
//   detail                 detail RT  (H, eroded density f0, stratus share, nimbus share): billows + the density contour
//   shade (composite)      normals from H, Beer march toward the sun, powder, dual-lobe phase, multiple scattering,
//                          ring AO, silver lining
//
// Everything tunable is a uniform (artist params in src/params/fields.ts, tier step counts in tier.ts): nothing recompiles.

import { NodeMaterial, QuadMesh, Vector2, Vector3, InstancedBufferGeometry, Mesh, CustomBlending, AddEquation, OneFactor, Scene, type Node, type RenderTarget } from "three/webgpu";
import {
  abs,
  attribute,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  fract,
  instanceIndex,
  int,
  Loop,
  max,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec2,
  normalize,
  pow,
  screenCoordinate,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { INFLUENCE_FACTOR } from "../sim/blobBuffer.ts";
import type { CloudLook } from "./cloudField.ts";
import { VIEW_HEIGHT } from "./view.ts";

/** Normalisation of the height splat: heights are stored as (h / H_REF)^8 so half floats keep stratus (h ~ 0.1) away from underflow. */
const H_REF = 0.35;

export const extentOf = (aspect: Node<"float">) => vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT);
/** World position to the sample uv of a render target (y-down on both backends, like the field target). */
export const texUV = (p: Node<"vec2">, aspect: Node<"float">) => p.div(extentOf(aspect)).add(0.5).flipY();

/** Billow noise frequency (per world unit) for lumps of `lumpScale` blob radii across: one noise period holds about two lumps. */
export function lumpFrequency(lumpScale: number, meanRadius: number): number {
  return 0.5 / Math.max(lumpScale * Math.max(meanRadius, 0.05), 0.05);
}

/** Uniforms of the impostor lighting. Artist values arrive through `applyLook`; step counts through the quality tier. */
export function createVolumeLook() {
  return {
    /** Unit vector toward the sun (x right, y up, z toward the viewer). */
    sun: uniform(new Vector3(0.63, 0.67, 0.39)),
    /** Unit 2D direction toward the sun in the view plane (play-cloud shadows on the scenery fall away from it). */
    sunDir: uniform(new Vector2(0.7, 0.7)),
    marchLen: uniform(2.4),
    sigma: uniform(1.5),
    nk: uniform(0.55),
    wrap: uniform(0.55),
    powder: uniform(0.35),
    gFwd: uniform(0.62),
    gBack: uniform(-0.25),
    wFwd: uniform(0.35),
    ms: uniform(0.6),
    ambient: uniform(1),
    aoK: uniform(0.4),
    silver: uniform(1.4),
    contrast: uniform(1.56),
    /** Normal sampling step in world units: wide enough that fine detail does not crumple the shading. */
    eStep: uniform(0.16),
    aoR: uniform(0.4),
    // geometry
    /** Billow noise frequency per world unit (set from the lump scale and the mean blob radius), and carve strength. */
    lumpFreq: uniform(0.4),
    lumpStrength: uniform(0.4),
    /** Hemisphere radius in blob radii, and half-thickness per blob radius for (cumulus, stratus, cumulonimbus). */
    dome: uniform(1.15),
    /** Height of the low skirt over each blob's density reach, as a fraction of its dome height. */
    skirt: uniform(0.65),
    zScale: uniform(new Vector3(0.95, 0.45, 1.6)),
    /** How far toward the sun (world units) the detail pass looks to find sunlit silhouettes. */
    sunReach: uniform(0.7),
    // tier
    steps: uniform(8, "int"),
    aoTaps: uniform(8, "int"),
    sceneSteps: uniform(5, "int"),
  };
}

export type VolumeLook = ReturnType<typeof createVolumeLook>;

/**
 * Height splat: the same instanced blobs as the density splat (shared geometry, so no second upload) drawn with a
 * hemisphere profile into a second target. h = type thickness * radius * sqrt(1 - (q / dome)^2), summed as (h / H_REF)^8.
 */
export function createHeightSplat(geometry: InstancedBufferGeometry, vol: VolumeLook) {
  const blobA = attribute("aBlobA", "vec4"); // x, y, radius, mass
  const blobB = attribute("aBlobB", "vec4"); // vx, vy, cloudId, alive
  const blobC = attribute("aBlobC", "vec4"); // type one-hot
  const corner = attribute("position", "vec3").xy;
  const reach = blobA.z.mul(INFLUENCE_FACTOR);
  const material = new NodeMaterial();
  material.positionNode = vec3(blobA.xy.add(corner.mul(reach)), 0);
  const q2 = dot(corner, corner);
  const k = float(INFLUENCE_FACTOR).div(vol.dome);
  const hq = max(float(1).sub(q2.mul(k).mul(k)), 0);
  // Stable per-slot variation (the sim keeps a blob's slot for its life): domes differ in height without swimming.
  const vary = fract(sin(float(instanceIndex).mul(12.9898).add(4.1)).mul(43758.5453)).mul(0.6).add(0.7);
  const zs = vary
    .mul(blobA.z)
    .mul(blobC.x.mul(vol.zScale.x).add(blobC.y.mul(vol.zScale.y)).add(blobC.z.mul(vol.zScale.z)));
  // The dome, plus a low skirt over the blob's whole density reach: where a ring of domes encloses a gap, the skirts keep
  // the cloud's core thick instead of leaving a crater.
  const skirt = max(float(1).sub(q2), 0).mul(vol.skirt.mul(vol.skirt));
  const u2 = zs.mul(zs).mul(max(hq, skirt)).div(H_REF * H_REF); // (h / H_REF)^2
  const u4 = u2.mul(u2);
  const u8 = u4.mul(u4).mul(blobB.w); // dead slots (alive = 0) add nothing
  material.fragmentNode = vec4(u8, 0, 0, 1);
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneFactor;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  return { scene, dispose: () => material.dispose() };
}

const byType = (fSt: Node<"float">, fNb: Node<"float">, kSt: Node<"float">, kNb: Node<"float">) =>
  fSt.mul(kSt.sub(1)).add(fNb.mul(kNb.sub(1))).add(1);

/**
 * Detail pass (field resolution): splats to the thickness map. out = (H, f0, stratus share, nimbus share).
 * f0 is the eroded density the old shader thresholded, so the silhouette is the sim's density contour exactly as before.
 * H is the soft max of the blob domes, pinched to 0 at that contour (square-root profile: round shoulders, not walls) and
 * carved by big billows whose creases are soft. Billows are strongest where the surface faces the sun, so shadows stay smooth.
 */
export function createDetailPass(opts: {
  fieldTex: RenderTarget["texture"];
  heightTex: RenderTarget["texture"];
  look: CloudLook;
  vol: VolumeLook;
  aspect: Node<"float">;
}) {
  const { look, vol, aspect } = opts;
  const st = look.stratus;
  const nb = look.nimbus;
  const field = texture(opts.fieldTex);
  const heights = texture(opts.heightTex);
  const material = new NodeMaterial();
  material.fragmentNode = Fn(() => {
    const f = field.sample(screenUV);
    const d = f.r;
    const uvUp = vec2(screenUV.x, screenUV.y.oneMinus());
    const wp = uvUp.sub(0.5).mul(extentOf(aspect));
    const inv = float(1).div(max(d, 0.02));
    const fSt = clamp(f.g.mul(inv), 0, 1);
    const fNb = clamp(f.b.mul(inv), 0, 1);

    // Same noise and erosion as the density contour has always used.
    const q = wp.sub(look.air);
    const warpK = look.warp.mul(mix(float(1), st.warp, fSt));
    const warp = mx_fractal_noise_vec2(vec3(q.mul(look.warpScale), look.billow.mul(0.6).add(11.3)), 2, 2, 0.5).mul(warpK);
    const stretch = vec2(mix(float(1), st.stretch.x, fSt), mix(float(1), st.stretch.y, fSt));
    const n = mx_fractal_noise_float(vec3(q.add(warp).mul(look.noiseScale).mul(stretch), look.billow), 3, 2, 0.5);
    const erosion = look.erosion.mul(byType(fSt, fNb, st.erosion, nb.erosion));
    // Sheets fray: the stretched noise also streaks their coverage, so their ends and sides break up into wisps.
    const f0 = d.mul(n.mul(erosion).add(1)).mul(clamp(fSt.mul(n).mul(st.streakAlpha).mul(2).add(1), 0.4, 1.4));

    // Thickness: soft max of the domes, a little fuller in the dense interior.
    const bulk = mix(float(0.85), float(1.2), smoothstep(0.5, 3.0, d));
    const h8 = max(heights.sample(screenUV).r, 0);
    const H0 = sqrt(sqrt(sqrt(h8))).mul(H_REF).mul(bulk);
    const edge = sqrt(smoothstep(look.threshold.mul(0.55), look.threshold.mul(1.9), f0));

    // Billows: big, soft-creased domes (|noise| has a crease at every zero crossing; the square root rounds it off).
    const lumpP = q.add(warp).mul(vol.lumpFreq).mul(stretch);
    const n2 = mx_fractal_noise_float(vec3(lumpP, look.billow.mul(1.3).add(3.1)), 2, 2, 0.4);
    const lump = clamp(sqrt(n2.mul(n2).add(0.015)).mul(2.6), 0, 1);
    // Sunlit silhouettes: density falls off toward the sun. Lumps live there; the shaded side stays smooth.
    const sunUv = vec2(vol.sun.x, vol.sun.y.negate()).mul(vol.sunReach).div(extentOf(aspect));
    const toward = field.sample(screenUV.add(sunUv)).r;
    const facing = clamp(d.sub(toward).mul(1.3), 0, 1);
    const w = facing.mul(0.7).add(0.3);
    const kind = mix(float(1), float(0.6), fSt).mul(mix(float(1), float(0.75), fNb)); // sheets and towers keep gentler billows
    const carve = vol.lumpStrength.mul(w).mul(kind);
    const roll = float(1).add(fSt.mul(st.roll).mul(n)); // sheets swell and thin along their streaks
    const H = edge.mul(H0.mul(roll).mul(max(float(1).sub(carve.mul(float(1).sub(lump)).mul(0.9)), 0.55)).add(carve.mul(lump).mul(sqrt(H0)).mul(0.1)));
    return vec4(H, f0, fSt, fNb);
  })();
  material.depthTest = false;
  material.depthWrite = false;
  return { quad: new QuadMesh(material), dispose: () => material.dispose() };
}

/** Per-pixel white noise: hides the march's banding. (Interleaved gradient noise draws diagonal hatching at 4 steps.) */
export const ign = () => fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));

/**
 * Lighting terms from a thickness map, shared by the play layer and the scenery layers.
 * `Hat(p)` is the half thickness at world p: viewed down -z, the slab at p occupies |z| < H(p).
 * Returns the surface normal, the optical depth to the sun, ambient occlusion, a light term and a wrapped diffuse.
 */
export function litTerms(o: {
  Hat: (p: Node<"vec2">) => Node<"float">;
  wp: Node<"vec2">;
  h: Node<"float">;
  vol: VolumeLook;
  steps: Node<"int">;
  aoTaps: Node<"int"> | null;
  jitter: Node<"float">;
}) {
  const { Hat, wp, h, vol, steps, jitter } = o;
  const e = vol.eStep;
  const gx = Hat(wp.add(vec2(e, 0))).sub(Hat(wp.sub(vec2(e, 0)))).div(e.mul(2));
  const gy = Hat(wp.add(vec2(0, e))).sub(Hat(wp.sub(vec2(0, e)))).div(e.mul(2));
  const n = normalize(vec3(gx.negate().mul(vol.nk), gy.negate().mul(vol.nk), 1));
  const L = vol.sun;
  const wd = clamp(dot(n, L).add(vol.wrap).div(vol.wrap.add(1)), 0, 1);

  // Beer's law marched through the same thickness map toward the sun (quadratic spacing: fine near the surface).
  const tau = float(0).toVar();
  const total = float(steps);
  Loop({ start: int(0), end: steps, type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
    const t0 = float(i).add(jitter.mul(0.6).add(0.2)).div(total); // partial jitter: enough to hide banding, little enough that few steps do not hatch
    const s = t0.mul(t0).mul(vol.marchLen);
    const ds = t0.mul(2).div(total).mul(vol.marchLen);
    const pk = vec3(wp, h).add(L.mul(s));
    const hk = Hat(pk.xy);
    const occ = smoothstep(float(-0.04), float(0.16), hk.sub(abs(pk.z)));
    tau.addAssign(occ.mul(ds).mul(vol.sigma));
  });

  // Hillaire-style multiple scattering octaves with a dual-lobe Henyey-Greenstein phase.
  const cosT = L.z.negate(); // orthographic view along -z
  const hg = (g: Node<"float">) => float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(cosT).mul(2)), 1.5));
  let lt: Node<"float"> = float(0);
  let lt0: Node<"float"> = float(0);
  for (let oct = 0; oct < 3; oct++) {
    const a = vol.ms.pow(oct); // extinction and weight of this octave
    const phase = mix(hg(vol.gBack.mul(a)), hg(vol.gFwd.mul(a)), vol.wFwd);
    lt = lt.add(exp(tau.mul(a).negate()).mul(a).mul(phase));
    lt0 = lt0.add(phase.mul(a));
  }
  // Normalised so an unshadowed surface is 1 whatever the sun angle; `contrast` stretches the shadowed range.
  lt = clamp(float(1).sub(float(1).sub(lt.div(lt0)).mul(vol.contrast)), 0, 2);

  // AO from a ring of blurred thickness: surfaces in a pit between taller lumps are occluded.
  let ao: Node<"float"> = float(1);
  if (o.aoTaps) {
    const hb = float(0).toVar();
    const taps = o.aoTaps;
    Loop({ start: int(0), end: taps, type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
      const a = float(i).add(jitter).mul(Math.PI * 2).div(float(taps));
      hb.addAssign(Hat(wp.add(vec2(cos(a), sin(a)).mul(vol.aoR))));
    });
    const mean = hb.div(float(taps));
    ao = float(1).sub(vol.aoK.mul(clamp(mean.sub(h).div(max(mean, 0.12)), 0, 1)));
  }
  return { n, tau, ao, lt, wd };
}

/**
 * Play-layer shading. Returns Fn(wp) -> vec4(rgb, coverage).
 * The cloud's own look uniforms (colours, per-type multipliers) are the ones the flat shader used.
 */
export function shadeVolume(opts: {
  detailTex: RenderTarget["texture"];
  fieldTex: RenderTarget["texture"];
  look: CloudLook;
  vol: VolumeLook;
  aspect: Node<"float">;
}) {
  const { look, vol, aspect } = opts;
  const st = look.stratus;
  const nb = look.nimbus;
  const det = texture(opts.detailTex);
  const field = texture(opts.fieldTex);
  const Hat = (p: Node<"vec2">) => det.sample(texUV(p, aspect)).r;
  return Fn(([wp]: [Node<"vec2">]) => {
    const uv = texUV(wp, aspect);
    const f = det.sample(uv);
    const h = f.r;
    const f0 = f.g;
    const fSt = f.b;
    const fNb = f.a;
    const ff = field.sample(uv);
    const hf = clamp(ff.a.div(max(ff.r, 0.02)), 0, 1); // height within the pixel's own cloud: 0 base .. 1 top

    const soft = look.softness.mul(byType(fSt, fNb, st.softness, nb.softness));
    const coverage = smoothstep(look.threshold.sub(soft), look.threshold.add(soft), f0);

    const T = litTerms({ Hat, wp, h, vol, steps: vol.steps, aoTaps: vol.aoTaps, jitter: ign() });
    // Powder: thin lit edges darken (inner glow), faded out when the sun is behind (the silver lining wins there).
    const tauV = h.mul(2).mul(vol.sigma);
    const powder = mix(float(1), float(1).sub(exp(tauV.mul(-2.2))), vol.powder.mul(clamp(vol.sun.z.mul(2).add(0.35), 0, 1)));
    // The base of a tower and the underside of a sheet go dark with height in the cloud, bent by the billows' normals.
    const hn = hf.add(T.n.y.sub(1).mul(0.25));
    const baseK = fNb.mul(nb.baseDark).mul(smoothstep(0, nb.baseEnd, hn).oneMinus());
    const underK = fSt.mul(st.under).mul(smoothstep(0, 0.75, hn).oneMinus());
    const shadow = baseK.oneMinus().mul(underK.oneMinus());
    const gain = byType(fSt, fNb, st.gain, nb.gain).div(byType(fSt, fNb, float(1), float(1)));
    const direct = T.lt.mul(powder).mul(mix(float(0.7), float(1.18), T.wd)).mul(gain.mul(0.5).add(0.5)).mul(shadow);

    // Ambient: sky light from above, a bluish bounce from below; occluded in pits.
    const ambMix = clamp(T.n.y.mul(0.5).add(0.5).mul(vol.ambient), 0, 1);
    const ambCol = mix(look.shadeColor, look.midColor, ambMix).mul(T.ao);
    const darkBase = ambCol.mul(byType(float(0), fNb, float(1), nb.dark.mul(0.7).add(0.3)));
    // A tower's body is grey between its bright top and dark base.
    const midK = fNb.mul(nb.midBand).mul(smoothstep(0.3, 0.9, hn).oneMinus());
    const litCol = mix(look.litColor.mul(byType(float(0), fNb, float(1), nb.lit)), look.midColor, midK);
    const k = clamp(direct, 0, 1);
    let col: Node<"vec3"> = mix(darkBase, litCol, k);
    col = col.add(look.litColor.mul(clamp(direct.sub(1), 0, 1.5).mul(0.35))); // silver rim overshoot
    // Silver lining: sun behind the cloud, light leaks through where it is thin.
    const silver = clamp(vol.sun.z.negate(), 0, 1).mul(float(1).sub(smoothstep(0.02, 0.3, h))).mul(vol.silver);
    col = col.add(look.litColor.mul(silver));
    const luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(luma), fSt.mul(st.grey)).mul(byType(fSt, float(0), st.tone, float(1)));
    // Sheets are translucent at their thin fringe.
    const thin = smoothstep(look.threshold, look.threshold.mul(3.5), f0).oneMinus().mul(fSt).mul(st.thin);
    const alpha = coverage.mul(byType(fSt, float(0), st.alpha, float(1))).mul(thin.oneMinus());
    return vec4(col, alpha);
  });
}

