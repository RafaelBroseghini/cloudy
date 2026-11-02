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
  "volSigma", "volReach", "volRelief", "volWrap", "volPowder", "volPhaseG", "volMultiScatter", "volAmbient", "volAO", "volLumpScale",
  "volLumpStrength", "volDome", "volHeightCumulus", "volHeightStratus", "volHeightNimbus", "volSilver",
] as const;
const SCENERY_KEYS = [
  "farOpacity", "farTint", "farDrift", "farDensity", "midOpacity", "midTint", "midDrift", "midDensity", "nearOpacity",
  "nearTint", "nearDrift", "nearDensity",
] as const;
const POST_KEYS = ["fxExposure", "fxFlash", "fxFlashX", "fxFlashY"] as const;
const RAIN_KEYS = ["rainRate", "rainAngle", "rainSpeed", "windX"] as const;
const BREEZE_KEYS = ["breezeSpeed", "breezeAngle"] as const;

/** The param fields the renderer consumes (a subset of `P`; pass the whole resolved record if convenient). */
export const LOOK_KEYS = [...SKY_KEYS, ...LIGHT_KEYS, ...VOLUME_KEYS, ...SCENERY_KEYS, ...POST_KEYS, ...RAIN_KEYS, ...BREEZE_KEYS] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
export type LookValues = Partial<Pick<Values, LookKey>>;

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

  const { sky, look, vol, layers, post } = scene;
  sky.top.value.setRGB(g("skyTopR"), g("skyTopG"), g("skyTopB"));
  sky.horizon.value.setRGB(g("skyHorizonR"), g("skyHorizonG"), g("skyHorizonB"));
  sky.bottom.value.setRGB(g("skyBottomR"), g("skyBottomG"), g("skyBottomB"));
  sky.sunColor.value.setRGB(g("skySunR"), g("skySunG"), g("skySunB"));
  sky.horizonHeight.value = g("skyHorizonHeight");
  sky.sunPos.value.set(g("skySunPosX"), g("skySunPosY"));
  sky.sunSize.value = g("skySunSize");
  sky.sunStrength.value = g("skySunStrength");

  look.litColor.value.setRGB(g("cloudLitR"), g("cloudLitG"), g("cloudLitB"));
  look.midColor.value.setRGB(g("cloudMidR"), g("cloudMidG"), g("cloudMidB"));
  // Ambient light lifts the shaded side toward the mid colour (flatter, less contrasty lighting).
  const amb = clamp01(g("lightAmbient"));
  look.shadeColor.value.copy(scratch.setRGB(g("cloudShadeR"), g("cloudShadeG"), g("cloudShadeB")).lerp(look.midColor.value, amb));

  // The sun that lights the clouds is the sky's sun: its screen position gives the direction in the view plane, and its
  // depth how far in front of (+) or behind (-) the clouds it sits. The scenery's cast shadows use the same direction.
  const sx = (g("skySunPosX") - 0.5) * 2;
  const sy = (g("skySunPosY") - 0.5) * 2;
  const sz = g("skySunDepth");
  const sl = Math.hypot(sx, sy, sz) || 1;
  vol.sun.value.set(sx / sl, sy / sl, sz / sl);
  const pl = Math.hypot(sx, sy);
  vol.sunDir.value.set(pl > 0.05 ? sx / pl : 0, pl > 0.05 ? sy / pl : 1);
  (layers.light.value as Vector2).copy(vol.sunDir.value);
  // Shadow contrast stretches the shadowed range of the light march (the old `lightGain` slider, same default feel).
  vol.contrast.value = g("lightGain") * 0.8;
  vol.sigma.value = g("volSigma");
  vol.marchLen.value = g("volReach");
  vol.nk.value = g("volRelief");
  vol.wrap.value = g("volWrap");
  vol.powder.value = g("volPowder");
  vol.gFwd.value = g("volPhaseG");
  vol.ms.value = g("volMultiScatter");
  vol.ambient.value = g("volAmbient");
  vol.aoK.value = g("volAO");
  vol.lumpStrength.value = g("volLumpStrength");
  vol.dome.value = g("volDome");
  vol.zScale.value.set(g("volHeightCumulus"), g("volHeightStratus"), g("volHeightNimbus"));
  vol.silver.value = g("volSilver");
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

  // Rain is render-only; wind slants it (the sim gets the same windX/windY for blobs through the drive).
  scene.rain.setLook(g("rainRate"), g("rainSpeed"), Math.tan(g("rainAngle")) + g("windX") * WIND_SLANT);

  post.exposure.value = g("fxExposure");
  post.flash.value = g("fxFlash");
  post.flashX.value = g("fxFlashX");
  post.flashY.value = g("fxFlashY");
}
