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
 * The splat pass reads the sim's blob buffer in place: the geometry's instance attributes are two
 * interleaved views (xy+radius+mass, vx vy cloudId alive) over the same 8-float records, so the per-frame
 * cost is one bufferSubData/writeBuffer of <= MAX_BLOBS * 32 bytes. A data texture would need an
 * RGBA32F upload plus a texelFetch per vertex; instanced attributes work identically on WebGPU and WebGL2.
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
  geometry.instanceCount = 0;

  const blobA = attribute("aBlobA", "vec4"); // x, y, radius, mass
  const blobB = attribute("aBlobB", "vec4"); // vx, vy, cloudId, alive
  // Read the raw attribute: positionLocal is overwritten by positionNode in the fragment stage.
  const corner = attribute("position", "vec3").xy; // -1..1 across the quad
  const reach = blobA.z.mul(INFLUENCE_FACTOR);

  const material = new NodeMaterial();
  material.positionNode = vec3(blobA.xy.add(corner.mul(reach)), 0);
  const q2 = dot(corner, corner);
  const falloff = max(q2.oneMinus(), 0);
  // W(q) = (1 - q^2)^3, scaled by mass * (DENSITY_REF_RADIUS / radius)^2 like blobDensity; dead slots (alive = 0) add nothing.
  const weight = blobA.w.mul(float(DENSITY_REF_RADIUS).div(blobA.z).pow(2));
  material.fragmentNode = vec4(falloff.mul(falloff).mul(falloff).mul(weight).mul(blobB.w), 0, 0, 1);
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
    noiseSpeed: uniform(0.12),
    /** World-space offset toward the light used for the second density sample. */
    lightOffset: uniform(new Vector2(-0.3, 1.1)),
    lightGain: uniform(2.6),
    litColor: uniform(new Color("#ffffff")),
    midColor: uniform(new Color("#dfe9f6")),
    shadeColor: uniform(new Color("#9fb3d6")),
  };
}

export type CloudLook = ReturnType<typeof createCloudLook>;

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

  const density = Fn(([p]: [Node<"vec2">]) => {
    // Render-target textures are sampled y-down on both backends (three flips them on WebGL), like screenUV.
    const d = field.sample(p.div(extent).add(0.5).flipY()).r;
    const n = mx_fractal_noise_float(
      vec3(p.mul(look.noiseScale).add(vec2(time.mul(look.noiseSpeed), 0)), time.mul(0.07)),
      3,
      2,
      0.5,
    );
    // Multiplicative erosion keeps empty sky empty and only bites near the edges.
    return d.mul(n.mul(look.erosion).add(1));
  });

  // Soft-saturated, un-eroded density for lighting: interior stays flat so only real surfaces shade.
  const body = Fn(([p]: [Node<"vec2">]) => {
    const d = field.sample(p.div(extent).add(0.5).flipY()).r;
    return d.mul(-0.8).exp().oneMinus();
  });

  return Fn(([p]: [Node<"vec2">]) => {
    const f0 = density(p);
    const coverage = smoothstep(look.threshold.sub(look.softness), look.threshold.add(look.softness), f0);
    // The side toward the light is denser => we are in shadow; emptier or equal => lit.
    const diff = body(p).sub(body(p.add(look.lightOffset)));
    const shade = smoothstep(0, 1, clamp(diff.mul(look.lightGain).negate(), 0, 1));
    // Thin edges read slightly lighter and bluer, like scattered sky light.
    const rim = smoothstep(look.threshold, look.threshold.mul(4), f0).oneMinus().mul(0.35);
    const lit = mix(look.litColor, look.midColor, rim);
    const color = mix(lit, look.shadeColor, shade);
    return vec4(color, coverage);
  });
}
