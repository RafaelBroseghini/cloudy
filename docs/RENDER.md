# Render: play clouds as 2.5D volumes

Every cloud is a slab: per pixel the renderer knows a half-thickness `H(x, y)` and lights it by marching toward the sun through that thickness map. No per-blob 3D raymarch. The silhouette is still the sim's density contour (`CLOUD_THRESHOLD`, `INFLUENCE_FACTOR`), so what you see is what the sim pushes. Same shaders on WebGPU and WebGL2; everything at runtime is a uniform, pipelines are warmed at load.

## Passes (per frame, `scene.render()`)

1. Density splat (`cloudField.ts`): one instanced quad per blob, additive, field RT. R density, G stratus part, B nimbus part, A height in cloud. Unchanged contract; the blob upload is still the 12 KB sim buffer (plus 1 KB of cloud heights).
2. Height splat (`volume.ts`): the same instanced geometry (no second upload), second RT. R = sum of `(h / 0.35)^8`, `h = type thickness * radius * hemisphere profile`. `H = A^(1/8)` is a soft max: exact for one blob, smooth where blobs overlap. Stored normalised so stratus stays above half-float underflow.
3. Detail (field res): `(H, f0, stratus share, nimbus share)`. `f0` is the eroded density the old shader thresholded. `H` is pinched to 0 at that contour (round shoulders), carved by big soft-creased billows (size in blob radii, strongest on sun-facing silhouettes, gentle on sheets and towers) and, for stratus, rolled along its x-streaks.
4. Scenery bake (quarter res): each scenery layer's thickness into R/G/B.
5. Composite (full res): play layer shaded from the thickness map: normals from `H`, Beer march toward the sun (`steps`), powder, dual-lobe Henyey-Greenstein phase, 3 multiple-scatter octaves, ring AO, silver lining when the sun is behind, tower base darkening from height-in-cloud. Scenery layers are lit by the same terms with fewer steps, hazier and lower contrast with depth; far banks have no AO.

The sun is the sky's: `skySunPosX/Y` give its direction in the view plane, `skySunDepth` (-1 behind .. 1 in front) the rest. Artist params live in the `volume` group of `src/params/fields.ts` (dev panel).

## Tiers (`tier.ts`)

Only target scales and step-count uniforms change; no feature toggles, no recompiles. `?tier=hi|mid|low` overrides; otherwise `low` when `(pointer: coarse)` and width <= 860, else `hi`. `getState().tier`, `setTier(tier)`, dev-panel dropdown.

| Tier | Field/detail | Bake | DPR cap | Play steps | Scenery steps | AO taps |
| --- | --- | --- | --- | --- | --- | --- |
| hi | 0.5 | 0.3 | 2 | 8 | 5 | 8 |
| mid | 0.5 | 0.3 | 1.5 | 6 | 4 | 6 |
| low | 0.35 | 0.25 | 1 | 4 | 3 | 4 |

## Measured cost

Full `scene.render()` with GPU sync, `mixed` scene, clear weather, median ms, dev machine real GPU (WSLg, OpenGL ES backend), DPR 1. "old" is the previous flat shader.

| Size | Backend | old | hi | mid | low |
| --- | --- | --- | --- | --- | --- |
| 1280x800 | WebGPU / WebGL2 | 3.5 / 2.5 | 2.9 / 2.3 | 2.8 / 2.6 | 2.5 / 2.8 |
| 2560x1600 | WebGPU / WebGL2 | 9.1 / 6.8 | 7.0 / 5.6 | 6.5 / 5.2 | 5.1 / 3.9 |
| 3840x2400 | WebGPU / WebGL2 | 18.9 / 14.6 | 15.1 / 12.9 | 14.6 / 12.1 | 10.9 / 8.5 |

The volume path is cheaper than the old shader at every size: the noise now runs once per field pixel (half res) instead of per screen pixel. Small sizes are overhead-bound, so tiers only separate at high resolution. Spike numbers (A, 3840x2400, WebGPU): baseline 16-17, A hi 11, A low 8; a per-pixel 3D raymarch (B) 25-33 ms, which is why it was not ported. Phones are untested: low is an estimate.
