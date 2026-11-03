# Render: play clouds as real volumes

Each blob is a 3D ellipsoid, raymarched through per-tile blob lists with a light march toward the sun. The CPU sim stays 2D and authoritative: the silhouette is the sim's density contour (`CLOUD_THRESHOLD`, `INFLUENCE_FACTOR`, `DENSITY_REF_RADIUS`), the mid plane is pinned to the sim's 2D density, and the baked noise only erodes it (Nubis: noise subtracts, never adds). Same plain fragment TSL on WebGPU and WebGL2 (no compute, no storage buffers, no 3D render targets); every tunable is a uniform, pipelines are warmed at load.

## Data flow (per frame, `scene.render()`)

1. CPU (`tiles.ts`, pure): the RENDER COPY of the sim's blob buffer (the sim's buffer is only read, never aliased). Layout in `src/sim/blobBuffer.ts`: same 12 floats, slots 4/5 = cloud base/top y, slot 11 = per-slot z offset (integer hash of the slot, so it is stable). z half-extent = `r * INFLUENCE_FACTOR * volHeight*` (cumulus 0.95, stratus 0.38, nimbus 1.7). Then the tile lists: a world-unit grid (about 0.5 units, at most 340 tiles, 23x14 at 1280x800), each tile listing the blobs whose cut-off kernel (q < 0.9), padded for slanted eye rays, can reach it, strongest first. One 32x32 RGBA8 texture (CSR: per-tile offset, count, z range, then a byte pool, 255 = empty marker). Lists are capped (`MAX_TILE_LIST` 48, real worst case about 32, plus the pool's capacity); the weakest entries drop first, deterministically, and are counted.
2. Scenery bake (quarter res): the three scenery layers' thickness (unchanged), lit in the composite by the frozen 2.5D terms in `sceneryLight.ts`.
3. March (`volume.ts`) into a capped half-res RGBA16F target (premultiplied colour, alpha): per pixel, the z interval from the listed chords, then front-to-back Beer-Lambert (Hillaire energy-conserving), per sample a geometric sun march (not jittered, so sheets do not hatch), Wrenninge multiple-scattering octaves with dual-lobe Henyey-Greenstein, powder, silver lining, ambient by height in the cloud, the strike's internal glow. Camera: off-axis perspective, 30 deg FOV, eye at distance 18.66; the z = 0 plane is fixed on screen, so `clientToWorld` and the pointer mapping are unchanged. The eye follows the parallax module's offset (cursor, idle sway, Depth slider, reduced motion) times 12, clamped to +-8.
4. Composite (full res): sky, far bank, far rain, mid clouds, mid rain, the march through a 3x3 tent upsample, near wisps, near rain, post. The play clouds' alpha (bilinear) shadows the far and mid scenery and keeps the near wisps and near rain off them.
5. Noise: a 48^3 Perlin-Worley / Worley texture (`cloudNoise.ts`, `simplex-noise` for the Perlin channel) bakes ~0.5 s of CPU in 5 ms timer slices right after the first frame (about a second of wall time, whatever the frame rate), then uploads once and fades in; until then erosion is 0 (smooth ellipsoids). `getState().render.noiseReady` says when.

Upload per frame: blob texture 254 x 48 B = 12,192 B + tile texture 4,096 B = 16,288 B, at most 16 KiB. `getState().render`: `{ tier, marchPixels, tileBytes, uploadBytes, worstBlobsPerTile, overflowDropped, noiseReady }`.

## Tiers (`tier.ts`)

Only target sizes, step counts and octaves change; nothing recompiles. Default `mid` on desktop, `low` when `(pointer: coarse)` and width <= 860, `?tier=hi|mid|low`, `setTier`. The march target is a scale of the CSS viewport (DPR-independent), capped in pixels.

| Tier | Target | Cap | View / sun steps | Octaves | Fine noise, AO | Pixel ratio cap | Scenery steps, AO taps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hi | 0.5 | 0.75 MP | 32 / 8 | 8 | yes, yes | 2 | 5, 8 |
| mid | 0.5 | 0.5 MP | 16 / 5 | 4 | yes, yes | 1.5 | 4, 6 |
| low | 0.5 | 0.15 MP | 12 / 4 | 2 | no, no | 1 | 3, 4 |

## Measured cost

GPU ms per frame (`__GAME__.bench`, queue drained per batch of 6, median of 5 runs), 1280x800, DPR 1, Sky panel open, real GPU (GTX 1660 Ti through WSLg; WebGPU on the OpenGL ES backend, WebGL2 headed), quiet machine. Rain scenes run at rain 0.7 and 0.9, clear at 0. The old 2.5D renderer cost 1.8 to 2.5 (WebGPU) and 3.1 to 3.4 (WebGL2) in the same harness.

| Scene | Backend | hi | mid | low |
| --- | --- | --- | --- | --- |
| thunder (rain 0.9, two towers) | WebGPU / WebGL2 | 13.4 / 13.2 | 6.6 / 6.2 | 3.8 / 3.5 |
| rain (rain 0.7) | WebGPU / WebGL2 | 10.3 / 10.0 | 5.4 / 5.1 | 3.0 / 3.1 |
| mixed (clear) | WebGPU / WebGL2 | 11.8 / 11.3 | 5.9 / 5.6 | 3.3 / 3.1 |

The composite, scenery bake and rain are about 2 to 3 ms whatever the tier; the march is the rest. Mid is the spike's 20 / 6 / 4 trimmed to 16 / 5 / 4 (the spike's mid was 7.4 ms on thunder here). Phones are untested.

## Not built

A stylized preset (banded light, warm tint, rim) is possible on the same pass (the spike had one) and was dropped. Storm towers and stratus are the weakest: towers read as soft grey lumps without crisp cauliflower edges; sheets are thin, smooth ellipsoids with little streaking.

## Credits

Schneider, Horizon Zero Dawn (SIGGRAPH 2015) and Nubis (2017, 2022): envelope density, erode-only noise, Perlin-Worley. Wrenninge, Kulla, Lundqvist, "Oz: the great and volumetric" (2013): multiple-scattering octaves. Hillaire, Frostbite (2016): energy-conserving integration, dual-lobe phase. three.js `webgpu_volume_cloud` (MIT): the `texture3D` and `Loop`/`Break` pattern. `simplex-noise` (MIT). All formulas reimplemented from the papers; no Shadertoy code.
