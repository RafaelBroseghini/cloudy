import { RenderPipeline, Vector2, type WebGPURenderer } from "three/webgpu";
import { float, Fn, length, mix, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from "three/tsl";
import { BLOB_STRIDE, MAX_BLOBS } from "../sim/blobBuffer.ts";
import { createCloudLook, createFieldTarget, createSplatPass, sampleFieldDensity, shadeClouds } from "./cloudField.ts";
import { applyLook } from "./look.ts";
import { createScenery } from "./scenery.ts";
import { createSky } from "./sky.ts";
import { createViewCamera, fitViewCamera, VIEW_HEIGHT } from "./view.ts";

export interface SceneOptions {
  /** Field resolution relative to the drawing buffer. 0.5 = half-res. */
  fieldScale?: number;
}

export interface Cursor {
  x: number;
  y: number;
}

export async function createScene(renderer: WebGPURenderer, opts: SceneOptions = {}) {
  let fieldScale = opts.fieldScale ?? 0.5;

  const camera = createViewCamera();
  const splat = createSplatPass();
  const target = createFieldTarget();
  const sky = createSky();
  const look = createCloudLook();

  const time = uniform(0);
  const aspect = uniform(1);
  const cursorPos = uniform(new Vector2(0, 0));
  const cursorActive = uniform(0);
  const cursorRadius = uniform(0.45);

  /** Post grade: `exposure` scales the scene colour, `flash` blends toward white (lightning, M3). */
  const post = { exposure: uniform(1), flash: uniform(0) };

  const clouds = shadeClouds(target.texture, look, time, aspect);
  const scenery = createScenery();
  const sceneryCtx = {
    aspect,
    fieldDensity: sampleFieldDensity(target.texture, aspect),
    playThreshold: look.threshold,
    horizon: sky.horizon,
    cursorPos,
    cursorActive,
    cursorRadius,
  };

  const composite = Fn(() => {
    // screenUV follows WebGPU (y down) on both backends; the world is y-up.
    const uvUp = vec2(screenUV.x, screenUV.y.oneMinus());
    const wp = uvUp.sub(0.5).mul(vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT));
    const skyColor = sky.colorAt(aspect, uvUp);
    // Back to front: sky, far bank, mid clouds, the play layer (never shifted), near wisps.
    const far = scenery.far(wp, sceneryCtx);
    const behind = mix(skyColor, far.rgb, far.a);
    const mid = scenery.mid(wp, sceneryCtx);
    const behindPlay = mix(behind, mid.rgb, mid.a);
    const c = clouds(wp);
    const playOver = mix(behindPlay, c.rgb, c.a);
    const near = scenery.near(wp, sceneryCtx);
    const withClouds = mix(mix(playOver, near.rgb, near.a).mul(post.exposure), vec3(1), post.flash.mul(0.75));
    
    // Soft ring: bright band over a wider faint blue halo so it reads on both sky and cloud.
    const d = length(wp.sub(cursorPos)).sub(cursorRadius).abs();
    const band = float(1).sub(smoothstep(0, 0.06, d));
    const halo = float(1).sub(smoothstep(0, 0.16, d)).mul(0.22);
    const haloColor = mix(withClouds, vec3(0.28, 0.45, 0.72), halo.mul(cursorActive));
    return vec4(mix(haloColor, vec3(1), band.mul(0.85).mul(cursorActive)), 1);
  });

  const pipeline = new RenderPipeline(renderer, composite());

  function applySize(width: number, height: number): void {
    renderer.setSize(width, height);
    aspect.value = width / height;
    fitViewCamera(camera, width / height);
    const pr = renderer.getPixelRatio();
    target.setSize(
      Math.max(2, Math.round(width * pr * fieldScale)),
      Math.max(2, Math.round(height * pr * fieldScale)),
    );
  }
  applySize(window.innerWidth, window.innerHeight);

  // Warm-up: compile the splat pipeline asynchronously, then run one real frame so the composite
  // pipeline exists before the first visible frame.
  splat.setBlobs(new Float32Array(MAX_BLOBS * BLOB_STRIDE), 1);
  await renderer.compileAsync(splat.scene, camera);

  const api = {
    sky,
    look,
    /** Scenery parameters (uniforms): `layers.far|mid|near`, `layers.count`, `layers.grey`, ... See scenery.ts. */
    layers: scenery.layers,
    /** Post grade uniforms: `exposure` (1 = neutral), `flash` (0..1). */
    post,
    /** Current scenery parallax shift in world units (the play layer ignores it). */
    parallax: scenery.parallax.value,
    /**
     * Per rendered frame: pointer in world units (null = absent) and elapsed seconds. Moves only scenery;
     * the play layer and pointer->world mapping are unaffected.
     */
    updateScenery(pointer: Cursor | null, dt: number): void {
      scenery.update(pointer, (aspect.value * VIEW_HEIGHT) / 2, dt);
    },
    setBlobs(buf: Float32Array, count: number): void {
      splat.setBlobs(buf, count);
    },
    setCursor(c: Cursor | null): void {
      if (c) {
        cursorPos.value.set(c.x, c.y);
        cursorActive.value = 1;
      } else {
        cursorActive.value = 0;
      }
    },
    setTime(t: number): void {
      time.value = t;
    },
    setFieldScale(s: number): void {
      fieldScale = s;
      applySize(window.innerWidth, window.innerHeight);
    },
    getFieldScale(): number {
      return fieldScale;
    },
    resize(width: number, height: number): void {
      applySize(width, height);
    },
    render(): void {
      renderer.setRenderTarget(target);
      renderer.render(splat.scene, camera);
      renderer.setRenderTarget(null);
      pipeline.render();
    },
    dispose(): void {
      splat.dispose();
      target.dispose();
      pipeline.dispose();
    },
  };

  // Put every look uniform at the field defaults so the first frame matches a resolved "clear" P exactly.
  applyLook(api, {});
  api.render();
  splat.setBlobs(new Float32Array(MAX_BLOBS * BLOB_STRIDE), 0);
  return api;
}

export type CloudyScene = Awaited<ReturnType<typeof createScene>>;
