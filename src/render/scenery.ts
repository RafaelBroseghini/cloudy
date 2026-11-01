// Render-only scenery layers around the interactive play layer (flat layers with a depth factor):
//   far bank (hazy, near the horizon) -> mid clouds (crisper) -> PLAY LAYER (cloudField.ts) -> near wisps (screen edges).
// Each layer is animated fractal noise thresholded into soft cloud; no sim, no raymarching, one fixed shader.
// Everything tunable is a uniform on `scenery.layers`, so weather/quality can drive it without recompiling.
//
// Depth cues: atmospheric perspective (`haze` blends toward the sky's horizon colour, far = hazy, low contrast),
// scale and edge softness by depth, drift speed by depth, parallax (`depth` factor: shift = offset * (1 - depth)),
// and a faint soft shadow of the play clouds on the layers behind.

import { Color, Vector2, Vector3, type Node } from "three/webgpu";
import {
  clamp,
  exp,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { createParallax } from "./parallax.ts";
import { VIEW_HEIGHT } from "./view.ts";

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
      evolve: 0.015,
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
      evolve: 0.03,
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
      evolve: 0.05,
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

  /** Shared layer body. `region` is a 0..1 mask that pushes density up where the layer should live. */
  function draw(
    u: SceneryLayer,
    index: number,
    wp: Node<"vec2">,
    ctx: SceneryContext,
    opts: { octaves: number; lit: boolean; region: (p: Node<"vec2">) => Node<"float">; avoidPlay: boolean },
  ) {
    const shift = parallax.mul(float(1).sub(u.depth));
    const p = wp.sub(shift).sub(u.phase.xy);
    const field = (q: Node<"vec2">) =>
      mx_fractal_noise_float(vec3(q.mul(u.scale), u.phase.z), opts.octaves, 2, 0.5).add(
        opts.region(q).mul(u.bandWeight),
      );

    const s0 = field(p);
    const coverage = smoothstep(u.coverage.sub(u.softness), u.coverage.add(u.softness), s0);

    // Underside shading: cheap vertical gradient; the lit layer also compares density toward the light.
    const g = smoothstep(-1, 1, p.y.sub(u.bandCenter).div(u.bandWidth));
    let shadeAmount: Node<"float"> = float(1).sub(g).mul(0.55);
    if (opts.lit) {
      const toLight = field(p.add(layers.light.mul(0.7))).sub(s0);
      shadeAmount = max(shadeAmount.mul(0.5), smoothstep(0, 1, clamp(toLight.mul(2.4), 0, 1)));
    }
    // Soft shadow of the play clouds, offset away from the light more for layers farther back.
    const reach = float(1).sub(u.depth).max(0).mul(SHADOW_REACH);
    const playBody = float(1).sub(ctx.fieldDensity(wp.add(layers.light.mul(reach))).mul(-0.8).exp());
    shadeAmount = max(shadeAmount, playBody.mul(u.shadow));

    let color: Node<"vec3"> = mix(u.tint, u.shade, clamp(shadeAmount, 0, 1));
    color = mix(color, ctx.horizon, u.haze);
    color = mix(color, color.mul(layers.greyTint), layers.grey);

    let alpha = coverage.mul(u.opacity).mul(weightOf(index));
    if (opts.avoidPlay) {
      // Foreground wisps stay off the play clouds and the cursor so play stays readable.
      const onCloud = smoothstep(0.0, ctx.playThreshold.mul(1.4), ctx.fieldDensity(wp));
      const nearCursor = float(1)
        .sub(smoothstep(ctx.cursorRadius, ctx.cursorRadius.add(2.2), wp.sub(ctx.cursorPos).length()))
        .mul(ctx.cursorActive);
      alpha = alpha.mul(float(1).sub(onCloud.mul(0.8))).mul(float(1).sub(nearCursor.mul(0.85)));
    }
    return vec4(color, alpha);
  }

  const band = (u: SceneryLayer) => (p: Node<"vec2">) => {
    const d = p.y.sub(u.bandCenter).div(u.bandWidth);
    return exp(d.mul(d).negate());
  };

  return {
    layers,
    parallax,
    /** Far hazy bank: low frequency, 2 octaves, flat shading, shadowed by the play clouds. */
    far: (wp: Node<"vec2">, ctx: SceneryContext) =>
      draw(layers.far, 0, wp, ctx, { octaves: 2, lit: false, region: band(layers.far), avoidPlay: false }),
    /** Mid clouds: 3 octaves plus a light-side sample for modelling. */
    mid: (wp: Node<"vec2">, ctx: SceneryContext) =>
      draw(layers.mid, 1, wp, ctx, { octaves: 3, lit: true, region: band(layers.mid), avoidPlay: false }),
    /** Near wisps: 2 octaves, big and soft, only toward the bottom and the screen sides. */
    near: (wp: Node<"vec2">, ctx: SceneryContext) =>
      draw(layers.near, 2, wp, ctx, {
        octaves: 2,
        lit: false,
        avoidPlay: true,
        region: () => {
          const halfW = ctx.aspect.mul(VIEW_HEIGHT * 0.5);
          // Evaluated in screen space (not layer space) so the wisps hug the screen edges whatever the parallax.
          const sx = wp.x.div(halfW).abs();
          const edge = smoothstep(0.45, 1.0, sx);
          const bottom = smoothstep(float(-VIEW_HEIGHT * 0.1), float(-VIEW_HEIGHT * 0.5), wp.y);
          return max(edge, bottom);
        },
      }),
    /**
     * Per rendered frame: pointer in world units (null = absent), view half extents, and elapsed seconds.
     * Integrates drift on the CPU so changing drift speeds never makes the layers jump.
     */
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
