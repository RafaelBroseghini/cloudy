# Cloudy sim (M1)

The middle cloud layer runs on Box2D v3 (`box2d3-wasm/compat`). Blobs are dynamic circles with rotation locked. Each spring is a Box2D distance joint with its spring enabled. Per spring (with its type multipliers, below), `k_s` and `c` become a hertz and a damping ratio using the reduced mass `mu = m_a * m_b / (m_a + m_b)`: `hertz = sqrt(k_s / mu) / 2pi`, `ratio = c / (2 * sqrt(k_s * mu))`. The cursor is a kinematic circle whose velocity we compute each step. Blob-blob collisions are off (category masks), so blobs touch only the cursor. Breaking, relabelling, arming and merging are our rules, in `src/sim/sim.ts`.

## Why Box2D

A spike measured Rapier 2D, Box2D v3 and a custom integrator. Only Box2D has a supported runtime rest-length setter (`b2DistanceJoint_SetRestLength`); Rapier needed an internal call. With per-step rest-length mutation, Box2D took about 0.9 ms per step for 256 blobs and 1000 springs. The custom integrator took about 0.13 ms. We use Box2D anyway, because the project rule is not to hand-roll what a library already does.

## M1 deviations from PLAN's model

| Mechanism | What it does | Why | Risk |
| --- | --- | --- | --- |
| Speed-dependent breaking (`flickRate`, `flickCut`) | Springs near a cursor moving faster than `flickRate` per rest length get a lower split strain, down to `flickCut` times at twice `flickRate`. | A flick cuts cleanly along its path. A slow sweep never reaches `flickRate`. | Small clouds in portrait under-split (see Known gaps). |
| Wisp prevention (`minPieceFrac`, `sparedLinks`) | A split may not shed a piece under `minPieceFrac` of its cloud, with a floor of 4 blobs. Such a piece keeps its links to the neighbour it shares most candidate springs with. A cloud under twice the limit never splits. | Shedding a few blobs reads as shredding, not splitting. | Fewer splits than PLAN implies. The choice of spared links is a heuristic. |
| Blob speed bleed (`softSpeed`) | Blob speed above `softSpeed` decays with time constant 0.06 s. Contact still hands blobs the cursor's speed. | Flicked pieces stop instead of crossing the view and piling up. | Fights the M4 tornado: wind-driven blobs above `softSpeed` get bled. Revisit in M4, e.g. relative to the wind field. |
| Soft containment (`containK`, inset) | Blob centres beyond the view inset by 0.6 units feel a critically damped spring (c = 2 * sqrt(k)) back inside. Blobs only, never the cursor. With a breeze set, the x spring fades out as the mean drift (breeze plus the wind hook's terminal speed) grows from 0.02 to 0.1 units/s, because it would hold drifting clouds at the downwind edge and yank re-entering ones into view. The y spring is unchanged. | Strays drift home instead of bouncing off an edge. | The inset is a code constant, not a param, and does not scale with view size. With a breeze, a piece flicked off the side leaves (downwind it wraps, upwind the drift brings it back). |
| Cursor model (`k_p`, `c_p`, `m_c`, `k_r`) | Backward-Euler spring to the pointer. The damper acts on velocity relative to the pointer, so there is no steady lag in free space. Density drag is `k_r * rho * v`. The world step is sliced into up to 10 slices, each moving the cursor under 0.3 units, so a fast cursor cannot skip blobs. | Stable at 60 Hz with a stiff spring. Fast cursors do not tunnel through blobs. | `cursorMaxSpeed` still clamps pointer and cursor velocity as a safety cap, set to the slicing limit: 10 * 0.3 / (1/60) = 180. PLAN has no cap, so very fast motion is clamped. |
| Size-normalised density | Each blob adds `mass * (DENSITY_REF_RADIUS / radius)^2 * W` to the field, in both the sim kernel and the splat shader (`src/sim/blobBuffer.ts`). | With mass = πr², small portrait clouds had core density near `CLOUD_THRESHOLD` and rendered pale. | PLAN's `ρ = Σ m·W` no longer holds literally; drag `k_r` is tuned against the normalised field. |
| Shape matching (`alpha`) | The goal error is applied as a mass-weighted velocity nudge `alpha * (g - p) / dt` through Box2D, not as a position correction. | Conserves cloud linear momentum and goes through the solver. | PLAN's `alpha` is a positional fraction. The same value has a different per-step effect, so do not copy PLAN's tuning. |
| Wind gain (`WIND_ACCEL_GAIN` = 0.2, `src/params/drive.ts`) | Scales the weather wind acceleration on blobs. | Full gain swept every cloud to the view edge within seconds. | Uniform wind plus the breeze now wraps clouds instead of piling them at the right edge (tornado). M4's vortex replaces uniform wind. |
| Ambient breeze (`setBreeze`, `src/sim/flow.ts`) | Every blob is dragged toward a moving air: each step adds `expm1(blobDamping * dt) * u_air` to its velocity, so a free blob settles at `u_air` in any weather. `u_air` is a prevailing drift (`breezeSpeed`, `breezeAngle`) plus the curl of a simplex-noise potential (`simplex-noise`, seeded `mulberry32`), so the turbulence is divergence-free (clouds swirl and shear, never bunch up). Eddies are 2.5x wider than tall (streaky, so clouds keep their rows) and ride with the air; the noise phase and air offset are integrated per sim step, so changing params never jumps the field. Blobs only, never the cursor. | PLAN wants wind on blobs always, and curl noise for the tornado; this builds the reusable piece now and gives clear weather life. | Breeze 0 and turbulence 0 (or `null`) leaves the sim bit-identical. Needs `blobDamping > 0`. Drift stays far under `softSpeed` (3). Shape matching resists the shear, so clouds translate and rotate more than they deform. |
| Wrap-around (`wrapClouds`) | While a breeze with drift above 0.05 units/s is set, a cloud whose every blob (metaball extent 1.6 radii) is past the view edge downwind moves as a whole by one fixed period (view width + 7 units, longer only for a very wide cloud) to just outside the opposite edge. Positions only: velocities, springs, rest offsets and ids are kept. Only downwind exits wrap. | A drift that fights containment stalls clouds at the edge; wrapping keeps a gentle loop with the clouds' spacing intact. | A cloud off the side is not drawn, so the loop is invisible; the period (about 25 units on desktop) means a cloud is away for about a minute. Clouds wider than the seam allows land partly on screen. |

## Cloud types (stratus, cumulonimbus)

Every blob has one type for life: cumulus (the original, baseline), stratus or cumulonimbus. A cloud is whatever blobs it holds, so merged clouds can be mixed (merge rules are type-agnostic). Types come from the scene (`src/sim/types.ts`, `CloudSpec.type`).

- Per-type multipliers (`src/sim/params.ts`, fields `stratus*` / `nimbus*`, dev panel group `types`) scale the global params, which weather still sets. Cumulus is all ones, so a cumulus-only scene is bit-identical to before (a test checks m1 with wild type values).
- Springs between two blobs: stiffness is the harmonic mean of the two multipliers (two half-springs in series, so the softer material dominates the bond); damping, yield, creep, split and flick are the plain mean. Merge springs use the same rule. The cursor's drag sees `sum(drag_type * blob density)`; `densityAt` and the renderer keep the geometric density, so thresholds and the harness contract do not depend on type. `mass` sets the Box2D shape density (and `mass[i]`), `breeze` scales how far the air and wind move the blob.
- Blob buffer: `BLOB_STRIDE` is 12 (was 8). Offsets 8 to 10 hold the type as a one-hot (cumulus, stratus, cumulonimbus), 11 is spare. 256 blobs upload 12 KB per frame (PLAN's limit is under 16 KB). The buffer's mass slot is the geometric area.

| Multiplier | Applies to | Stratus | Cumulonimbus |
| --- | --- | --- | --- |
| `drag` | weight of the blob's density in cursor drag (`k_r`) | 0.45 | 2.6 |
| `stiff` | `k_s` | 0.65 | 1.7 |
| `damp` | `c` | 1.2 | 1.5 |
| `yield` | `yieldStrain` | 0.55 | 1.5 |
| `creep` | `creep` | 1.6 | 0.5 |
| `split` | `splitStrain` | 0.7 | 2 |
| `flick` | `flickRate` | 0.8 | 4.5 |
| `mass` | blob mass | 0.7 | 1.8 |
| `breeze` | air and wind response | 1.1 | 0.55 |

Measured on the real scene clouds (units/s along a sweep): cumulus starts splitting at about 20, cumulonimbus at about 45 to 70 (thunder weather included), a stratus sheet tears from about 6 to 8 into 2 to 4 pieces. Stratus tearing is mostly its geometry: small blobs (short rest length) lower the absolute flick speed, and neighbour springs only (longer springs make a sheet very hard to tear).

Scene shapes (`buildLayout`): stratus is a thin lens-shaped sheet (aspect up to 6) built column by column (`sheetPoints`, so it thins evenly to its tips instead of coming out a rolling pin), undulating a little along its length; cumulonimbus is a `tower` profile over its height (a broad flat base, a column with cauliflower lumps, a wider flatter anvil sheared downwind; taller than wide, about 1.6:1, so it takes more blobs than the other types: 40 to 66). Compositions per weather (`sceneSpec`: `clear`, `rain`, `thunder`, `mixed`) are slot lists fitted to the view like m1; counts shrink with width, and a portrait view stacks them vertically.

| Scene | Clouds (wide view) |
| --- | --- |
| `clear` | 3 cumulus (m1's triangle) + 1 thin stratus low left |
| `rain` | 3 stratus sheets + 2 cumulus |
| `thunder` | 2 cumulonimbus + 2 small stratus |
| `mixed` (tornado) | 2 cumulus + 1 cumulonimbus + 2 stratus |

## Known gaps

- Phone flicks at 0.2 s split only about 3 of 15 times in portrait. Tiny clouds get pushed ahead rather than torn. Revisit in M1 polish.
- The `minPieceFrac` comment in `params.ts` says "never under 3 blobs", but `MIN_PIECE_FLOOR` in `sim.ts` is 4. This doc uses 4. The comment needs fixing.

## Parameters

Generated from `src/sim/params.ts`. Defaults and ranges are copied from the file. Units are as stated in the file's comments.

| Name | Default | Range | Meaning |
| --- | --- | --- | --- |
| `k_r` | 120 | 0 to 400 | Cursor drag per unit density: F = -k_r * rho * v. |
| `k_s` | 90 | 5 to 400 | Spring stiffness, force per unit stretch. |
| `c` | 3 | 0 to 40 | Spring damping along the spring axis. |
| `yieldStrain` | 0.45 | 0.02 to 2 | Strain above which a spring creeps. |
| `creep` | 0.02 | 0 to 0.5 | Share of excess stretch moved into rest length per step, past yield. |
| `splitStrain` | 0.9 | 0.3 to 6 | Strain above which a spring breaks. |
| `flickRate` | 16 | 5 to 300 | Cursor speed per rest length (1/s) where flick tearing starts. |
| `flickCut` | 0.15 | 0.05 to 1 | Split-strain multiplier for springs under a full-speed flick. |
| `minPieceFrac` | 0.15 | 0 to 0.5 | Smallest piece a split may shed, as a fraction of its cloud. |
| `d_touch` | 0.1 | 0 to 0.4 | Surface gap under which armed clouds merge. |
| `d_release` | 0.6 | 0.45 to 3 | Surface gap beyond which a split pair arms. |
| `tau` | 1.5 | 0.1 to 20 | Cooldown after which a split pair arms regardless of gap. |
| `alpha` | 0.06 | 0 to 0.5 | Shape matching: fraction of the goal error removed per step. |
| `blobDamping` | 2.5 | 0 to 10 | Linear damping on blobs (1/s). |
| `containK` | 25 | 0 to 100 | Soft containment stiffness outside the inset view (1/s^2); 0 disables. |
| `softSpeed` | 3 | 2 to 1000 | Blob speed above which the excess decays; 1000 disables. |
| `m_c` | 1 | 0.1 to 10 | Cursor mass. |
| `k_p` | 4000 | 10 to 20000 | Cursor spring stiffness toward the pointer. |
| `c_p` | 120 | 0 to 1000 | Cursor damper, acting on velocity relative to the pointer. |
| `cursorMaxSpeed` | 180 | 1 to 400 | Cursor speed safety cap (units/s). |
| `stratus*`, `nimbus*` (9 each) | see the type table | 0.1 to 5 | Per-type multipliers (above); group `types` in the dev panel. |
