# Render

Each blob is a 3D ellipsoid, raymarched through per-tile blob lists with a light march toward the sun. The CPU sim stays 2D and authoritative: the silhouette is the sim's density contour (`CLOUD_THRESHOLD`, `INFLUENCE_FACTOR`, `DENSITY_REF_RADIUS`), the mid plane is pinned to the sim's 2D density, and the baked noise only erodes it (Nubis: noise subtracts, never adds), so what you see is what you push. Everything is plain fragment TSL, identical on WebGPU and WebGL2: no compute, no storage buffers, no 3D render targets. Every tunable is a uniform and pipelines are warmed at load, so nothing compiles after the first frame.

## Passes (per frame, `scene.render()`)

1. Tile lists (CPU, `tiles.ts`, pure and tested): the renderer's own copy of the sim's blob buffer (the sim's buffer is read, never aliased), then a world-unit grid of tiles, each listing the blobs whose kernel can reach it, strongest first, packed into one small RGBA8 texture. Lists are capped; the weakest entries drop first, deterministically, and are counted (`overflowDropped`, 0 on every shipped scene). Tiles are padded for slanted eye rays by the blob's own depth offset only: an exact pad overflows the 16 KiB upload budget, and the cost is a faint fringe at a cloud's side at the widest eye shifts, never a tile-edge tear.
2. Scenery bake (low res): the three flat scenery layers' thickness, lit in the composite by `sceneryLight.ts`.
3. Cloud march (`volume.ts`, capped half-res target): per pixel, the exact z interval of the listed kernels along the slanted ray (`rayKernelChord` is its tested CPU twin), then front-to-back Beer-Lambert with a geometric sun march per sample (not jittered, so sheets do not hatch), multiple-scattering octaves, dual-lobe phase, powder, silver lining, height ambient and the strike's internal glow. The camera is an off-axis perspective whose z = 0 plane is fixed on screen, so `clientToWorld` and the pointer mapping never change; the eye follows the parallax offset through `eyeOf`, which saturates (tanh) so a cursor half way across already shows most of the depth.
4. Composite (full res): sky, far bank, far rain, mid clouds, mid rain, the march through a clamped 3x3 tent upsample (clamped to its four taps so sharpening cannot ring), near wisps, near rain, the flash lift, exposure and the cursor ring. The play clouds' alpha shadows the far and mid scenery and keeps the near wisps and rain off them. It stays linear and goes above 1 on sunlit tops.
5. Post (M6, the `RenderPipeline`'s output node): `bloom` on the linear composite, then `renderOutput` (sRGB; the pipeline's own `outputColorTransform` is off so it happens once), then `lut3D` in display space, where a grade LUT is meant to work.
   - The bloom's high pass evaluates the composite itself at the bloom's resolution instead of reading a full-res copy: the extra full-res write and read measured about 0.1 ms dearer on every tier than re-running a quarter (or a sixteenth) of the composite's pixels.
   - The threshold sits above most lit cloud faces, so only the hottest rims, silver linings and a flash glow; sunlit tops in clear weather reach about 1.9 linear, a flash-lit storm cloud only 1.0 to 1.4, so a strike lowers the threshold as well as raising the strength.
   - The grade (`grade.ts`, pure and tested) is baked on the CPU into a small RGBA8 3D texture whenever a grade field changes (a weather blend: about 0.4 ms per bake, small enough to upload every frame of a blend) and never for a strike. RGBA8 because float 3D textures only filter linearly on WebGL2 with an extension.
   - Bloom strength and grade intensity are uniforms: at 0 the passes still run, so nothing recompiles. The debug views zero both, so the look checks below see the frame ungraded.
6. Noise: a 3D Perlin-Worley / Worley texture (`cloudNoise.ts`) bakes on the CPU in short timer slices after the first frame, uploads once and fades in; until then the clouds are smooth ellipsoids. Slicing by time, not frames, means a slow device still finishes in about a second. Wait for `getState().render.noiseReady` before screenshots.

## Tiers (`TIERS`, `tier.ts`)

A tier changes only target sizes, step counts, octaves and filter strengths, never features, so switching compiles nothing and gameplay is identical. `mid` is the desktop default, `low` a small coarse-pointer screen, `?tier=` or `setTier` overrides. The march target is a scale of the CSS viewport, not the drawing buffer: the clouds are soft, so a phone's DPR buys nothing there. Low differs in kind for a reason: its march target is a larger scale (so a phone gets enough pixels; its pixel cap keeps desktop cheap), its upsample is sharpened because its few pixels would otherwise read as blur, and it drops the march's start jitter because the sharper filter would show the dither as diagonal hatching.

## Cost

GPU ms per frame, measured 2026-11-02 with `__GAME__.bench` (queue drained per batch of 6, median of 5 runs of 60 frames), 1280x800, DPR 1, Sky panel open, GTX 1660 Ti through WSLg (WebGPU on the OpenGL ES backend; WebGL2 headed). Rain scenes at rain 0.7 and 0.9, clear at 0. Clocks on this machine drift by up to 25 percent between sessions, so compare builds back to back in one session, never against this table.

| Scene | WebGPU hi / mid / low | WebGL2 hi / mid / low |
| --- | --- | --- |
| thunder (two towers, rain 0.9) | 12.8 / 7.1 / 4.2 | 12.3 / 7.1 / 4.1 |
| rain (rain 0.7) | 8.8 / 5.6 / 3.7 | 8.4 / 5.2 / 3.5 |
| mixed (clear) | 9.8 / 5.9 / 3.8 | 9.7 / 5.8 / 3.6 |

Budgets at this size: hi 15 ms, mid 8, low 4.5. Post costs 0.35 to 0.55 ms of that on every cell. Low has the least room (thunder at 4.1 to 4.2), with bloom already at a sixteenth of its pixels. The composite, scenery bake and rain are about 2 to 3 ms whatever the tier; the march is the rest. Phone GPUs are unmeasured.

## Pacing (`pacing.ts`)

The loop renders every `renderEvery(hz)`-th display refresh: every refresh up to the first whole multiple of `TARGET_HZ`, then the refresh divided evenly, so frames are always evenly spaced and a 120 Hz screen does not do twice the work for little gain. It replaced a fixed 60 Hz time cap, which on any screen between about 68 and 120 Hz skipped every other refresh (a 90 Hz phone rendered 45 fps). The cost is that 75 and 90 Hz screens now render more than 60 frames a second; the governor, not the pacer, is what should answer a GPU that cannot keep up. The refresh is the median of recent callback intervals, so a stall or a hidden tab does not move it, and a GPU that falls behind slows the callbacks themselves, which drops the divisor to 1. The sim is unaffected: it runs on its own fixed step.

## Frame stats on a device (`?stats`, `frameStats.ts`)

`__GAME__.bench` measures GPU cost on a desk; a real phone is read with `?stats`, a readout in the top-right corner (also `getState().stats`). It times the frames that are actually rendered, not rAF callbacks: on a fast screen the loop skips some callbacks (pacing, below). The display's own rate (median rAF interval) is shown beside it, so a frame rate divided down on purpose reads differently from a slow GPU. The percentiles cover the last `STATS_WINDOW_MS`, PLAN's p95 target window, so wait that long after load before reading them: the first seconds include shader warm-up and the noise bake. A hidden tab or a `bench` run breaks the interval rather than counting as one slow frame. It reads no GPU timer (nothing is read back), so it cannot split CPU from GPU time; `cpu p95` is only the main thread's share.

## Look checks (how the volumes were judged)

All through the harness (`debugView`, `debugEye`, `densityAt`), 1280x800, WebGPU on the real GPU, Sky panel folded.

- Silhouette versus the sim: IoU of cloud alpha above 0.5 against `densityAt >= cloudThreshold` on a 320x200 grid. About 0.89 to 0.95 across the shipped scenes at default settings; Puffiness at its ends moves it to about 0.86 to 0.94.
- Parallax: mean per-channel difference over cloud pixels between frames with the eye at a settled pointer far left and far right, billows frozen, clouds alone over grey. About 24 (sunny) and 40 (storm) at the edges. The metric saturates once features decorrelate.
- Tile-list fringe: a few percent of cloud pixels lose more than a tenth of their z interval at the widest eye shifts, all on the faint outer side of a cloud; no tile-edge tear shows.

## Not built

A stylized preset (banded light, warm tint, rim) would fit the same pass and was dropped. Still weak: stratus sheets are short lenses; storm towers are grey lumps by design (the sky is darker than the clouds); the low tier's silhouettes stay soft whatever the filter.

## Credits

Schneider, Horizon Zero Dawn (SIGGRAPH 2015) and Nubis (2017, 2022): envelope density, erode-only noise, Perlin-Worley. Wrenninge, Kulla, Lundqvist, "Oz: the great and volumetric" (2013): multiple-scattering octaves. Hillaire, Frostbite (2016): energy-conserving integration, dual-lobe phase. three.js `webgpu_volume_cloud` (MIT): the `texture3D` and `Loop`/`Break` pattern; three.js `BloomNode` and `Lut3DNode` (MIT) for post. `simplex-noise` (MIT). All formulas reimplemented from the papers; no Shadertoy code.
