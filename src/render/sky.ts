import { Color, Vector2, type Node } from "three/webgpu";
import { float, mix, pow, smoothstep, uniform, vec2, exp, dot } from "three/tsl";

/** Sky parameters. All uniforms: changing them never recompiles anything. */
export function createSky() {
  const top = uniform(new Color("#4f9be0"));
  const horizon = uniform(new Color("#bfe3f7"));
  const bottom = uniform(new Color("#e9f3f2"));
  /** Height (0 bottom .. 1 top of screen) where the horizon colour sits. */
  const horizonHeight = uniform(0.38);
  /** Sun in screen-uv space (0..1), glow radius in uv-height units. */
  const sunPos = uniform(new Vector2(0.78, 0.8));
  const sunSize = uniform(0.22);
  const sunColor = uniform(new Color("#fff1c9"));
  const sunStrength = uniform(0.55);

  /** `aspect` uniform node keeps the glow round. */
  const colorAt = (aspect: Node<"float">, uvUp: Node<"vec2">) => {
    const v = uvUp.y;
    const up = pow(smoothstep(horizonHeight, float(1), v), float(0.9));
    const down = smoothstep(horizonHeight, float(0), v);
    const base = mix(mix(horizon, top, up), bottom, down);
    const d = uvUp.sub(sunPos).mul(vec2(aspect, 1));
    const glow = exp(dot(d, d).div(sunSize.mul(sunSize)).negate());
    return base.add(sunColor.mul(glow.mul(sunStrength)));
  };

  return { top, horizon, bottom, horizonHeight, sunPos, sunSize, sunColor, sunStrength, colorAt };
}

export type Sky = ReturnType<typeof createSky>;
