// The one entry point that pushes resolved weather/scene params (src/params) into the renderer.
// Uniforms only, so it can run every frame without compiling anything. Colours are linear RGB: setRGB, never hex.
// Unset or non-finite fields fall back to the field defaults, so `applyLook(scene, {})` is the "clear" look.

import { Color, Vector2 } from "three/webgpu";
import { defaultValues, type Values } from "../params/index.ts";
import type { CloudyScene } from "./scene.ts";
import { WIND_SLANT } from "./rain.ts";
import { DENSITY_TO_COVERAGE, SCENERY_MAP } from "./scenery.ts";

const SKY_KEYS = [
  "skyTopR", "skyTopG", "skyTopB", "skyHorizonR", "skyHorizonG", "skyHorizonB", "skyBottomR", "skyBottomG", "skyBottomB",
  "skySunR", "skySunG", "skySunB", "skyHorizonHeight", "skySunPosX", "skySunPosY", "skySunSize", "skySunStrength",
] as const;
const LIGHT_KEYS = [
  "lightDirX", "lightDirY", "lightGain", "lightAmbient", "cloudLitR", "cloudLitG", "cloudLitB", "cloudMidR", "cloudMidG",
  "cloudMidB", "cloudShadeR", "cloudShadeG", "cloudShadeB",
] as const;
const SCENERY_KEYS = [
  "farOpacity", "farTint", "farDrift", "farDensity", "midOpacity", "midTint", "midDrift", "midDensity", "nearOpacity",
  "nearTint", "nearDrift", "nearDensity",
] as const;
const POST_KEYS = ["fxExposure", "fxFlash", "fxFlashX"] as const;
const RAIN_KEYS = ["rainRate", "rainAngle", "rainSpeed", "windX"] as const;

/** The param fields the renderer consumes (a subset of `P`; pass the whole resolved record if convenient). */
export const LOOK_KEYS = [...SKY_KEYS, ...LIGHT_KEYS, ...SCENERY_KEYS, ...POST_KEYS, ...RAIN_KEYS] as const;
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

  const { sky, look, layers, post } = scene;
  sky.top.value.setRGB(g("skyTopR"), g("skyTopG"), g("skyTopB"));
  sky.horizon.value.setRGB(g("skyHorizonR"), g("skyHorizonG"), g("skyHorizonB"));
  sky.bottom.value.setRGB(g("skyBottomR"), g("skyBottomG"), g("skyBottomB"));
  sky.sunColor.value.setRGB(g("skySunR"), g("skySunG"), g("skySunB"));
  sky.horizonHeight.value = g("skyHorizonHeight");
  sky.sunPos.value.set(g("skySunPosX"), g("skySunPosY"));
  sky.sunSize.value = g("skySunSize");
  sky.sunStrength.value = g("skySunStrength");

  const lx = g("lightDirX");
  const ly = g("lightDirY");
  look.lightOffset.value.set(lx, ly);
  look.lightGain.value = g("lightGain");
  look.litColor.value.setRGB(g("cloudLitR"), g("cloudLitG"), g("cloudLitB"));
  look.midColor.value.setRGB(g("cloudMidR"), g("cloudMidG"), g("cloudMidB"));
  // Ambient light lifts the shaded side toward the mid colour (flatter, less contrasty lighting).
  const amb = clamp01(g("lightAmbient"));
  look.shadeColor.value.copy(scratch.setRGB(g("cloudShadeR"), g("cloudShadeG"), g("cloudShadeB")).lerp(look.midColor.value, amb));
  const len = Math.hypot(lx, ly);
  (layers.light.value as Vector2).set(len > 1e-6 ? lx / len : 0, len > 1e-6 ? ly / len : 1);

  const lit = [g("cloudLitR") * ratio(1, DEFAULT_LIT[0]), g("cloudLitG") * ratio(1, DEFAULT_LIT[1]), g("cloudLitB") * ratio(1, DEFAULT_LIT[2])];
  const shade = [
    ratio(g("cloudShadeR"), DEFAULT_SHADE[0]),
    ratio(g("cloudShadeG"), DEFAULT_SHADE[1]),
    ratio(g("cloudShadeB"), DEFAULT_SHADE[2]),
  ];
  for (const name of ["far", "mid", "near"] as const) {
    const u = layers[name];
    const m = SCENERY_MAP[name];
    u.opacity.value = clamp01(g(`${name}Opacity`) * m.opacityGain);
    // Tint: how far toward the sky horizon colour (atmospheric perspective), on top of the layer's base haze.
    u.haze.value = m.baseHaze + clamp01(g(`${name}Tint`)) * (1 - m.baseHaze);
    u.drift.value.x = g(`${name}Drift`) * m.driftGain;
    u.coverage.value = m.coverageAtDefault - (g(`${name}Density`) - DEFAULTS[`${name}Density`]) * DENSITY_TO_COVERAGE;
    u.tint.value.setRGB(BASE[name].tint.r * lit[0]!, BASE[name].tint.g * lit[1]!, BASE[name].tint.b * lit[2]!);
    u.shade.value.setRGB(BASE[name].shade.r * shade[0]!, BASE[name].shade.g * shade[1]!, BASE[name].shade.b * shade[2]!);
  }

  // Rain is render-only; wind slants it (the sim gets the same windX/windY for blobs through the drive).
  scene.rain.setLook(g("rainRate"), g("rainSpeed"), Math.tan(g("rainAngle")) + g("windX") * WIND_SLANT);

  post.exposure.value = g("fxExposure");
  post.flash.value = g("fxFlash");
  post.flashX.value = g("fxFlashX");
}
