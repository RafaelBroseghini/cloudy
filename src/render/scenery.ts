// Render-only scenery layers around the interactive play layer (flat layers with a depth factor):
//   far bank (hazy, near the horizon) -> mid clouds (crisper) -> PLAY LAYER (cloudField.ts) -> near wisps (screen edges).
// Each layer is animated fractal noise thresholded into soft cloud; no sim, no raymarching, one fixed shader.
// Everything tunable is a uniform on `scenery.layers`, so weather/quality can drive it without recompiling.
//
// Depth cues: atmospheric perspective (`haze` blends toward the sky's horizon colour, far = hazy, low contrast),
// scale and edge softness by depth, drift speed by depth, parallax (`depth` factor: shift = offset * (1 - depth)),
// and a faint soft shadow of the play clouds on the layers behind.

import { Color, HalfFloatType, LinearFilter, NodeMaterial, QuadMesh, RenderTarget, Vector2, Vector3, type Node, type Renderer } from "three/webgpu";
import {
  clamp,
  exp,
  float,
  Fn,
  max,
  mix,
  mx_fractal_noise_float,
  screenUV,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { createParallax } from "./parallax.ts";
import { VIEW_HEIGHT } from "./view.ts";
import { extentOf, ign, litTerms, texUV, type VolumeLook } from "./volume.ts";

/** Half thickness (world units) of a layer's densest part: a far bank is a thin hazy slab, the near wisps puffier. */
const LAYER_Z = { far: 0.55, mid: 0.8, near: 0.5 } as const;

interface LayerDefaults {
  opacity: number;
  /** Depth factor: 1 = the play layer (never shifts), < 1 behind it, > 1 in front of it. */
  depth: number;
  /** World units per second (+x right, +y up). */
  drift: [number, number];
  /** Noise frequency per world unit (x, y). Smaller x than y gives streaky banks. */
  scale: [number, number];
  /** Noise value at which the cloud edge sits (lower = more cloud) and half-width of the soft edge. */
  coverage: number;
  softness: number;
  /** Where the layer lives: a horizontal band (centre/half-height in world y) pushes density up. */
  bandCenter: number;
  bandWidth: number;
  bandWeight: number;
  tint: string;
  shade: string;
  /** 0..1 blend toward the sky horizon colour (atmospheric perspective). */
  haze: number;
  /** Strength of the play clouds' shadow on this layer. */
  shadow: number;
  /** Noise evolution speed (z axis, 1/s). */
  evolve: number;
}

function createLayerUniforms(d: LayerDefaults) {
  return {
    opacity: uniform(d.opacity),
    depth: uniform(d.depth),
    drift: uniform(new Vector2(...d.drift)),
    scale: uniform(new Vector2(...d.scale)),
    coverage: uniform(d.coverage),
    softness: uniform(d.softness),
    bandCenter: uniform(d.bandCenter),
    bandWidth: uniform(d.bandWidth),
    bandWeight: uniform(d.bandWeight),
    tint: uniform(new Color(d.tint)),
    shade: uniform(new Color(d.shade)),
    haze: uniform(d.haze),
    shadow: uniform(d.shadow),
    evolve: uniform(d.evolve),
    /** CPU-integrated scroll (x, y) and noise phase (z): changing drift/evolve never makes the clouds jump. */
    phase: uniform(new Vector3()),
  };
}

export type SceneryLayer = ReturnType<typeof createLayerUniforms>;

export interface SceneryContext {
  aspect: Node<"float">;
  /** Raw play-layer density at a world position. */
  fieldDensity: (p: Node<"vec2">) => Node<"float">;
  /** Density at which the play-cloud edge sits. */
  playThreshold: Node<"float">;
  /** Sky horizon colour: the colour distance fades toward. */
  horizon: Node<"color">;
  cursorPos: Node<"vec2">;
  cursorActive: Node<"float">;
  cursorRadius: Node<"float">;
}

const SHADOW_REACH = 2.2;

/**
 * How the weather model's per-layer fields ({prefix}Opacity/Tint/Drift/Density, see src/params/fields.ts) map onto the
 * layer uniforms. Tuned so the field defaults reproduce the default look; see `applyLook` in look.ts.
 */
export const SCENERY_MAP = {
  far: { opacityGain: 1.25, baseHaze: 0.45, driftGain: 5, coverageAtDefault: 0.28, tint: "#ffffff", shade: "#c3d6ec" },
  mid: { opacityGain: 1.1, baseHaze: 0.3, driftGain: 7, coverageAtDefault: 0.5, tint: "#f3f8ff", shade: "#9bb2d6" },
  near: { opacityGain: 1.7, baseHaze: 0, driftGain: 8.4, coverageAtDefault: 0.42, tint: "#ffffff", shade: "#dbe7f6" },
} as const;
/** Scenery layer speed per unit of breeze velocity, times the layer's depth factor (nearer layers move faster). */
export const SCENERY_BREEZE_GAIN = 0.5;
/** Noise units of coverage threshold per unit of the 0..1 Density field. */
export const DENSITY_TO_COVERAGE = 0.6;

export function createScenery() {
  const layers = {
    /** How many scenery layers are drawn: 0..3, fractional fades the last one (quality tiers). */
    count: uniform(3),
    /** Overall drift/evolution speed multiplier (reduced motion scales it down). */
    motion: uniform(1),
    /** 0..1 weather greying of all scenery: colours are multiplied toward `greyTint`. */
    grey: uniform(0),
    greyTint: uniform(new Color(0.6, 0.65, 0.73)),
    /** Unit vector toward the light (world, y-up): shadows fall the other way. */
    light: uniform(new Vector2(-0.3, 1.1).normalize()),
    far: createLayerUniforms({
      opacity: 0.62,
      depth: 0.15,
      drift: [0.05, 0],
      scale: [0.2, 0.55],
      coverage: 0.28,
      softness: 0.3,
      bandCenter: -0.8,
      bandWidth: 2.8,
      bandWeight: 0.5,
      tint: "#ffffff",
      shade: "#c3d6ec",
      haze: 0.62,
      shadow: 0.55,
      evolve: 0.04,
    }),
    mid: createLayerUniforms({
      opacity: 0.78,
      depth: 0.55,
      drift: [0.14, 0],
      scale: [0.3, 0.5],
      coverage: 0.5,
      softness: 0.14,
      bandCenter: 1.3,
      bandWidth: 3.4,
      bandWeight: 0.45,
      tint: "#f3f8ff",
      shade: "#9bb2d6",
      haze: 0.42,
      shadow: 0.8,
      evolve: 0.07,
    }),
    near: createLayerUniforms({
      opacity: 0.6,
      depth: 1.9,
      drift: [0.42, 0],
      scale: [0.2, 0.34],
      coverage: 0.42,
      softness: 0.3,
      bandCenter: 0,
      bandWidth: 1,
      bandWeight: 0.6,
      tint: "#ffffff",
      shade: "#dbe7f6",
      haze: 0.0,
      shadow: 0,
      evolve: 0.1,
    }),
  };

  /** Screen shift of the scenery (world units). The play layer ignores it. */
  const parallax = uniform(new Vector2());
  const motion = createParallax();

  let reduced = false;
  if (typeof matchMedia === "function") {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    motion.setReducedMotion(reduced);
    mq.addEventListener?.("change", (e) => {
      reduced = e.matches;
      motion.setReducedMotion(reduced);
    });
  }

  const weightOf = (index: number) => clamp(layers.count.sub(index), 0, 1);

  // Lit scenery (quarter-res bake): each layer's thickness goes to one channel of a small target, and the composite lights
  // it with the same terms as the play layer. Far banks are hazier and lower in contrast, so the play clouds stay the focus.
  const sunGlobal = (vol: VolumeLook) => vol.sunDir;
  const bakeMaterial = new NodeMaterial();
  const band = (u: SceneryLayer) => (p: Node<"vec2">) => {
    const d = p.y.sub(u.bandCenter).div(u.bandWidth);
    return exp(d.mul(d).negate());
  };
  const regionOf = {
    far: band(layers.far),
    mid: band(layers.mid),
  };
  /** Coverage-ish 0..1 of a layer's noise at a layer-space point, in the same terms as the old flat layers (edge ramp over 3 softness). */
  function layerH(u: SceneryLayer, octaves: number, region: (p: Node<"vec2">) => Node<"float">, wp: Node<"vec2">, zs: number): Node<"float"> {
    const shift = parallax.mul(float(1).sub(u.depth));
    const p = wp.sub(shift).sub(u.phase.xy);
    const s0 = mx_fractal_noise_float(vec3(p.mul(u.scale), u.phase.z), octaves, 2, 0.5).add(region(p).mul(u.bandWeight));
    const a = clamp(s0.sub(u.coverage.sub(u.softness)).div(u.softness.mul(3)), 0, 1);
    return sqrt(a).mul(zs);
  }
  // Evaluated in screen space (not layer space) so the wisps hug the screen edges whatever the parallax.
  const nearRegion = (aspect: Node<"float">) => (_p: Node<"vec2">, wp: Node<"vec2">) => {
    const halfW = aspect.mul(VIEW_HEIGHT * 0.5);
    const edge = smoothstep(0.45, 1.0, wp.x.div(halfW).abs());
    const bottom = smoothstep(float(-VIEW_HEIGHT * 0.1), float(-VIEW_HEIGHT * 0.5), wp.y);
    return max(edge, bottom);
  };

  const target = new RenderTarget(2, 2, {
    type: HalfFloatType,
    depthBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });
  let bakeQuad: QuadMesh | null = null;
  let bakeAspect: Node<"float"> | null = null;

  /** Build the bake pass and return the lit layer functions. Called once by the scene, with its aspect and volume look. */
  function lit(aspect: Node<"float">, vol: VolumeLook) {
    bakeAspect = aspect;
    bakeMaterial.fragmentNode = Fn(() => {
      const uvUp = vec2(screenUV.x, screenUV.y.oneMinus());
      const wp = uvUp.sub(0.5).mul(extentOf(aspect));
      const far = layerH(layers.far, 2, regionOf.far, wp, LAYER_Z.far);
      const mid = layerH(layers.mid, 3, regionOf.mid, wp, LAYER_Z.mid);
      const near = layerH(layers.near, 2, (p) => nearRegion(aspect)(p, wp), wp, LAYER_Z.near);
      return vec4(far, mid, near, 1);
    })();
    bakeMaterial.depthTest = false;
    bakeMaterial.depthWrite = false;
    bakeQuad = new QuadMesh(bakeMaterial);

    const bake = texture(target.texture);
    const layer = (name: "far" | "mid" | "near", ch: "r" | "g" | "b", index: number, aoOn: boolean) => {
      const u = layers[name];
      const zs = LAYER_Z[name];
      const Hat = (p: Node<"vec2">) => bake.sample(texUV(p, aspect))[ch];
      return (wp: Node<"vec2">, ctx: SceneryContext) => {
        const h = Hat(wp);
        const a = h.div(zs).pow(2);
        const coverage = smoothstep(0, 0.667, a);
        const T = litTerms({ Hat, wp, h, vol, steps: vol.sceneSteps, aoTaps: aoOn ? vol.aoTaps : null, jitter: ign() });
        // Aerial perspective: hazier layers lose lighting contrast (pulled to a flat mean), then drift to the horizon colour.
        const contrast = float(1).sub(u.haze.mul(0.5));
        const direct = mix(float(0.64), T.lt.mul(mix(float(0.6), float(1), T.wd)), contrast);
        const shadeAmt = clamp(float(1).sub(direct), 0, 1).mul(mix(float(1), T.ao, 0.8));
        // Soft shadow of the play clouds, offset toward the sun more for layers farther back.
        const reach = float(1).sub(u.depth).max(0).mul(SHADOW_REACH);
        const playBody = float(1).sub(ctx.fieldDensity(wp.add(sunGlobal(vol).mul(reach))).mul(-0.8).exp());
        const shade = max(shadeAmt, playBody.mul(u.shadow));
        let color: Node<"vec3"> = mix(u.tint, u.shade, clamp(shade, 0, 1));
        color = mix(color, ctx.horizon, u.haze);
        color = mix(color, color.mul(layers.greyTint), layers.grey);
        let alpha = coverage.mul(u.opacity).mul(weightOf(index));
        if (name === "near") {
          // Foreground wisps stay off the play clouds and the cursor so play stays readable.
          const onCloud = smoothstep(0.0, ctx.playThreshold.mul(1.4), ctx.fieldDensity(wp));
          const nearCursor = float(1)
            .sub(smoothstep(ctx.cursorRadius, ctx.cursorRadius.add(2.2), wp.sub(ctx.cursorPos).length()))
            .mul(ctx.cursorActive);
          alpha = alpha.mul(float(1).sub(onCloud.mul(0.8))).mul(float(1).sub(nearCursor.mul(0.85)));
        }
        return vec4(color, alpha);
      };
    };
    return {
      /** Far hazy bank: thickness only (no ring AO). Shadowed by the play clouds. */
      far: layer("far", "r", 0, false),
      /** Mid clouds: the one layer with ring AO. */
      mid: layer("mid", "g", 1, true),
      /** Near wisps: big and soft, only toward the bottom and the screen sides. */
      near: layer("near", "b", 2, false),
    };
  }

  return {
    layers,
    parallax,
    lit,
    /** The bake target (quarter-res thickness of all three layers) and its resize: the scene owns the resolution. */
    bakeTarget: target,
    /** Render the bake pass into its target. */
    bake(renderer: Renderer): void {
      if (!bakeQuad || !bakeAspect) return;
      renderer.setRenderTarget(target);
      bakeQuad.render(renderer);
    },
    dispose(): void {
      target.dispose();
      bakeMaterial.dispose();
    },
    /**
     * Per rendered frame: pointer in world units (null = absent), view half extents, and elapsed seconds.
     * Integrates drift on the CPU so changing drift speeds never makes the layers jump.
     */
    /** True while prefers-reduced-motion is on: evolution everywhere runs much slower. */
    reduced: (): boolean => reduced,
    /** Scale of the parallax shift (the depth slider): 0 = flat, 1 = default. Eases in `update`. */
    setParallaxStrength: (s: number): void => motion.setStrength(s),
    update(pointer: { x: number; y: number } | null, halfW: number, dt: number): void {
      motion.setTarget(pointer ? { x: pointer.x / halfW, y: pointer.y / (VIEW_HEIGHT / 2) } : null);
      motion.step(dt);
      parallax.value.set(motion.offset.x * VIEW_HEIGHT, motion.offset.y * VIEW_HEIGHT);
      const m = layers.motion.value * (reduced ? 0.2 : 1);
      const d = Math.min(Math.max(dt, 0), 0.25) * m;
      for (const l of [layers.far, layers.mid, layers.near]) {
        l.phase.value.x += l.drift.value.x * d;
        l.phase.value.y += l.drift.value.y * d;
        l.phase.value.z += l.evolve.value * d;
      }
    },
  };
}

export type Scenery = ReturnType<typeof createScenery>;
