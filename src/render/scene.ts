import {
  ClampToEdgeWrapping,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  RenderPipeline,
  RenderTarget,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  type WebGPURenderer,
} from "three/webgpu";
import { clamp, exp, float, Fn, length, max, min, mix, renderOutput, screenUV, select, smoothstep, texture, texture3D, uniform, vec2, vec3, vec4 } from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { lut3D } from "three/examples/jsm/tsl/display/Lut3DNode.js";
import { BLOB_STRIDE, MAX_BLOBS } from "../sim/blobBuffer.ts";
import { benchFrames, createGpuSync, type BenchResult } from "./bench.ts";
import { createNoiseBaker, NOISE_SIZE } from "./cloudNoise.ts";
import { fillLut, LUT_SIZE, NEUTRAL_GRADE, sameGrade, type Grade } from "./grade.ts";
import { applyLook } from "./look.ts";
import { eyeOf, PARALLAX_DEFAULTS, REDUCED_EYE_GAIN } from "./parallax.ts";
import { createRain } from "./rain.ts";
import { createScenery } from "./scenery.ts";
import { createSceneryLight, texUV } from "./sceneryLight.ts";
import { createSky } from "./sky.ts";
import { initialTier, marchSize, TIERS, type TierName } from "./tier.ts";
import { createTileBuilder, meanBlobRadius, prepareRenderBlobs, tileGrid, type TileStats } from "./tiles.ts";
import { VIEW_HEIGHT } from "./view.ts";
import { createBlobTexture, createCloudMarch, createCloudUniforms, createTileTexture } from "./volume.ts";

/** Noise phase units per second (the clouds slowly billow); under prefers-reduced-motion it runs at REDUCED_EVOLVE of that. */
const BILLOW_RATE = 0.03;
const REDUCED_EVOLVE = 0.15;
/** How fast the blob radius used to size the billows follows the clouds' (per rendered frame): splits never make them pop. */
const RADIUS_FOLLOW = 0.1;
/** Blob radius the default billow size is authored for (the desktop layouts' mass-weighted mean). */
const REF_RADIUS = 0.45;
/** CPU budget (ms) of one slice of the 3D noise bake, and the pause (ms) between slices: about a second of wall time in all, a few ms at a time. */
const BAKE_BUDGET_MS = 5;
const BAKE_PAUSE_MS = 4;
/** When the main thread was starved since the last slice (a very slow GPU path), a slice takes up to this long, so the bake still finishes in seconds. */
const BAKE_BUDGET_MAX_MS = 50;
/** Seconds the erosion takes to fade in once the noise exists. */
const NOISE_FADE_S = 1;
/** How far (texels of the march target) the composite's 4 bilinear taps sit from the pixel: 1 = a full 3x3 tent, less = crisper. */
const UPSAMPLE_BLUR = 1;

export interface SceneOptions {
  /** Quality tier; default from the device and `?tier=` (see tier.ts). */
  tier?: TierName;
}

export interface Cursor {
  x: number;
  y: number;
}

/** What `getState().render` reports. */
export interface RenderStats {
  tier: TierName;
  /** Pixels of the cloud march target. */
  marchPixels: number;
  /** Bytes of the tile texture. */
  tileBytes: number;
  /** Bytes uploaded to the GPU per frame for the clouds: the blob texture plus the tile texture. */
  uploadBytes: number;
  /** Longest tile list before any cap, and entries cut by the caps (weakest first). */
  worstBlobsPerTile: number;
  overflowDropped: number;
  /** False while the 3D noise is still baking (the clouds are smooth ellipsoids until then). */
  noiseReady: boolean;
  /** Post chain: bloom strength and working resolution (pixels of its first target), grade intensity, and how often the LUT was rebuilt. */
  post: { bloom: number; bloomPixels: number; grade: number; lutBuilds: number };
}

export async function createScene(renderer: WebGPURenderer, opts: SceneOptions = {}) {
  let tierName: TierName = opts.tier ?? initialTier();
  let tier = TIERS[tierName];

  const sky = createSky();
  const cloud = createCloudUniforms();
  const light = createSceneryLight();
  const blobTex = createBlobTexture();
  const tileTex = createTileTexture();
  const blobData = blobTex.image.data as Float32Array;
  const tileData = tileTex.image.data as Uint8Array;
  const marchTarget = new RenderTarget(2, 2, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  const marchTex = texture(marchTarget.texture);

  // The erosion noise: allocated (zeros) now so the pipeline can compile against a 3D texture, baked across the first frames.
  const baker = createNoiseBaker(NOISE_SIZE);
  const noiseTex = new Data3DTexture(baker.data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  noiseTex.format = RGBAFormat;
  noiseTex.type = UnsignedByteType;
  noiseTex.minFilter = noiseTex.magFilter = LinearFilter;
  noiseTex.wrapS = noiseTex.wrapT = noiseTex.wrapR = RepeatWrapping;
  noiseTex.unpackAlignment = 1;
  noiseTex.needsUpdate = true;
  let noiseReady = false;
  let noiseFade = 0;

  const time = uniform(0);
  const aspect = uniform(1);
  const cursorPos = uniform(new Vector2(0, 0));
  const cursorActive = uniform(0);
  const cursorRadius = uniform(0.45);

  /** Post grade: `exposure` scales the scene colour; `flash` (0..1) and `flashX` / `flashY` (screen position of the glow, 0..1) are the lightning (M3). */
  const post = { exposure: uniform(1), flash: uniform(0), flashX: uniform(0.5), flashY: uniform(0.55) };
  /** Diagnostic view (harness `debugView`): 1 draws the play clouds' alpha as grey, 2 the clouds alone over mid grey (silhouette and parallax measurements). */
  const debugView = uniform(0);
  // Cool white-blue, a touch brighter than the sky so the lift reads as light, not as a grey wash.
  const flashTint = vec3(0.78, 0.88, 1.0);

  const march = createCloudMarch({ u: cloud, blobTex, tileTex, noiseTex, aspect, flash: post.flash, flashX: post.flashX, flashY: post.flashY });
  const scenery = createScenery();
  const lit = scenery.lit(aspect, light);
  const rain = createRain(scenery.parallax);
  const sceneryCtx = {
    aspect,
    playBody: (p: Parameters<typeof texUV>[0]) => marchTex.sample(texUV(p, aspect)).a,
    horizon: sky.horizon,
    cursorPos,
    cursorActive,
    cursorRadius,
  };

  /** Texel size of the march target, for the composite's upsample. */
  const marchTexel = uniform(new Vector2(0.001, 0.001));
  /** Edge sharpening of the upsample (tier): 0 = the plain tent, 1 = a bilinear tap (crisper), above 1 = also unsharp-masked. */
  const upsampleSharp = uniform(0);
  /**
   * The march's premultiplied colour and alpha at this pixel: 4 bilinear taps at the texel corners make a 3x3 tent, which hides the
   * march's dither. The sharpening pushes from the tent toward (and past) one plain bilinear tap, clamped to the range of the
   * four taps, so edges stay crisp without ringing or halos (the filter cannot invent a value its neighbours do not hold).
   */
  const clouds = Fn(() => {
    const o = marchTexel.mul(UPSAMPLE_BLUR * 0.5);
    const tap = (sx: number, sy: number) => marchTex.sample(screenUV.add(vec2(o.x.mul(sx), o.y.mul(sy))));
    const t0 = tap(1, 1);
    const t1 = tap(-1, 1);
    const t2 = tap(1, -1);
    const t3 = tap(-1, -1);
    const tent = t0.add(t1).add(t2).add(t3).mul(0.25);
    const centre = marchTex.sample(screenUV);
    const sharp = tent.add(centre.sub(tent).mul(upsampleSharp));
    return clamp(sharp, min(min(t0, t1), min(t2, t3)), max(max(t0, t1), max(t2, t3)));
  });

  const composite = Fn(() => {
    // screenUV follows WebGPU (y down) on both backends; the world is y-up.
    const uvUp = vec2(screenUV.x, screenUV.y.oneMinus());
    const wp = uvUp.sub(0.5).mul(vec2(aspect.mul(VIEW_HEIGHT), VIEW_HEIGHT));
    const skyColor = sky.colorAt(aspect, uvUp);
    // Back to front: sky, far bank, far rain, mid clouds, mid rain, the play clouds (the volume pass), near wisps, near rain.
    // Rain bands behind the play clouds are hidden by them; the near band is muted over them to keep them readable.
    const far = lit.far(wp, sceneryCtx);
    const behind = mix(skyColor, far.rgb, far.a);
    const rainFar = rain.far(wp, sky.horizon, float(0));
    const behindRain = mix(behind, rainFar.rgb, rainFar.a);
    const mid = lit.mid(wp, sceneryCtx);
    const behindMid = mix(behindRain, mid.rgb, mid.a);
    const rainMid = rain.mid(wp, sky.horizon, float(0));
    const behindPlay0 = mix(behindMid, rainMid.rgb, rainMid.a);
    // Lightning: a soft pool of light around the strike x (wide, centred a little above the middle), a gentle lift
    // everywhere else. The sky and scenery brighten here; the play clouds are lit from inside by the volume pass.
    const gx = uvUp.x.sub(post.flashX).mul(aspect);
    const gy = uvUp.y.sub(post.flashY);
    const pool = exp(gx.mul(gx).div(0.2).add(gy.mul(gy).div(0.35)).negate());
    const behindPlay = behindPlay0.mul(post.flash.mul(0.3).add(1)).add(flashTint.mul(post.flash.mul(pool.mul(0.3).add(0.05))));
    const c = clouds();
    const playOver = behindPlay.mul(float(1).sub(c.a)).add(c.rgb); // the march is premultiplied
    const near = lit.near(wp, sceneryCtx);
    const withNear = mix(playOver, near.rgb, near.a);
    const rainNear = rain.near(wp, sky.horizon, c.a);
    const withRain = mix(withNear, rainNear.rgb, rainNear.a);
    const withClouds = withRain.mul(post.exposure).add(flashTint.mul(post.flash.mul(0.04)));
    // Soft ring: bright band over a wider faint blue halo so it reads on both sky and cloud.
    const d = length(wp.sub(cursorPos)).sub(cursorRadius).abs();
    const band = float(1).sub(smoothstep(0, 0.06, d));
    const halo = float(1).sub(smoothstep(0, 0.16, d)).mul(0.22);
    const haloColor = mix(withClouds, vec3(0.28, 0.45, 0.72), halo.mul(cursorActive));
    const shown = mix(haloColor, vec3(1), band.mul(0.85).mul(cursorActive));
    const alphaView = vec3(c.a);
    const cloudsView = c.rgb.add(float(0.5).mul(float(1).sub(c.a)));
    return vec4(select(debugView.lessThan(0.5), shown, select(debugView.lessThan(1.5), alphaView, cloudsView)), 1);
  });

  // Post (M6): bloom on the linear frame, then the output transform (sRGB), then the grade as a 3D LUT in display space.
  // Bloom strength and grade intensity are uniforms, never toggles: 0 is "off", the passes still run, nothing recompiles.
  const bloomStrength = uniform(0);
  const bloomRadius = uniform(0.5);
  const bloomThreshold = uniform(0.9);
  // The bloom's high pass evaluates the composite itself at the bloom's resolution (a quarter of the pixels on hi and mid, a
  // sixteenth on low), in a HalfFloat target, so values above 1 (sunlit tops, the flash) survive. Measured cheaper than
  // rendering the composite once into a full-res target that both read (about 0.1 ms on every tier and scene).
  const compositeNode = composite();
  const bloomPass = bloom(compositeNode, bloomStrength, bloomRadius, bloomThreshold);
  bloomPass.smoothWidth.value = 0.15;
  const lutData = new Uint8Array(LUT_SIZE ** 3 * 4);
  const lutTex = new Data3DTexture(lutData, LUT_SIZE, LUT_SIZE, LUT_SIZE);
  lutTex.format = RGBAFormat;
  lutTex.type = UnsignedByteType;
  lutTex.minFilter = lutTex.magFilter = LinearFilter;
  lutTex.wrapS = lutTex.wrapT = lutTex.wrapR = ClampToEdgeWrapping;
  lutTex.unpackAlignment = 1;
  let grade: Grade = NEUTRAL_GRADE;
  fillLut(grade, LUT_SIZE, lutData);
  lutTex.needsUpdate = true;
  let lutBuilds = 1;
  const gradeAmount = uniform(0);
  /** The post settings as asked (`setPost`); the debug views zero them so the diagnostics see the frame ungraded. */
  const postAsked = { bloom: 0, grade: 0 };
  function applyPostGate(): void {
    const on = debugView.value === 0 ? 1 : 0;
    bloomStrength.value = postAsked.bloom * on;
    gradeAmount.value = postAsked.grade * on;
  }
  const hdr = vec4(compositeNode.rgb.add(bloomPass.rgb), 1);
  const display = clamp(renderOutput(hdr), 0, 1);
  const pipeline = new RenderPipeline(renderer, lut3D(display, texture3D(lutTex), LUT_SIZE, gradeAmount));
  // The output transform is in the node graph above (the LUT works in display space), so the pipeline must not add another.
  pipeline.outputColorTransform = false;

  // CPU side of the volume pass: the render copy of the sim's blobs and the tile lists, rebuilt when anything they depend on changes.
  const tiles = createTileBuilder();
  const zh = new Float32Array(MAX_BLOBS);
  const thickness = { cumulus: 1.15, stratus: 0.38, nimbus: 1.9 };
  const eye = { x: 0, y: 0 };
  /** Measurement hook (`setDebugEye`): null = the live parallax eye; otherwise the eye for a pointer at that side, billows frozen. */
  let debugEyeSide: number | null = null;
  let source: Float32Array = new Float32Array(MAX_BLOBS * BLOB_STRIDE);
  let sourceCount = 0;
  let grid = tileGrid(1);
  let meanRadius = REF_RADIUS;
  let lumpScale = 2.4;
  let dirty = true;
  let tileStats: TileStats = tiles.stats;
  /** Drawing-buffer size, for the bloom's pixel count in stats. */
  let drawW = 2;
  let drawH = 2;

  /** Build the render copy and the tile lists from the latest blobs, eye and thickness, and mark both textures for upload. */
  function refresh(): void {
    prepareRenderBlobs(source, sourceCount, blobData, zh, thickness);
    tileStats = tiles.build(blobData, zh, sourceCount, grid, eye, tileData);
    cloud.zMax.value = tileStats.zMax;
    blobTex.needsUpdate = true;
    tileTex.needsUpdate = true;
    dirty = false;
  }

  function applyLump(): void {
    // The billow size follows the clouds' own size, so a phone layout (smaller blobs) gets smaller lumps.
    const period = lumpScale * Math.min(1.5, Math.max(0.5, meanRadius / REF_RADIUS));
    cloud.noiseScale.value = 1 / period;
  }

  function applySize(width: number, height: number): void {
    renderer.setSize(width, height);
    aspect.value = width / height;
    const pr = renderer.getPixelRatio();
    rain.setPixelHeight(height * pr);
    drawW = Math.round(width * pr);
    drawH = Math.round(height * pr);
    scenery.bakeTarget.setSize(Math.max(2, Math.round(width * pr * tier.bake)), Math.max(2, Math.round(height * pr * tier.bake)));
    const m = marchSize(width, height, tier);
    marchTarget.setSize(m.width, m.height);
    marchTexel.value.set(1 / m.width, 1 / m.height);
    grid = tileGrid(width / height);
    cloud.cols.value = grid.cols;
    cloud.rows.value = grid.rows;
    cloud.tileSize.value = grid.size;
    dirty = true;
  }
  /** Tier: target sizes, step counts and octaves only (uniforms and target sizes), so nothing recompiles. */
  function applyTier(): void {
    cloud.steps.value = tier.steps;
    cloud.lightSteps.value = tier.lightSteps;
    cloud.octaves.value = tier.octaves;
    cloud.fine.value = tier.fine;
    cloud.aoOn.value = tier.ao;
    upsampleSharp.value = tier.sharp;
    cloud.jitterAmt.value = tier.jitter;
    light.sceneSteps.value = tier.sceneSteps;
    light.aoTaps.value = tier.aoTaps;
    bloomPass.setResolutionScale(tier.bloomScale);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
  }
  applyTier();
  applySize(window.innerWidth, window.innerHeight);

  // Warm-up: compile the march pipeline asynchronously against its real target, then run one real frame (below) so the
  // composite and the scenery bake exist before the first visible frame.
  renderer.setRenderTarget(marchTarget);
  await renderer.compileAsync(march.quad, march.quad.camera);
  renderer.setRenderTarget(null);

  const gpuSync = createGpuSync(renderer);

  const api = {
    sky,
    /** Play-cloud (volume pass) uniforms; see volume.ts. */
    cloud,
    /** Scenery lighting uniforms; see sceneryLight.ts. */
    light,
    /** Scenery parameters (uniforms): `layers.far|mid|near`, `layers.count`, `layers.grey`, ... See scenery.ts. */
    layers: scenery.layers,
    /** Rain streak uniforms and look; see rain.ts. Render-only. */
    rain,
    /** Post grade uniforms: `exposure` (1 = neutral), `flash` (0..1), `flashX` / `flashY` (0..1 screen position of the glow). */
    post,
    /** Current scenery parallax shift in world units; the volume's eye shift is derived from it. */
    parallax: scenery.parallax.value,
    /** Scale of that shift (cursor follow and idle sway; the rain bands and the volume's eye share it): 0 = flat, 1 = default. */
    setParallaxStrength(s: number): void {
      scenery.setParallaxStrength(s);
    },
    /**
     * Per rendered frame: pointer in world units (null = absent) and elapsed seconds. Moves the scenery and the volume's eye;
     * the z = 0 plane and the pointer->world mapping are unaffected.
     */
    updateScenery(pointer: Cursor | null, dt: number): void {
      scenery.update(pointer, (aspect.value * VIEW_HEIGHT) / 2, dt);
      const d = Math.min(Math.max(dt, 0), 0.25);
      if (debugEyeSide === null) cloud.billow.value += BILLOW_RATE * d * (scenery.reduced() ? REDUCED_EVOLVE : 1);
      if (noiseReady && noiseFade < 1) {
        noiseFade = Math.min(1, noiseFade + d / NOISE_FADE_S);
        cloud.noiseMix.value = noiseFade;
      }
      rain.update(dt);
      eyeOf(debugEyeSide === null ? scenery.parallax.value : { x: debugEyeSide * PARALLAX_DEFAULTS.maxCursor * VIEW_HEIGHT, y: 0 }, eye, scenery.reduced() ? REDUCED_EYE_GAIN : 1);
      cloud.eye.value.set(eye.x, eye.y);
      dirty = true;
    },
    /** The sim's blob buffer, read at the next render (the renderer works on its own copy; the buffer is never written). */
    setBlobs(buf: Float32Array, count: number): void {
      source = buf;
      sourceCount = Math.min(count, MAX_BLOBS);
      const r = meanBlobRadius(buf, sourceCount);
      if (r > 0) {
        meanRadius += (r - meanRadius) * RADIUS_FOLLOW;
        applyLump();
      }
      dirty = true;
    },
    setCursor(c: Cursor | null): void {
      if (c) {
        cursorPos.value.set(c.x, c.y);
        cursorActive.value = 1;
      } else {
        cursorActive.value = 0;
      }
    },
    /** The sim's air offset (`sim.flowState()`): the clouds' noise rides with it. */
    setAir(x: number, y: number): void {
      cloud.air.value.set(x, y);
    },
    /** Diagnostic: 1 shows the play clouds' alpha as grey, 2 the clouds alone over grey; 0 is the normal view. */
    setDebugView(mode: 0 | 1 | 2): void {
      debugView.value = mode;
      applyPostGate();
    },
    /**
     * Post (M6), from the resolved params via applyLook: bloom strength / radius / threshold, and the grade and its intensity.
     * The LUT is rebuilt only when the grade itself changes (a weather blend), never for intensity alone.
     */
    setPost(b: { strength: number; radius: number; threshold: number }, g: Grade, intensity: number): void {
      postAsked.bloom = b.strength;
      postAsked.grade = intensity;
      bloomRadius.value = b.radius;
      bloomThreshold.value = b.threshold;
      applyPostGate();
      if (!sameGrade(g, grade)) {
        grade = { ...g, shadow: [...g.shadow], highlight: [...g.highlight] };
        fillLut(grade, LUT_SIZE, lutData);
        lutTex.needsUpdate = true;
        lutBuilds++;
      }
    },
    /** Diagnostic: put the eye where a settled pointer at `side` (-1 left edge .. 0 middle .. 1 right edge) would (default Depth, no sway) and freeze the billows; null releases. */
    setDebugEye(side: number | null): void {
      debugEyeSide = side;
    },
    setTime(t: number): void {
      time.value = t;
    },
    /** z half-extent per blob radius for cumulus, stratus and cumulonimbus (`volHeight*`): the shader and the tile lists share it. */
    setThickness(cumulus: number, stratus: number, nimbus: number): void {
      thickness.cumulus = cumulus;
      thickness.stratus = stratus;
      thickness.nimbus = nimbus;
      cloud.zScale.value.set(cumulus, stratus, nimbus);
      dirty = true;
    },
    /** Billow size in world units (`volLumpScale`). */
    setLumpScale(s: number): void {
      lumpScale = s;
      applyLump();
    },
    setTier(name: TierName): void {
      tierName = name;
      tier = TIERS[name];
      applyTier();
      applySize(window.innerWidth, window.innerHeight);
    },
    getTier(): TierName {
      return tierName;
    },
    resize(width: number, height: number): void {
      applySize(width, height);
    },
    /** What the cloud pass costs and carries, for `getState().render`. */
    stats(): RenderStats {
      if (dirty) refresh();
      return {
        tier: tierName,
        marchPixels: marchTarget.width * marchTarget.height,
        tileBytes: tileData.byteLength,
        uploadBytes: blobData.byteLength + tileData.byteLength,
        worstBlobsPerTile: tileStats.worstBlobsPerTile,
        overflowDropped: tileStats.overflowDropped,
        noiseReady,
        post: {
          bloom: bloomStrength.value,
          bloomPixels: Math.floor(drawW * tier.bloomScale) * Math.floor(drawH * tier.bloomScale),
          grade: gradeAmount.value,
          lutBuilds,
        },
      };
    },
    render(): void {
      if (dirty) refresh();
      renderer.setRenderTarget(marchTarget);
      march.quad.render(renderer);
      scenery.bake(renderer);
      renderer.setRenderTarget(null);
      pipeline.render();
    },
    /** Time `frames` renders with the GPU drained after each batch (a diagnostic; reads nothing back). */
    bench(frames = 60): Promise<BenchResult> {
      return benchFrames(
        () => {
          dirty = true;
          api.render();
        },
        gpuSync,
        frames,
      );
    },
    dispose(): void {
      march.dispose();
      marchTarget.dispose();
      blobTex.dispose();
      tileTex.dispose();
      noiseTex.dispose();
      scenery.dispose();
      pipeline.dispose();
      bloomPass.dispose();
      lutTex.dispose();
    },
  };

  // Put every look uniform at the field defaults so the first frame matches a resolved "clear" P exactly.
  applyLook(api, {});
  api.render();

  // Bake the erosion noise after the first frame, in short timer slices (not tied to the frame rate, so a slow device still
  // finishes in about a second of wall time). Until it is done the erosion weight is 0.
  let lastSlice = performance.now();
  const bakeSlice = (): void => {
    const t = performance.now();
    const budget = Math.min(BAKE_BUDGET_MAX_MS, Math.max(BAKE_BUDGET_MS, (t - lastSlice) * 0.5));
    lastSlice = t;
    if (baker.step(budget)) {
      noiseReady = true;
      noiseTex.needsUpdate = true; // one upload of the finished volume
    } else {
      setTimeout(bakeSlice, BAKE_PAUSE_MS);
    }
  };
  setTimeout(bakeSlice, BAKE_PAUSE_MS);
  return api;
}

export type CloudyScene = Awaited<ReturnType<typeof createScene>>;
