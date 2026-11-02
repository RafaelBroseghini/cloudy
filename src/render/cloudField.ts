// Metaball cloud field.
// Pass 1 (splat): one instanced quad per blob, additively splatted into a half-res half-float target.
// Pass 2 (shade): `shadeClouds` turns the density into lit cloud colour over the sky (called from scene.ts).

import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  HalfFloatType,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  type Node,
  NodeMaterial,
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
import { BLOB_STRIDE, CLOUD_THRESHOLD, DENSITY_REF_RADIUS, INFLUENCE_FACTOR, MAX_BLOBS } from "../sim/blobBuffer.ts";
import { VIEW_HEIGHT } from "./view.ts";


/**
 * The splat pass reads the sim's blob buffer in place: the geometry's instance attributes are three
 * interleaved views (xy+radius+mass, vx vy cloudId alive, type one-hot) over the same 12-float records, so the
 * per-frame cost is one bufferSubData/writeBuffer of <= MAX_BLOBS * 48 bytes (12 KB). A data texture would need an
 * RGBA32F upload plus a texelFetch per vertex; instanced attributes work identically on WebGPU and WebGL2.
 *
 * The field target carries R = density (all types, as before), G = the stratus part of that density and
 * B = the cumulonimbus part (each blob's contribution times its one-hot type). The shade pass divides G and B by R
 * for the local type mix, so a mixed cloud blends smoothly from one look to the other. Alpha stays 1: three's additive
 * blending multiplies rgb by the source alpha, so anything stored there would corrupt R.
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
  geometry.instanceCount = 0;

  const blobA = attribute("aBlobA", "vec4"); // x, y, radius, mass
  const blobB = attribute("aBlobB", "vec4"); // vx, vy, cloudId, alive
  const blobC = attribute("aBlobC", "vec4"); // type one-hot: cumulus, stratus, cumulonimbus, spare
  // Read the raw attribute: positionLocal is overwritten by positionNode in the fragment stage.
  const corner = attribute("position", "vec3").xy; // -1..1 across the quad
  const reach = blobA.z.mul(INFLUENCE_FACTOR);

  const material = new NodeMaterial();
  material.positionNode = vec3(blobA.xy.add(corner.mul(reach)), 0);
  const q2 = dot(corner, corner);
  const falloff = max(q2.oneMinus(), 0);
  // W(q) = (1 - q^2)^3, scaled by mass * (DENSITY_REF_RADIUS / radius)^2 like blobDensity; dead slots (alive = 0) add nothing.
  const weight = blobA.w.mul(float(DENSITY_REF_RADIUS).div(blobA.z).pow(2));
  const contribution = falloff.mul(falloff).mul(falloff).mul(weight).mul(blobB.w);
  material.fragmentNode = vec4(contribution, contribution.mul(blobC.y), contribution.mul(blobC.z), 1);
  material.blending = AdditiveBlending;
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
      /** Edge erosion and noise-driven shading: far smoother than cumulus. */
      erosion: uniform(0.45),
      billowShade: uniform(0.4),
      /** Wider soft edge. */
      softness: uniform(1.9),
      /** Light gain: weak, so the sheet is evenly lit rather than modelled. */
      gain: uniform(0.7),
      /** 0..1 (not a multiplier): how far the colour goes to grey. */
      grey: uniform(0.6),
      /** Multiplier on coverage: a thin sheet, so the sky and rain show a little through. */
      alpha: uniform(0.9),
      /** Multiplier on the final colour: a dimmer, overcast sheet. */
      tone: uniform(0.88),
    },
    nimbus: {
      /** Crisper, more detailed edge. */
      erosion: uniform(1.25),
      softness: uniform(0.55),
      /** Light gain and how much farther toward the light the shadow sample reaches (long shadows = deep dark body). */
      gain: uniform(0.7),
      reach: uniform(2.2),
      /** 0..1 (not a multiplier): extra shade for pixels with cloud above them (toward the light): dark base, bright top. */
      thickDark: uniform(0.9),
      /** Multiplier on the shade colour (darker underside) and on the lit colour (brighter top). */
      dark: uniform(0.58),
      lit: uniform(1.12),
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

    // Noise in the air's frame, bent by a slowly evolving swirl so edges roll and billow instead of sliding.
    const q = p.sub(look.air);
    const warp = mx_fractal_noise_vec2(vec3(q.mul(look.warpScale), look.billow.mul(0.6).add(11.3)), 2, 2, 0.5).mul(look.warp);
    const n = mx_fractal_noise_float(vec3(q.add(warp).mul(look.noiseScale), look.billow), 3, 2, 0.5);
    // Multiplicative erosion keeps empty sky empty and only bites near the edges.
    const erosion = look.erosion.mul(byType(fSt, fNb, st.erosion, nb.erosion));
    const f0 = d.mul(n.mul(erosion).add(1));
    const soft = look.softness.mul(byType(fSt, fNb, st.softness, nb.softness));
    const coverage = smoothstep(look.threshold.sub(soft), look.threshold.add(soft), f0);

    // The side toward the light is denser => we are in shadow; emptier or equal => lit.
    const reach = byType(fSt, fNb, float(1), nb.reach);
    // Longer reach goes mostly up (not up-left), so a tower's left edge is not left with a lit sliver.
    const upPos = p.add(look.lightOffset.mul(vec2(1, reach)));
    const upField = fieldAt(upPos);
    const above = upField.r.mul(-0.8).exp().oneMinus();
    const diff = body(p).sub(above);
    const gain = look.lightGain.mul(byType(fSt, fNb, st.gain, nb.gain));
    const billowShade = look.billowShade.mul(byType(fSt, fNb, st.billowShade, float(1)));
    // A storm tower is dark wherever there is a lot of cloud between the pixel and the light: base and body dark, top bright.
    // Only storm cloud above darkens a tower: a stratus sheet or cumulus higher up the screen casts no shade on it.
    const aboveNb = clamp(upField.b.div(max(upField.r, 0.02)), 0, 1);
    const thick = fNb.mul(nb.thickDark).mul(smoothstep(0.02, 0.75, above.mul(aboveNb)));
    const modelled = clamp(diff.mul(gain).negate().add(n.mul(billowShade)), 0, 1);
    // max, not a sum: a tower's interior has a positive gradient (denser than the sky above it) that would cancel the darkening.
    const shade = smoothstep(0, 1, max(modelled, thick));
    // Thin edges read slightly lighter and bluer, like scattered sky light.
    const rim = smoothstep(look.threshold, look.threshold.mul(4), f0).oneMinus().mul(0.35);
    const lit = mix(look.litColor, look.midColor, rim).mul(byType(float(0), fNb, float(1), nb.lit));
    const dark = look.shadeColor.mul(byType(float(0), fNb, float(1), nb.dark));
    const colored = mix(lit, dark, shade);
    // Stratus goes grey: toward its own luminance.
    const luma = dot(colored, vec3(0.299, 0.587, 0.114));
    const color = mix(colored, vec3(luma), fSt.mul(st.grey)).mul(byType(fSt, float(0), st.tone, float(1)));
    return vec4(color, coverage.mul(byType(fSt, float(0), st.alpha, float(1))));
  });
}
