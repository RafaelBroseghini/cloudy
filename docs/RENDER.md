# Render: play clouds as real volumes

Each blob is a 3D ellipsoid, raymarched through per-tile blob lists with a light march toward the sun. The CPU sim stays 2D and authoritative: the silhouette is the sim's density contour (`CLOUD_THRESHOLD`, `INFLUENCE_FACTOR`, `DENSITY_REF_RADIUS`), the mid plane is pinned to the sim's 2D density, and the baked noise only erodes it (Nubis: noise subtracts, never adds). Same plain fragment TSL on WebGPU and WebGL2 (no compute, no storage buffers, no 3D render targets); every tunable is a uniform, pipelines are warmed at load.

## Data flow (per frame, `scene.render()`)

1. CPU (`tiles.ts`, pure): the RENDER COPY of the sim's blob buffer (the sim's buffer is only read, never aliased). Layout in `src/sim/blobBuffer.ts`: same 12 floats, slots 4/5 = cloud base/top y, slot 11 = per-slot z offset (integer hash of the slot, so it is stable). z half-extent = `r * INFLUENCE_FACTOR * volHeight*` (cumulus 1.15, stratus 0.38, nimbus 1.9), centred on a per-slot offset of up to +-0.45 of it (`ZOFF_AMP`). Then the tile lists: a world-unit grid (at most 260 tiles, so about 0.8 units, 20x13 at 1280x800), each tile listing the blobs whose cut-off kernel (q < 0.9), padded for slanted eye rays (by the blob's own depth offset only: a ray that meets a kernel far from its centre depth can be missed by a pixel's list, which costs a faint fringe at a cloud's side at the largest eye shifts, never a tile-edge tear; an exact pad would overflow the 16 KiB pool), can reach it, strongest first. One 32x32 RGBA8 texture (CSR: per-tile offset, count, z range, then a byte pool, 255 = empty marker). Lists are capped (`MAX_TILE_LIST` 48, real worst case about 41, plus the pool's capacity of about 2,800 entries, 2,450 used by the thunder scene at the widest eye); the weakest entries drop first, deterministically, and are counted.
2. Scenery bake (quarter res): the three scenery layers' thickness (unchanged), lit in the composite by the frozen 2.5D terms in `sceneryLight.ts`.
3. March (`volume.ts`) into a capped half-res RGBA16F target (premultiplied colour, alpha): per pixel, the z interval from the listed chords, then front-to-back Beer-Lambert (Hillaire energy-conserving), per sample a geometric sun march (not jittered, so sheets do not hatch), Wrenninge multiple-scattering octaves with dual-lobe Henyey-Greenstein, powder, silver lining, ambient by height in the cloud, the strike's internal glow. The view march starts from the exact z interval of the listed kernels along the pixel's slanted ray (a quadratic per blob, `rayKernelChord` in `tiles.ts` is its tested twin), so it is tight at any eye. Camera: off-axis perspective, 36 deg FOV (was 30), eye at distance 15.39 (was 18.66); the z = 0 plane is fixed on screen, so `clientToWorld` and the pointer mapping are unchanged. The eye follows the parallax module's offset (cursor, idle sway, Depth slider, reduced motion) through `EYE_MAX * tanh(24 * shift / EYE_MAX)` (`eyeOf`): about 24 world units of eye per unit of shift near the middle of the screen (was a linear 12), flattening toward +-10 (was +-8) at the edges, so a cursor half way across already moves the eye 60% of the way to its maximum. Each cloud is also deeper (cumulus 1.15 radii thick, up from 0.95) and its lumps lie at more varied depths, which is what the eye shift reveals.
4. Composite (full res): sky, far bank, far rain, mid clouds, mid rain, the march through a 3x3 tent upsample (the low tier pushes it toward one bilinear tap and past it, clamped to the four taps' range so it cannot ring: `Tier.sharp`; the low tier also drops the march's start jitter, `Tier.jitter`, because the sharper filter would show the dither as diagonal hatching), near wisps, near rain, post. The play clouds' alpha (bilinear) shadows the far and mid scenery and keeps the near wisps and near rain off them.
5. Noise: a 48^3 Perlin-Worley / Worley texture (`cloudNoise.ts`, `simplex-noise` for the Perlin channel) bakes ~0.5 s of CPU in 5 ms timer slices right after the first frame (about a second of wall time, whatever the frame rate), then uploads once and fades in; until then erosion is 0 (smooth ellipsoids). `getState().render.noiseReady` says when.

Upload per frame: blob texture 254 x 48 B = 12,192 B + tile texture 4,096 B = 16,288 B, at most 16 KiB. `getState().render`: `{ tier, marchPixels, tileBytes, uploadBytes, worstBlobsPerTile, overflowDropped, noiseReady }`.

## Tiers (`tier.ts`)

Only target sizes, step counts and octaves change; nothing recompiles. Default `mid` on desktop, `low` when `(pointer: coarse)` and width <= 860, `?tier=hi|mid|low`, `setTier`. The march target is a scale of the CSS viewport (DPR-independent), capped in pixels.

| Tier | Target | Cap | View / sun steps | Octaves | Fine noise, AO | Upsample sharpen, start jitter | Pixel ratio cap | Scenery steps, AO taps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hi | 0.5 | 0.75 MP | 28 / 6 | 8 | yes, yes | 0, full | 2 | 5, 8 |
| mid | 0.5 | 0.5 MP | 16 / 4 | 4 | yes, yes | 0, full | 1.5 | 4, 6 |
| low | 0.6 | 0.15 MP | 12 / 4 | 2 | yes, no | 1.5, none | 1.5 | 3, 4 |

Low on a phone (390x844 at any DPR): the march target is 234x506 (was 195x422, 118 thousand pixels, under the 150 thousand cap), the fine octave is on (it is what gives the silhouette its cauliflower edge at that size), the upsample is sharpened (edge-preserving: clamped to the four taps), and the drawing buffer is 1.5x the CSS size (585x1266, 0.74 MP, cheaper than a 1280x800 window at mid's 1.5 ratio, which is 1.9 MP) where it was 1x and then stretched by the browser 3x on a DPR 3 phone. At desktop sizes the 0.15 MP cap binds, so low is as cheap as it was. A phone GPU is not measured: the 1.5x ratio costs composite time there that a DPR-1 desktop bench does not show.

## Measured cost

GPU ms per frame (`__GAME__.bench`, queue drained per batch of 6, median of 5 runs), 1280x800, DPR 1, Sky panel open, real GPU (GTX 1660 Ti through WSLg; WebGPU on the OpenGL ES backend, WebGL2 headed). Rain scenes run at rain 0.7 and 0.9, clear at 0. The old 2.5D renderer cost 1.8 to 2.5 (WebGPU) and 3.1 to 3.4 (WebGL2) in the same harness.

This machine's GPU clocks drift by up to 25 percent between sessions (the volume port's code read 6.6 ms on thunder mid at the start of the polish and 8.8 ms two hours later), so each number below is the volume port's documented figure times the new/old ratio of back-to-back runs of both builds in one session (WebGPU: all nine cells; WebGL2: thunder at all tiers and rain and mixed at mid, the rest assumed to follow the WebGPU ratio, marked ~). Raw medians of the session, old / new, in brackets.

| Scene | Backend | hi | mid | low |
| --- | --- | --- | --- | --- |
| thunder (rain 0.9, two towers) | WebGPU / WebGL2 | 12.0 / 11.8 (16.0 / 14.3, 16.1 / 14.4) | 6.9 / 6.2 (8.8 / 9.2, 9.4 / 9.2) | 3.8 / 3.6 (5.5 / 5.5, 5.95 / 6.2) |
| rain (rain 0.7) | WebGPU / WebGL2 | 8.5 / ~8.3 (12.9 / 10.7) | 5.3 / 4.8 (7.2 / 7.0, 8.9 / 7.7) | 3.1 / ~3.2 (4.7 / 4.9) |
| mixed (clear) | WebGPU / WebGL2 | 9.4 / ~9.0 (14.2 / 11.4) | 5.6 / 5.3 (7.6 / 7.2, 8.3 / 7.9) | 3.3 / ~3.1 (5.4 / 5.5) |

Budgets (mid at most about 8 ms, hi 15, low 4.5 at this size) hold on both backends. Thunder is the heaviest scene: more blobs (167 against 145), deeper clouds and a wider eye shift put more samples inside clouds, which hi pays for with 28 / 6 steps (was 32 / 8) and mid with 16 / 4 (was 16 / 5, the spike's was 20 / 6 / 4); low is unchanged in steps and gained the fine octave and the sharper upsample for about 5 percent. The composite, scenery bake and rain are about 2 to 3 ms whatever the tier; the march is the rest. Phones are untested.

## Look checks (how the polish was measured)

All through `window.__GAME__` (`debugView`, `debugEye`, `densityAt`; see `docs/HARNESS.md`), 1280x800, WebGPU on the real GPU, Sky panel folded, the folded pill masked out.

- Silhouette versus the sim: IoU of the clouds' alpha above 0.5 against the sim's `densityAt >= cloudThreshold` on a 320x200 grid, eye at the middle. Default settings: sunny 0.921, lone 0.948, sunset 0.922, dusk 0.922, rainy 0.893, storm 0.901, mixed 0.916 (the volume port measured sunny 0.937, lone 0.949, rainy 0.927, storm 0.915); alpha outside the sim region is 0.7 to 4.3 percent of the alpha area. At the Puffiness extremes: 0 gives sunny 0.944 and storm 0.881 (the lumps bulge a little: alpha 4 to 7 percent over the sim area), 1 gives sunny 0.855 and storm 0.868 (deeply carved, 9 to 11 percent under).
- Parallax: mean absolute per-channel difference (of 255) over the cloud pixels (alpha above 0.3) of one frame with the eye where a settled pointer at the far left screen edge would put it and one far right, billows frozen, clouds alone over grey. Pointer at the edge / half way / a quarter of the way: sunny 15.3 / 8.7 / 4.7 before, 23.8 / 19.6 / 13.1 now (1.6x, 2.3x, 2.8x); storm 23.5 / 15.2 / 8.5 before, 39.9 / 34.2 / 25.9 now (1.7x, 2.3x, 3.0x, partly the storm's new shapes and contrast). The metric saturates once features decorrelate, so the edge gain is the smallest; the geometric disparity between the front and back of a cumulus at the edge went from about 1.5 to 2.8 world units (80 px per unit at 1280x800). Plain composites differ by 20 to 35 on the same pairs. The earlier "about 1/255" came from a pair taken before the smoothed pointer had settled.
- Tile-list fringe: with the lists padded by the blob's own depth offset only, 0.0 to 3.3 percent of cloud pixels at 1280x800 (up to 6.0 in the thunder scene at 844x390) lose more than a tenth of their z interval against all blobs, at eye shifts of +-8.9 and +-6; 0.8 percent of the thunder scene's interval length overall (1.6 at 844x390), 0.0 to 0.3 for every other scene. They sit on the outer fringe of a cloud's side (low kernel weight) and are only slightly over-represented near tile edges (52 versus 44 percent of pixels), so no tile-edge tear shows in the L/R pairs. An exact pad overflows the 16 KiB pool.

## Not built

A stylized preset (banded light, warm tint, rim) is possible on the same pass (the spike had one) and was dropped. Still weak: stratus sheets are short lenses (their composition boxes are thin), so the banding reads as layers but they stay small; towers are lit as grey lumps in storm weather by design (the sky is darker than the clouds); the low tier's march is a third of the screen's pixels, so silhouettes there stay soft whatever the filter.

## Credits

Schneider, Horizon Zero Dawn (SIGGRAPH 2015) and Nubis (2017, 2022): envelope density, erode-only noise, Perlin-Worley. Wrenninge, Kulla, Lundqvist, "Oz: the great and volumetric" (2013): multiple-scattering octaves. Hillaire, Frostbite (2016): energy-conserving integration, dual-lobe phase. three.js `webgpu_volume_cloud` (MIT): the `texture3D` and `Loop`/`Break` pattern. `simplex-noise` (MIT). All formulas reimplemented from the papers; no Shadertoy code.
