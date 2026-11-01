# Cloudy sim (M1)

The middle cloud layer runs on Box2D v3 (`box2d3-wasm/compat`). Blobs are dynamic circles with rotation locked. Each spring is a Box2D distance joint with its spring enabled. Per spring, `k_s` and `c` become a hertz and a damping ratio using the reduced mass `mu = m_a * m_b / (m_a + m_b)`: `hertz = sqrt(k_s / mu) / 2pi`, `ratio = c / (2 * sqrt(k_s * mu))`. The cursor is a kinematic circle whose velocity we compute each step. Blob-blob collisions are off (category masks), so blobs touch only the cursor. Breaking, relabelling, arming and merging are our rules, in `src/sim/sim.ts`.

## Why Box2D

A spike measured Rapier 2D, Box2D v3 and a custom integrator. Only Box2D has a supported runtime rest-length setter (`b2DistanceJoint_SetRestLength`); Rapier needed an internal call. With per-step rest-length mutation, Box2D took about 0.9 ms per step for 256 blobs and 1000 springs. The custom integrator took about 0.13 ms. We use Box2D anyway, because the project rule is not to hand-roll what a library already does.

## M1 deviations from PLAN's model

| Mechanism | What it does | Why | Risk |
| --- | --- | --- | --- |
| Speed-dependent breaking (`flickRate`, `flickCut`) | Springs near a cursor moving faster than `flickRate` per rest length get a lower split strain, down to `flickCut` times at twice `flickRate`. | A flick cuts cleanly along its path. A slow sweep never reaches `flickRate`. | Small clouds in portrait under-split (see Known gaps). |
| Wisp prevention (`minPieceFrac`, `sparedLinks`) | A split may not shed a piece under `minPieceFrac` of its cloud, with a floor of 4 blobs. Such a piece keeps its links to the neighbour it shares most candidate springs with. A cloud under twice the limit never splits. | Shedding a few blobs reads as shredding, not splitting. | Fewer splits than PLAN implies. The choice of spared links is a heuristic. |
| Blob speed bleed (`softSpeed`) | Blob speed above `softSpeed` decays with time constant 0.06 s. Contact still hands blobs the cursor's speed. | Flicked pieces stop instead of crossing the view and piling up. | Fights the M4 tornado: wind-driven blobs above `softSpeed` get bled. Revisit in M4, e.g. relative to the wind field. |
| Soft containment (`containK`, inset) | Blob centres beyond the view inset by 0.6 units feel a critically damped spring (c = 2 * sqrt(k)) back inside. Blobs only, never the cursor. | Strays drift home instead of bouncing off an edge. | The inset is a code constant, not a param, and does not scale with view size. |
| Cursor model (`k_p`, `c_p`, `m_c`, `k_r`) | Backward-Euler spring to the pointer. The damper acts on velocity relative to the pointer, so there is no steady lag in free space. Density drag is `k_r * rho * v`. The world step is sliced into up to 10 slices, each moving the cursor under 0.3 units, so a fast cursor cannot skip blobs. | Stable at 60 Hz with a stiff spring. Fast cursors do not tunnel through blobs. | `cursorMaxSpeed` still clamps pointer and cursor velocity as a safety cap, set to the slicing limit: 10 * 0.3 / (1/60) = 180. PLAN has no cap, so very fast motion is clamped. |
| Shape matching (`alpha`) | The goal error is applied as a mass-weighted velocity nudge `alpha * (g - p) / dt` through Box2D, not as a position correction. | Conserves cloud linear momentum and goes through the solver. | PLAN's `alpha` is a positional fraction. The same value has a different per-step effect, so do not copy PLAN's tuning. |

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
