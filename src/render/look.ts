// The one entry point that pushes resolved weather/scene params (src/params) into the renderer.
// Uniforms only, so it can run every frame without compiling anything. Colours are linear RGB: setRGB, never hex.
// Unset or non-finite fields fall back to the field defaults, so `applyLook(scene, {})` is the "clear" look.

import { Color, Vector2 } from "three/webgpu";
import { defaultValues, type Values } from "../params/index.ts";
import type { CloudyScene } from "./scene.ts";
import { WIND_SLANT } from "./rain.ts";
import { DENSITY_TO_COVERAGE, SCENERY_BREEZE_GAIN, SCENERY_MAP } from "./scenery.ts";

const SKY_KEYS = [
  "skyTopR", "skyTopG", "skyTopB", "skyHorizonR", "skyHorizonG", "skyHorizonB", "skyBottomR", "skyBottomG", "skyBottomB",
  "skySunR", "skySunG", "skySunB", "skyHorizonHeight", "skySunPosX", "skySunPosY", "skySunSize", "skySunStrength", "skySunDepth",
] as const;
const LIGHT_KEYS = [
  "lightGain", "lightAmbient", "cloudLitR", "cloudLitG", "cloudLitB", "cloudMidR", "cloudMidG",
  "cloudMidB", "cloudShadeR", "cloudShadeG", "cloudShadeB",
] as const;
const VOLUME_KEYS = [
  "volSigma", "volReach", "volSunGain", "volErosion", "volLumpScale", "volFlatBase", "volPowder", "volPhaseG", "volMultiScatter",
  "volAmbient", "volAO", "volSilver", "volHeightCumulus", "volHeightStratus", "volHeightNimbus",
] as const;
const SCENERY_KEYS = [
  "farOpacity", "farTint", "farDrift", "farDensity", "midOpacity", "midTint", "midDrift", "midDensity", "nearOpacity",
  "nearTint", "nearDrift", "nearDensity", "parallaxStrength",
] as const;
const POST_KEYS = ["fxExposure", "fxFlash", "fxFlashX", "fxFlashY"] as const;
const RAIN_KEYS = ["rainRate", "rainAngle", "rainSpeed", "windX"] as const;
const BREEZE_KEYS = ["breezeSpeed", "breezeAngle"] as const;

/** The param fields the renderer consumes (a subset of `P`; pass the whole resolved record if convenient). */
export const LOOK_KEYS = [...SKY_KEYS, ...LIGHT_KEYS, ...VOLUME_KEYS, ...SCENERY_KEYS, ...POST_KEYS, ...RAIN_KEYS, ...BREEZE_KEYS] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
export type LookValues = Partial<Pick<Values, LookKey>>;

/** The fine erosion octave is this fraction of the big one (the spike's 0.7 / 0.35). */
const EROSION_FINE_RATIO = 0.5;

/** How much more sky-light fill the clouds get when the sun is behind them (full at the dusk keyframe's sun depth, none from midday). */
const TWILIGHT_FILL = 0.45;

const DEFAULTS = defaultValues();

// Scenery base colours are tuned for the default cloud colours; weather lighting scales them (grey weather greys the scenery).
const BASE = {
  far: { tint: new Color(SCENERY_MAP.far.tint), shade: new Color(SCENERY_MAP.far.shade) },
  mid: { tint: new Color(SCENERY_MAP.mid.tint), shade: new Color(SCENERY_MAP.mid.shade) },
  near: { tint: new Color(SCENERY_MAP.near.tint), shade: new Color(SCENERY_MAP.near.shade) },
};
const DEFAULT_LIT = [DEFAULTS.cloudLitR, DEFAULTS.cloudLitG, DEFAULTS.cloudLitB] as const;
const DEFAULT_SHADE = [DEFAULTS.cloudShadeR, DEFAULTS.cloudShadeG, DEFAULTS.cloudShadeB] as const;
const ratio = (v: number, d: number): number => (d > 1e-6 ? v / d : 1);
const scratch = new Color();
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function applyLook(scene: CloudyScene, v: LookValues): void {
  const g = (k: LookKey): number => {
    const x = v[k];
    return x !== undefined && Number.isFinite(x) ? x : DEFAULTS[k];
  };

  const { sky, cloud, light, layers, post } = scene;
  sky.top.value.setRGB(g("skyTopR"), g("skyTopG"), g("skyTopB"));
  sky.horizon.value.setRGB(g("skyHorizonR"), g("skyHorizonG"), g("skyHorizonB"));
  sky.bottom.value.setRGB(g("skyBottomR"), g("skyBottomG"), g("skyBottomB"));
  sky.sunColor.value.setRGB(g("skySunR"), g("skySunG"), g("skySunB"));
  sky.horizonHeight.value = g("skyHorizonHeight");
  sky.sunPos.value.set(g("skySunPosX"), g("skySunPosY"));
  sky.sunSize.value = g("skySunSize");
  sky.sunStrength.value = g("skySunStrength");

  // The sunlight takes the sun's colour (half way to white, so midday stays near white): warm sunset clouds, rosy dusk ones.
  const sr = g("skySunR");
  const sg = g("skySunG");
  const sb = g("skySunB");
  const sm = Math.max(sr, sg, sb, 1e-3);
  cloud.litColor.value.setRGB(
    g("cloudLitR") * (0.5 + (0.5 * sr) / sm),
    g("cloudLitG") * (0.5 + (0.5 * sg) / sm),
    g("cloudLitB") * (0.5 + (0.5 * sb) / sm),
  );
  cloud.midColor.value.setRGB(g("cloudMidR"), g("cloudMidG"), g("cloudMidB"));
  // Ambient light lifts the shaded side toward the mid colour (flatter, less contrasty lighting).
  const amb = clamp01(g("lightAmbient"));
  cloud.shadeColor.value.copy(scratch.setRGB(g("cloudShadeR"), g("cloudShadeG"), g("cloudShadeB")).lerp(cloud.midColor.value, amb));

  // The sun that lights the clouds is the sky's sun: its screen position gives the direction in the view plane, and its
  // depth how far in front of (+) or behind (-) the clouds it sits. The scenery's cast shadows use the same direction.
  const sx = (g("skySunPosX") - 0.5) * 2;
  const sy = (g("skySunPosY") - 0.5) * 2;
  const sz = g("skySunDepth");
  const sl = Math.hypot(sx, sy, sz) || 1;
  cloud.sun.value.set(sx / sl, sy / sl, sz / sl);
  light.sun.value.copy(cloud.sun.value);
  const pl = Math.hypot(sx, sy);
  light.sunDir.value.set(pl > 0.05 ? sx / pl : 0, pl > 0.05 ? sy / pl : 1);
  (layers.light.value as Vector2).copy(light.sunDir.value);
  // The lit scenery's shadow contrast (the old `lightGain` slider, same default feel).
  light.contrast.value = g("lightGain") * 0.8;

  // The play clouds' volume: artist fields onto the march's uniforms (tier step counts are set by the scene).
  cloud.sigma.value = g("volSigma");
  cloud.reach.value = g("volReach");
  cloud.sunGain.value = g("volSunGain");
  cloud.erosion.value = g("volErosion");
  cloud.erosionFine.value = g("volErosion") * EROSION_FINE_RATIO;
  cloud.flatBase.value = g("volFlatBase");
  cloud.powder.value = g("volPowder");
  cloud.phaseG.value = g("volPhaseG");
  cloud.msGain.value = g("volMultiScatter");
  // Low or backlit sun (sunset, dusk): the clouds' faces are lit only by sky light, which is bright then, so the fill rises.
  const backlit = 1 - clamp01((sz / sl - -0.15) / 0.5);
  cloud.ambient.value = g("volAmbient") * (1 + TWILIGHT_FILL * backlit * backlit * (3 - 2 * backlit));
  cloud.aoK.value = g("volAO");
  cloud.silver.value = g("volSilver");
  scene.setThickness(g("volHeightCumulus"), g("volHeightStratus"), g("volHeightNimbus"));
  scene.setLumpScale(g("volLumpScale"));

  const lit = [g("cloudLitR") * ratio(1, DEFAULT_LIT[0]), g("cloudLitG") * ratio(1, DEFAULT_LIT[1]), g("cloudLitB") * ratio(1, DEFAULT_LIT[2])];
  const shade = [
    ratio(g("cloudShadeR"), DEFAULT_SHADE[0]),
    ratio(g("cloudShadeG"), DEFAULT_SHADE[1]),
    ratio(g("cloudShadeB"), DEFAULT_SHADE[2]),
  ];
  // The breeze that moves the play clouds also carries the scenery, scaled by depth (far banks barely move, wisps up front fly).
  const bx = g("breezeSpeed") * Math.cos(g("breezeAngle"));
  const by = g("breezeSpeed") * Math.sin(g("breezeAngle"));
  for (const name of ["far", "mid", "near"] as const) {
    const u = layers[name];
    const m = SCENERY_MAP[name];
    u.opacity.value = clamp01(g(`${name}Opacity`) * m.opacityGain);
    // Tint: how far toward the sky horizon colour (atmospheric perspective), on top of the layer's base haze.
    u.haze.value = m.baseHaze + clamp01(g(`${name}Tint`)) * (1 - m.baseHaze);
    const follow = u.depth.value * SCENERY_BREEZE_GAIN;
    u.drift.value.x = g(`${name}Drift`) * m.driftGain + bx * follow;
    u.drift.value.y = by * follow;
    u.coverage.value = m.coverageAtDefault - (g(`${name}Density`) - DEFAULTS[`${name}Density`]) * DENSITY_TO_COVERAGE;
    u.tint.value.setRGB(BASE[name].tint.r * lit[0]!, BASE[name].tint.g * lit[1]!, BASE[name].tint.b * lit[2]!);
    u.shade.value.setRGB(BASE[name].shade.r * shade[0]!, BASE[name].shade.g * shade[1]!, BASE[name].shade.b * shade[2]!);
  }

  scene.setParallaxStrength(g("parallaxStrength"));

  // Rain is render-only; wind slants it (the sim gets the same windX/windY for blobs through the drive).
  scene.rain.setLook(g("rainRate"), g("rainSpeed"), Math.tan(g("rainAngle")) + g("windX") * WIND_SLANT);

  post.exposure.value = g("fxExposure");
  post.flash.value = g("fxFlash");
  post.flashX.value = g("fxFlashX");
  post.flashY.value = g("fxFlashY");
}
