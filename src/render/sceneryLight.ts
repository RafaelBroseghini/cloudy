// Lighting of the scenery layers (far bank, mid clouds, near wisps): thin slabs whose thickness is baked at quarter
// resolution (scenery.ts) and lit by marching toward the sun through that thickness map, with a wrapped diffuse, Beer's law,
// Hillaire-style multiple-scattering octaves and a ring AO. This is the old 2.5D lighting that the play clouds used to share;
// the play clouds are now real volumes (volume.ts), so these terms are frozen here and the `vol*` fields no longer reach them.
// Only the sun (from the sky), the shadow contrast (`lightGain`) and the tier's step counts are live uniforms.

import { Vector2, Vector3, type Node } from "three/webgpu";
import { abs, clamp, cos, dot, exp, float, fract, int, Loop, max, mix, normalize, pow, screenCoordinate, sin, smoothstep, uniform, vec2, vec3 } from "three/tsl";
import { VIEW_HEIGHT } from "./view.ts";

export const extentOf = (aspect: Node<"float">) => vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT);
/** World position to the sample uv of a render target (y-down on both backends). */
export const texUV = (p: Node<"vec2">, aspect: Node<"float">) => p.div(extentOf(aspect)).add(0.5).flipY();

/** What the scenery's lighting reads. The constants are the old play-layer defaults the scenery was tuned with. */
export function createSceneryLight() {
  return {
    /** Unit vector toward the sun (x right, y up, z toward the viewer). */
    sun: uniform(new Vector3(0.63, 0.67, 0.39)),
    /** Unit 2D direction toward the sun in the view plane (the clouds' shadows on the scenery fall away from it). */
    sunDir: uniform(new Vector2(0.7, 0.7)),
    /** Shadow contrast: P.lightGain * 0.8. */
    contrast: uniform(2.08),
    marchLen: uniform(2.4),
    sigma: uniform(1.5),
    nk: uniform(3),
    wrap: uniform(0.55),
    gFwd: uniform(0.62),
    gBack: uniform(-0.25),
    wFwd: uniform(0.35),
    ms: uniform(0.6),
    aoK: uniform(0.7),
    /** Normal sampling step in world units: wide enough that fine detail does not crumple the shading. */
    eStep: uniform(0.16),
    aoR: uniform(0.4),
    // tier
    aoTaps: uniform(8, "int"),
    sceneSteps: uniform(5, "int"),
  };
}

export type SceneryLight = ReturnType<typeof createSceneryLight>;

/** Per-pixel white noise: hides the march's banding. (Interleaved gradient noise draws diagonal hatching at 4 steps.) */
export const ign = () => fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));

/**
 * Lighting terms from a thickness map, for the scenery layers.
 * `Hat(p)` is the half thickness at world p: viewed down -z, the slab at p occupies |z| < H(p).
 * Returns the surface normal, the optical depth to the sun, ambient occlusion, a light term and a wrapped diffuse.
 */
export function litTerms(o: {
  Hat: (p: Node<"vec2">) => Node<"float">;
  wp: Node<"vec2">;
  h: Node<"float">;
  vol: SceneryLight;
  steps: Node<"int">;
  aoTaps: Node<"int"> | null;
  jitter: Node<"float">;
}) {
  const { Hat, wp, h, vol, steps, jitter } = o;
  const e = vol.eStep;
  const gx = Hat(wp.add(vec2(e, 0))).sub(Hat(wp.sub(vec2(e, 0)))).div(e.mul(2));
  const gy = Hat(wp.add(vec2(0, e))).sub(Hat(wp.sub(vec2(0, e)))).div(e.mul(2));
  const n = normalize(vec3(gx.negate().mul(vol.nk), gy.negate().mul(vol.nk), 1));
  const L = vol.sun;
  const wd = clamp(dot(n, L).add(vol.wrap).div(vol.wrap.add(1)), 0, 1);

  // Beer's law marched through the same thickness map toward the sun (quadratic spacing: fine near the surface).
  const tau = float(0).toVar();
  const total = float(steps);
  Loop({ start: int(0), end: steps, type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
    const t0 = float(i).add(jitter.mul(0.6).add(0.2)).div(total); // partial jitter: enough to hide banding, little enough that few steps do not hatch
    const s = t0.mul(t0).mul(vol.marchLen);
    const ds = t0.mul(2).div(total).mul(vol.marchLen);
    const pk = vec3(wp, h).add(L.mul(s));
    const hk = Hat(pk.xy);
    const occ = smoothstep(float(-0.04), float(0.16), hk.sub(abs(pk.z)));
    tau.addAssign(occ.mul(ds).mul(vol.sigma));
  });

  // Hillaire-style multiple scattering octaves with a dual-lobe Henyey-Greenstein phase.
  const cosT = L.z.negate(); // orthographic view along -z
  const hg = (g: Node<"float">) => float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(cosT).mul(2)), 1.5));
  let lt: Node<"float"> = float(0);
  let lt0: Node<"float"> = float(0);
  for (let oct = 0; oct < 3; oct++) {
    const a = vol.ms.pow(oct); // extinction and weight of this octave
    const phase = mix(hg(vol.gBack.mul(a)), hg(vol.gFwd.mul(a)), vol.wFwd);
    lt = lt.add(exp(tau.mul(a).negate()).mul(a).mul(phase));
    lt0 = lt0.add(phase.mul(a));
  }
  // Normalised so an unshadowed surface is 1 whatever the sun angle; `contrast` stretches the shadowed range.
  lt = clamp(float(1).sub(float(1).sub(lt.div(lt0)).mul(vol.contrast)), 0, 2);

  // AO from a ring of blurred thickness: surfaces in a pit between taller lumps are occluded.
  let ao: Node<"float"> = float(1);
  if (o.aoTaps) {
    const hb = float(0).toVar();
    const taps = o.aoTaps;
    Loop({ start: int(0), end: taps, type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
      const a = float(i).add(jitter).mul(Math.PI * 2).div(float(taps));
      hb.addAssign(Hat(wp.add(vec2(cos(a), sin(a)).mul(vol.aoR))));
    });
    const mean = hb.div(float(taps));
    ao = float(1).sub(vol.aoK.mul(clamp(mean.sub(h).div(max(mean, 0.12)), 0, 1)));
  }
  return { n, tau, ao, lt, wd };
}
