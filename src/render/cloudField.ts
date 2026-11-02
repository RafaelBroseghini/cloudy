// Metaball cloud field.
// Pass 1 (splat): one instanced quad per blob, additively splatted into a half-res half-float target.
// Pass 2 (shade): `shadeClouds` turns the density into lit cloud colour over the sky (called from scene.ts).

import {
  AddEquation,
  Color,
  CustomBlending,
  DynamicDrawUsage,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  type Node,
  NodeMaterial,
  OneFactor,
  PlaneGeometry,
  RenderTarget,
  Scene,
  Vector2,
} from "three/webgpu";
import {
  attribute,
  clamp,
  dot,
  float,
  Fn,
  max,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec2,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { BLOB, BLOB_STRIDE, CLOUD_THRESHOLD, DENSITY_REF_RADIUS, INFLUENCE_FACTOR, MAX_BLOBS } from "../sim/blobBuffer.ts";
import { VIEW_HEIGHT } from "./view.ts";


const extents = new Map<number, { lo: number; hi: number }>();

/** Each blob's height within its own cloud (blobs sharing a cloud id): 0 at the lowest blob's bottom, 1 at the highest blob's top. */
function cloudHeights(buf: Float32Array, count: number, out: Float32Array): void {
  extents.clear();
  for (let i = 0; i < count; i++) {
    const o = i * BLOB_STRIDE;
    if (buf[o + BLOB.alive] === 0) continue;
    const id = buf[o + BLOB.cloudId] as number;
    const y = buf[o + BLOB.y] as number;
    const r = buf[o + BLOB.radius] as number;
    const e = extents.get(id);
    if (e) {
      e.lo = Math.min(e.lo, y - r);
      e.hi = Math.max(e.hi, y + r);
    } else {
      extents.set(id, { lo: y - r, hi: y + r });
    }
  }
  for (let i = 0; i < count; i++) {
    const o = i * BLOB_STRIDE;
    const e = extents.get(buf[o + BLOB.cloudId] as number);
    out[i] = e && e.hi > e.lo ? Math.min(1, Math.max(0, ((buf[o + BLOB.y] as number) - e.lo) / (e.hi - e.lo))) : 0.5;
  }
}

/**
 * The splat pass reads the sim's blob buffer in place: the geometry's instance attributes are three
 * interleaved views (xy+radius+mass, vx vy cloudId alive, type one-hot) over the same 12-float records, so the
 * per-frame cost is one bufferSubData/writeBuffer of <= MAX_BLOBS * 48 bytes (12 KB). A data texture would need an
 * RGBA32F upload plus a texelFetch per vertex; instanced attributes work identically on WebGPU and WebGL2.
 *
 * The field target carries R = density (all types, as before), G = the stratus part of that density and
 * B = the cumulonimbus part (each blob's contribution times its one-hot type). The shade pass divides G and B by R
 * for the local type mix, so a mixed cloud blends smoothly from one look to the other.
 *
 * A carries the contribution times the blob's height within its own cloud (0 = its lowest blob, 1 = its highest, from the
 * renderer's own per-frame pass over the blob buffer). A / R is then a smooth "how high in its cloud is this pixel", which
 * lets a storm tower darken only its base and bright its top without the shader knowing the cloud's size. Blending is
 * custom (one, one on all four channels) rather than three's additive, which multiplies rgb by source alpha.
 */
export function createSplatPass() {
  const interleaved = new InstancedInterleavedBuffer(new Float32Array(MAX_BLOBS * BLOB_STRIDE), BLOB_STRIDE, 1);
  interleaved.setUsage(DynamicDrawUsage);

  const quad = new PlaneGeometry(2, 2);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("aBlobA", new InterleavedBufferAttribute(interleaved, 4, 0));
  geometry.setAttribute("aBlobB", new InterleavedBufferAttribute(interleaved, 4, 4));
  geometry.setAttribute("aBlobC", new InterleavedBufferAttribute(interleaved, 4, 8));
  const heights = new InstancedBufferAttribute(new Float32Array(MAX_BLOBS), 1);
  heights.setUsage(DynamicDrawUsage);
  geometry.setAttribute("aHeight", heights);
  geometry.instanceCount = 0;

  const blobA = attribute("aBlobA", "vec4"); // x, y, radius, mass
  const blobB = attribute("aBlobB", "vec4"); // vx, vy, cloudId, alive
  const blobC = attribute("aBlobC", "vec4"); // type one-hot: cumulus, stratus, cumulonimbus, spare
  // Read the raw attribute: positionLocal is overwritten by positionNode in the fragment stage.
  const height = attribute("aHeight", "float"); // 0..1 within the blob's cloud
  const corner = attribute("position", "vec3").xy; // -1..1 across the quad
  const reach = blobA.z.mul(INFLUENCE_FACTOR);

  const material = new NodeMaterial();
  material.positionNode = vec3(blobA.xy.add(corner.mul(reach)), 0);
  const q2 = dot(corner, corner);
  const falloff = max(q2.oneMinus(), 0);
  // W(q) = (1 - q^2)^3, scaled by mass * (DENSITY_REF_RADIUS / radius)^2 like blobDensity; dead slots (alive = 0) add nothing.
  const weight = blobA.w.mul(float(DENSITY_REF_RADIUS).div(blobA.z).pow(2));
  const contribution = falloff.mul(falloff).mul(falloff).mul(weight).mul(blobB.w);
  material.fragmentNode = vec4(contribution, contribution.mul(blobC.y), contribution.mul(blobC.z), contribution.mul(height));
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

  return {
    scene,
    /** Point the instance data at the sim's buffer (no copy) and mark it for upload. */
    setBlobs(buf: Float32Array, count: number): void {
      if (buf !== interleaved.array) {
        if (buf.length === interleaved.array.length) {
          interleaved.array = buf;
        } else {
          interleaved.array.set(buf.subarray(0, interleaved.array.length));
        }
      }
      interleaved.needsUpdate = true;
      geometry.instanceCount = Math.min(count, MAX_BLOBS);
      cloudHeights(interleaved.array as Float32Array, geometry.instanceCount, heights.array as Float32Array);
      heights.needsUpdate = true;
    },
    dispose(): void {
      geometry.dispose();
      quad.dispose();
      material.dispose();
    },
  };
}

export function createFieldTarget(): RenderTarget {
  return new RenderTarget(2, 2, {
    type: HalfFloatType,
    depthBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });
}

/** Look of the clouds. Uniforms only; fixed shader. */
export function createCloudLook() {
  return {
    /** Density at which the cloud edge sits, and half-width of the soft edge. */
    threshold: uniform(CLOUD_THRESHOLD),
    softness: uniform(0.22),
    /** Edge erosion strength (multiplicative on density) and noise scale in world units^-1. */
    erosion: uniform(0.4),
    noiseScale: uniform(1.7),
    /**
     * The air's travelled distance (world units, from the sim): the noise is sampled in the frame that rides with the air,
     * so as clouds drift the erosion stays put on them instead of swimming through them.
     */
    air: uniform(new Vector2(0, 0)),
    /** CPU-integrated noise phase (z axis): changing the rate never jumps the pattern. */
    billow: uniform(0),
    /** Phase units per second of the slow billowing of edges and interior. */
    billowRate: uniform(0.1),
    /** Domain warp: reach (world units) and spatial frequency of the swirl that makes the edges roll. */
    warp: uniform(0.4),
    warpScale: uniform(0.45),
    /** Strength of the noise's contribution to the shading, so the interior billows too (0 = flat interior). */
    billowShade: uniform(0.16),
    /** World-space offset toward the light used for the second density sample. */
    lightOffset: uniform(new Vector2(-0.3, 1.1)),
    lightGain: uniform(2.6),
    litColor: uniform(new Color("#ffffff")),
    midColor: uniform(new Color("#dfe9f6")),
    shadeColor: uniform(new Color("#9fb3d6")),
    /**
     * Per-type look, applied where the field's type mix says so (cumulus is the base look above, so it has no entry).
     * Multipliers are on the base uniform of the same name; 1 = unchanged. Uniforms only, so it never recompiles.
     */
    stratus: {
      /** Edge erosion and noise-driven shading: smoother than cumulus, but not uniform. */
      erosion: uniform(1.6),
      billowShade: uniform(0.5),
      /** Wider soft edge (as a multiple of the base; under 1.9, or the ramp starts below zero density and leaves a hard rim where the field ends). */
      softness: uniform(1.85),
      /** Light gain: weak, so the sheet is evenly lit rather than modelled. */
      gain: uniform(0.7),
      /** 0..1 (not a multiplier): how far the colour goes to grey. */
      grey: uniform(0.55),
      /** Multiplier on coverage: a thin sheet, so the sky and rain show a little through. */
      alpha: uniform(0.88),
      /** 0..1: how much the thin fringe of a sheet goes translucent on top of that. */
      thin: uniform(0.6),
      /** Multiplier on the final colour: a dimmer, overcast sheet. */
      tone: uniform(0.86),
      /** Noise stretch along x and y (a sheet streaks horizontally) and the share of the cumulus swirl kept. */
      stretch: uniform(new Vector2(0.2, 1.7)),
      /** How much the stretched noise streaks the sheet's brightness and its opacity (0 = smooth). */
      streak: uniform(0.26),
      streakAlpha: uniform(0.4),
      warp: uniform(0.5),
      /** 0..1: how much of the sheet's lower part is shaded toward grey. */
      under: uniform(0.6),
    },
    nimbus: {
      /** Edge erosion and softness: billowy like cumulus, a little crisper. */
      erosion: uniform(1.1),
      softness: uniform(0.75),
      /** Light gain, and how far (times the light offset's height) the shadow sample reaches. */
      gain: uniform(0.8),
      reach: uniform(0.85),
      /** Most that the modelled light may shade a tower (1 = down to the shade colour): hollows between domes stay grey, never slate. */
      cap: uniform(0.62),
      /** Multiplier on the noise-driven shading, so the lumps of the column read inside the cloud too. */
      billowShade: uniform(2),
      /** Height within the cloud (0..1) under which the base is dark, and how dark (0..1 of the shade). */
      baseEnd: uniform(0.5),
      baseDark: uniform(0.9),
      /** 0..1: how much of the middle goes to the mid colour (grey body between the bright top and dark base). */
      midBand: uniform(0.85),
      /** 0..1: how far the dark base is lifted toward the mid colour (slate, not black). */
      lift: uniform(0.1),
      /** Multiplier on the shade colour and on the lit colour (brighter top). */
      dark: uniform(0.64),
      lit: uniform(1.08),
    },
  };
}

export type CloudLook = ReturnType<typeof createCloudLook>;

/** Raw play-layer density at a world position (the splat target sampled y-down like `shadeClouds`). */
export function sampleFieldDensity(fieldTex: RenderTarget["texture"], aspect: Node<"float">) {
  const field = texture(fieldTex);
  const extent = vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT);
  return (p: Node<"vec2">): Node<"float"> => field.sample(p.div(extent).add(0.5).flipY()).r;
}

/**
 * Returns the cloud colour (rgb) and coverage (a) at world position `wp`.
 * `time` and `aspect` are uniform nodes; `fieldTex` is the splat target's texture.
 */
export function shadeClouds(
  fieldTex: RenderTarget["texture"],
  look: CloudLook,
  time: Node<"float">,
  aspect: Node<"float">,
) {
  const field = texture(fieldTex);
  const extent = vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT);
  const { stratus: st, nimbus: nb } = look;

  // Render-target textures are sampled y-down on both backends (three flips them on WebGL), like screenUV.
  const fieldAt = (p: Node<"vec2">) => field.sample(p.div(extent).add(0.5).flipY());

  // Soft-saturated, un-eroded density for lighting: interior stays flat so only real surfaces shade.
  const body = Fn(([p]: [Node<"vec2">]) => {
    const d = fieldAt(p).r;
    return d.mul(-0.8).exp().oneMinus();
  });

  // 1 + fSt (kSt - 1) + fNb (kNb - 1): a per-pixel multiplier that is exactly 1 for cumulus.
  const byType = (fSt: Node<"float">, fNb: Node<"float">, kSt: Node<"float">, kNb: Node<"float">) =>
    fSt.mul(kSt.sub(1)).add(fNb.mul(kNb.sub(1))).add(1);

  return Fn(([p]: [Node<"vec2">]) => {
    const f = fieldAt(p);
    const d = f.r;
    // Local type mix: the stratus and cumulonimbus shares of the density here.
    const inv = float(1).div(max(d, 0.02));
    const fSt = clamp(f.g.mul(inv), 0, 1);
    const fNb = clamp(f.b.mul(inv), 0, 1);
    // Height within the pixel's own cloud (0 base .. 1 top), the density-weighted mean of its blobs' heights.
    const hf = clamp(f.a.mul(inv), 0, 1);

    // Noise in the air's frame, bent by a slowly evolving swirl so edges roll and billow instead of sliding.
    // Stratus pixels stretch it along x (streaks) and keep less of the swirl.
    const q = p.sub(look.air);
    const warpK = look.warp.mul(mix(float(1), st.warp, fSt));
    const warp = mx_fractal_noise_vec2(vec3(q.mul(look.warpScale), look.billow.mul(0.6).add(11.3)), 2, 2, 0.5).mul(warpK);
    const stretch = vec2(mix(float(1), st.stretch.x, fSt), mix(float(1), st.stretch.y, fSt));
    const n = mx_fractal_noise_float(vec3(q.add(warp).mul(look.noiseScale).mul(stretch), look.billow), 3, 2, 0.5);
    // Multiplicative erosion keeps empty sky empty and only bites near the edges.
    const erosion = look.erosion.mul(byType(fSt, fNb, st.erosion, nb.erosion));
    const f0 = d.mul(n.mul(erosion).add(1));
    const soft = look.softness.mul(byType(fSt, fNb, st.softness, nb.softness));
    const coverage = smoothstep(look.threshold.sub(soft), look.threshold.add(soft), f0);

    // The side toward the light is denser => we are in shadow; emptier or equal => lit. A tower reaches a little farther up.
    const reach = byType(fSt, fNb, float(1), nb.reach);
    const upPos = p.add(look.lightOffset.mul(vec2(1, reach)));
    const above = fieldAt(upPos).r.mul(-0.8).exp().oneMinus();
    const diff = body(p).sub(above);
    const gain = look.lightGain.mul(byType(fSt, fNb, st.gain, nb.gain));
    const billowShade = look.billowShade.mul(byType(fSt, fNb, st.billowShade, nb.billowShade));
    const modelled = clamp(diff.mul(gain).negate().add(n.mul(billowShade)), 0, 1).mul(byType(float(0), fNb, float(1), nb.cap));
    // Soft vertical gradient on top of the modelled light: a tower's lowest part and a sheet's underside go dark. The
    // noise bends the boundary, so it follows the billows instead of cutting a straight line.
    const hn = hf.add(n.mul(0.09));
    const baseK = fNb.mul(nb.baseDark).mul(smoothstep(0, nb.baseEnd, hn).oneMinus());
    const underK = fSt.mul(st.under).mul(smoothstep(0, 0.75, hn).oneMinus());
    const extra = baseK.oneMinus().mul(underK.oneMinus()).oneMinus();
    // Added in the remaining headroom, so with no tower or sheet here (extra = 0) the shade is exactly the cumulus one.
    const shade = smoothstep(0, 1, modelled.add(modelled.oneMinus().mul(extra)));
    // Thin edges read slightly lighter and bluer, like scattered sky light.
    const rim = smoothstep(look.threshold, look.threshold.mul(4), f0).oneMinus().mul(0.35);
    const litBase = mix(look.litColor, look.midColor, rim).mul(byType(float(0), fNb, float(1), nb.lit));
    // A tower's body is grey between its bright top and dark base.
    const midK = fNb.mul(nb.midBand).mul(smoothstep(0.3, 0.9, hn).oneMinus());
    const lit = mix(litBase, look.midColor, midK);
    const darkBase = look.shadeColor.mul(byType(float(0), fNb, float(1), nb.dark));
    const dark = mix(darkBase, look.midColor, fNb.mul(nb.lift));
    const colored = mix(lit, dark, shade);
    // Stratus goes grey: toward its own luminance.
    const luma = dot(colored, vec3(0.299, 0.587, 0.114));
    const streakK = n.mul(fSt);
    const color = mix(colored, vec3(luma), fSt.mul(st.grey)).mul(byType(fSt, float(0), st.tone, float(1))).mul(streakK.mul(st.streak).add(1));
    // Sheets are translucent at their thin fringe.
    const thin = smoothstep(look.threshold, look.threshold.mul(3.5), f0).oneMinus().mul(fSt).mul(st.thin);
    return vec4(color, coverage.mul(byType(fSt, float(0), st.alpha, float(1))).mul(thin.oneMinus()).mul(clamp(streakK.mul(st.streakAlpha).add(1), 0, 1)));
  });
}
