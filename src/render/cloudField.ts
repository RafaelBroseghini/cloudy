// Metaball cloud field.
// Pass 1 (splat): one instanced quad per blob, additively splatted into a half-res half-float target.
// The thickness, billows and lighting built on this field live in volume.ts.

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
  dot,
  float,
  max,
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
    /** The shared instanced blobs: volume.ts draws its height splat from the same geometry (one upload for both). */
    geometry,
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
      /** Wider soft edge (as a multiple of the base; under 1.9, or the ramp starts below zero density and leaves a hard rim where the field ends). */
      softness: uniform(1.85),
      /** Light gain: weak, so the sheet is evenly lit rather than modelled. */
      gain: uniform(0.7),
      /** 0..1 (not a multiplier): how far the colour goes to grey. */
      grey: uniform(0.3),
      /** Multiplier on coverage: a thin sheet, so the sky and rain show a little through. */
      alpha: uniform(0.88),
      /** 0..1: how much the thin fringe of a sheet goes translucent on top of that. */
      thin: uniform(0.6),
      /** Soft roll along the sheet: how much the stretched noise swells and thins its thickness (0 = a flat slab). */
      roll: uniform(1.2),
      /** Multiplier on the final colour: a dimmer, overcast sheet. */
      tone: uniform(0.97),
      /** Noise stretch along x and y (a sheet streaks horizontally) and the share of the cumulus swirl kept. */
      stretch: uniform(new Vector2(0.2, 1.7)),
      /** How much the stretched noise streaks the sheet's brightness and its opacity (0 = smooth). */
      streak: uniform(0.26),
      streakAlpha: uniform(0.4),
      warp: uniform(0.5),
      /** 0..1: how much of the sheet's lower part is shaded toward grey. */
      under: uniform(0.35),
    },
    nimbus: {
      /** Edge erosion and softness: billowy like cumulus, a little crisper. */
      erosion: uniform(1.1),
      softness: uniform(0.75),
      /** Light gain. */
      gain: uniform(0.8),
      /** Height within the cloud (0..1) under which the base is dark, and how dark (0..1 of the shade). */
      baseEnd: uniform(0.5),
      baseDark: uniform(0.9),
      /** 0..1: how much of the middle goes to the mid colour (grey body between the bright top and dark base). */
      midBand: uniform(0.4),
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
