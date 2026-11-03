# Cloudy sim

The middle cloud layer runs on Box2D v3 (`box2d3-wasm/compat`). Blobs are dynamic circles with rotation locked; each spring is a distance joint with its spring enabled, its `k_s` and `c` turned into a hertz and damping ratio through the pair's reduced mass. The cursor is a kinematic circle whose velocity we compute. Blob-blob collisions are off, so blobs touch only the cursor. Breaking, relabelling, arming and merging are our rules, in `src/sim/sim.ts`. Every param, its range and default is in `PARAM_SPECS` (`src/sim/params.ts`).

## Why Box2D

A spike measured Rapier 2D, Box2D v3 and a custom integrator. Only Box2D has a supported runtime rest-length setter (`b2DistanceJoint_SetRestLength`); Rapier needed an internal call. With per-step rest-length mutation Box2D took about 0.9 ms per step for 256 blobs and 1000 springs, the custom integrator about 0.13 ms. We use Box2D anyway: the project rule is not to hand-roll what a library already does.

## Where the sim departs from PLAN's model

| Mechanism | Why | Risk |
| --- | --- | --- |
| Speed-dependent breaking (`flickRate`, `flickCut`): springs near a fast cursor get a lower split strain. | A flick cuts cleanly along its path; a slow sweep never tears. | Small clouds in portrait under-split (Known gaps). |
| Wisp prevention (`minPieceFrac`, `MIN_PIECE_FLOOR`): a split may not shed a tiny piece; it keeps its links to its best-connected neighbour. | Shedding a few blobs reads as shredding, not splitting. | Fewer splits than PLAN implies; the choice of spared links is a heuristic. |
| Blob speed bleed (`softSpeed`): speed above it decays fast. | Flicked pieces stop instead of crossing the view and piling up. | Fights the M4 tornado: wind-driven blobs get bled. Revisit in M4, e.g. relative to the wind field. |
| Soft containment (`containK`): blobs beyond an inset of the view feel a critically damped spring back. With a breeze, the x spring fades out as the mean drift grows. | Strays drift home instead of bouncing off an edge. The x spring would otherwise hold drifting clouds at the downwind edge and yank re-entering ones into view. | The inset is a code constant and does not scale with view size. |
| Cursor model (`k_p`, `c_p`, `m_c`, `k_r`): backward-Euler spring to the pointer, damper on velocity relative to the pointer; the step is sliced (`MAX_SLICES`, `MAX_CURSOR_TRAVEL`). | Stable at 60 Hz with a stiff spring, no steady lag in free space, and a fast cursor cannot tunnel through blobs. | `cursorMaxSpeed` caps speed at the slicing limit, so very fast motion is clamped (PLAN has no cap). |
| Size-normalised density (`DENSITY_REF_RADIUS`, `src/sim/blobBuffer.ts`), shared by the sim and the volume shader. | With mass = πr², small portrait clouds had cores near `CLOUD_THRESHOLD` and rendered pale. | PLAN's `ρ = Σ m·W` no longer holds literally; `k_r` is tuned against the normalised field. |
| Shape matching (`alpha`) as a mass-weighted velocity nudge through Box2D, not a position correction. | Conserves cloud momentum and goes through the solver. | Same value, different per-step effect from PLAN's positional `alpha`: do not copy PLAN's tuning. |
| Ambient breeze (`setBreeze`, `src/sim/flow.ts`): blobs are dragged toward a moving air, a drift plus the curl of a simplex-noise potential. | Divergence-free, so clouds swirl and shear but never bunch up; it gives clear weather life and is the reusable piece of M4's curl noise. Phase and air offset are integrated per step, so param changes never jump the field. | Needs `blobDamping > 0`. Breeze off leaves the sim bit-identical. Shape matching resists shear, so clouds translate more than they deform. |
| Wrap-around (`wrapClouds`): with a drift, a cloud wholly past the downwind edge moves as a whole to just outside the opposite edge (positions only). | A drift that fights containment stalls clouds at the edge; wrapping keeps a gentle loop with the clouds' spacing intact. | Very wide clouds can land partly on screen. |

## Cloud types

Every blob has one type for life (cumulus, stratus, cumulonimbus); a cloud is whatever blobs it holds, so merged clouds can be mixed and merging stays type-agnostic. Per-type multipliers (`stratus*`, `nimbus*` in `PARAM_SPECS`) scale the global params, which weather still sets. Cumulus is all ones, so a cumulus-only scene is bit-identical to before types existed (a test checks it).

- A spring between two types takes the harmonic mean of the stiffness multipliers (two half-springs in series: the softer material dominates the bond) and the plain mean of the rest.
- Cursor drag weights each blob's density by its type; `densityAt` and the renderer keep the geometric density, so thresholds and the harness contract do not depend on type.
- `MAX_BLOBS` is 254 because 255 is the renderer's empty marker in its tile lists; with `BLOB_STRIDE` it keeps the per-frame upload inside PLAN's 16 KiB.

Shapes (`src/sim/scene.ts`): a stratus sheet is built column by column so it thins evenly to its tips; a cumulonimbus is a union of ellipse lobes filled with a jittered lattice, with smaller rim blobs so the sim's own contour has lumps and a flat base of full-size blobs. Compositions per weather are `sceneSpec`.

Measured split speeds along a sweep (units/s): cumulus about 20; cumulonimbus 45 to 70 for a plain ellipse, 60 to 100 through the shipped tower; a stratus sheet tears at about 6 to 8, mostly because of its geometry (short rest lengths, neighbour springs only).

## Known gaps

- Phone flicks of 0.2 s split only about 3 of 15 times in portrait: tiny clouds get pushed ahead rather than torn.
