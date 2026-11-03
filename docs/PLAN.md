# Cloudy plan

Condensed from "Browser tech for a cloud-pushing game" (research as of 2026-11-01). This is the target design; the code is the source of truth for what exists today.

## The game

A 2.5D browser toy played with mouse, trackpad or touch. The cursor pushes through springy clouds, which resist more where they are denser, dent, spring back, split into pieces that persist, and re-merge when pieces touch. Rain, thunder and tornado weather change how clouds behave. Lightning is a flash plus thunder heard in sync. Players tweak preset scenes with a few sliders saved on the device. No accounts, no sharing, no editor.

## Decisions

| Decision | Consequence |
| --- | --- |
| 2.5D: one flat play plane plus parallax layers | Clouds are rendered as real volumes (per-blob 3D ellipsoids raymarched through tile lists with light marching; the CPU sim stays 2D). The scenery layers stay flat, lit as thin slabs. |
| Only the middle layer is interactive | One blob sim and one density sampler. Scenery layers are render-only. |
| Splits persist; pieces always re-merge on touch, in any weather | Breakable springs; merges are gated by hysteresis so pieces do not re-merge right after a split. |
| Weather changes interaction | One typed parameter set per weather state, blended over time. |
| Wind (and tornado) moves only clouds and debris | The cursor feels only player intent and density drag. |
| Lightning never changes interaction | The transient layer writes only lighting and post-FX fields. |
| WebGPU preferred, WebGL2 a full fallback | three.js `WebGPURenderer` picks the backend. Whole game plays on WebGL2; only visual headroom scales. |
| CPU owns gameplay, GPU only draws | Nothing is read back from the GPU. Every backend and device plays the same game. |
| 60 fps, fixed-timestep sim | Sim is decoupled from display refresh; same result at 60 Hz and 120 Hz. |
| iOS: respect the silent switch | Default audio session. Never set `navigator.audioSession.type`. |
| Sliders map only to bounded uniforms | Never to shader feature toggles. Clamped at input, at resolve time and on load. |

## Stack

- TypeScript, three.js r187 `WebGPURenderer` with TSL node materials (`three/webgpu`, `three/tsl`). `?backend=webgl` forces WebGL2 via `forceWebGL`.
- Physics: Box2D v3 (`box2d3-wasm`) for blob bodies and spring joints; see `docs/SIM.md` for why and where M1 departs from the model below.
- Web Audio API directly for thunder. Plain DOM range inputs for player sliders; lil-gui only for dev panels.
- Settings: versioned, schema-validated JSON in localStorage, clamped on load, defaults when invalid.
- Tests: Vitest + fast-check. TLA+ model later.

## Layers

`P = defaults ⊕ scene ⊕ weather ⊕ user sliders ⊕ transient` (later wins per field; as built, `docs/PARAMS.md` adds a sky layer under the weather and a dev layer). Layers: sky, lighting, weather, cloud field, interaction, post FX, depth layers. Every field declares its blend kind and valid range. Features stay fixed and are turned off by weight; pipelines warm with `compileAsync` so blends never compile.

## Sim model (middle layer, CPU, fixed step)

Implemented M1 deviations from this model are listed in `docs/SIM.md`.

Density: `ρ(x) = Σ m_i · W(|x − p_i| / r_i)`, `W(q) = (1 − q²)³` for `q < 1`, else 0. Spatial hash lookup.

Cursor: `m_c · a_c = F_intent − k_r(P) · ρ(x_c) · v_c`. Wind never acts on the cursor. On touch the cursor is absent when no finger is down.

Blobs: damped springs `F_ij = −k_s(P)(|p_i − p_j| − L_ij)û − c(P)((v_i − v_j)·û)û`, shape matching `Δp_i = α(P)(g_i − p_i)`, plus wind `w(p_i, t)`.

Per spring, each step, with `strain = (|p_i − p_j| − L_ij) / L_ij`:
1. Plastic creep: if `|strain| > yield(P)`, `L_ij += creep(P) · (|p_i − p_j| − L_ij)`.
2. Break: if `strain > split(P)`, remove the spring; mark topology dirty.
3. Relabel: if dirty, union-find; each component becomes a cloud; record the new pair (A, B) as unarmed.
4. Arm: a pair arms once its closest blobs are farther apart than `d_release(P)`, or after cooldown `τ(P)`.
5. Merge on touch: armed clouds whose blobs are within `d_touch(P) < d_release(P)` get springs with `L` = current distance and are unioned.

Weather may change gate values but never disables merging, and `d_touch < d_release` holds mid-blend.

## Frame loop

1. rAF; accumulate time; render capped at 60 fps.
2. Drain pointer events (coalesced samples; primary pointer only).
3. Resolve P (slider changes, transitions).
4. Fixed sim steps: sample density, cursor forces, blob step, topology + merge gate.
5. Strikes: read audio time, schedule thunder, compute flash.
6. Upload blob data (12 floats per blob: position, size, motion, cloud id, type one-hot; the renderer works on its own copy) plus the tile lists, and uniforms.
7. GPU: sky + scenery bake, cloud march (half-res), rain/debris, composite.
8. Govern: frame-time stats; step quality tier with hysteresis.

## Weather, tornado, audio

- Weather params blend linearly: `P(t) = (1 − s)P_from + s·P_to`.
- Tornado: Rankine-style vortex around a moving centre plus 2D curl noise. CPU evaluates it per blob; GPU debris particles use the same field. Cloud shaders rotate their noise lookup around the vortex centre.
- Thunder: one strike record `{ id, t_strike, intensity, d }` feeds both outputs. `thunder.start(t_strike + d − outputLatency)`; flash = `intensity · E(audio_now − t_strike)` using `getOutputTimestamp()`. If audio is locked, flash only, never play thunder late. Unlock the AudioContext in the first pointer handler.

## Skies

One sky shader evaluates the analytic (Preetham `SkyMesh`) and gradient models and blends by weight. 3D LUT grading via `lut3D`. Zero and one cloud are valid scenes.

## Quality tiers

Gameplay is identical on every tier. Tiers change the pixel ratio cap, the cloud march target size, the scenery bake resolution, and the march's step counts and scattering octaves (`hi`/`mid`/`low`, `src/render/tier.ts`; `docs/RENDER.md`; `mid` is the desktop default); they never toggle features, so nothing recompiles. Later tiers may also scale noise octaves, particle counts, bloom, scenery layer count. A frame-time governor steps tiers (no thermal API on phones).

## Milestones

| | Scope |
| --- | --- |
| M0 | done: repo, `window.__GAME__` harness, verify skill (WebGPU and forced WebGL2) |
| M1 | done: blob clouds, cursor push with density drag, split and re-merge with hysteresis |
| M2 | done: weather layers and blending, rain, parallax scenery layers |
| M3 | done: lightning flash and thunder synced on the audio clock, public-domain recordings |
| Extra | done, not in the original table: dev tweak panel (`` ` `` or `?dev`), ambient curl-noise breeze with wrap-around, cumulus, stratus and cumulonimbus with per-type multipliers, real volumetric clouds (tile-list raymarch with light marching) and lit scenery, `hi`/`mid`/`low` quality tiers |
| M4 | not started: tornado vortex, debris and swirl (the breeze in Extra is ambient, not the vortex). Last, by explicit decision; also revisit `softSpeed` and `WIND_ACCEL_GAIN` |
| M5 | done: six preset scenes, seven player sliders, dice randomize, saved settings with Valibot validation, Sky panel |
| M6 | done: bloom and a 3D LUT grade per weather (`docs/RENDER.md`). Sunset and purple dusk come from the time-of-day slider |
| M7 | partly done: the `hi`/`mid`/`low` tiers exist (Extra), and `?stats` reads frame times on a real device (`docs/RENDER.md`). Not started: frame-time governor, automatic tier switching, real-device checks (iPhone, Android phone, iPad) |
| Later | TLA+ model (invariants listed below) |

Not built yet, in build order: M7's governor, automatic tiers and device checks; the TLA+ model; M4 last. Also not built and not scheduled: the analytic (Preetham) sky; the sky is the gradient model only.

## Invariants to keep (tests now, TLA+ later)

- BlobPartition: every blob is in exactly one non-empty cloud. SpringsInternal: every spring joins blobs of one cloud. CloudsConnected after relabel.
- NoThrash: a split pair cannot merge until armed. Armed + touching merges on the next topology step.
- GateOrdered: `d_touch < d_release` in every resolved P, mid-blend too.
- Drag is non-decreasing in density, zero at zero density, opposes velocity. Cursor motion is independent of wind.
- With damping > 0 and no input, spring energy does not increase. A split conserves blob count and mass.
- Same sim result for 60 Hz and 120 Hz frame callbacks.
- A strike changes no interaction or sim field. Heard thunder minus flash peak equals `d` for any latency.
- Any slider vector resolves inside all ranges; any stored string loads to valid settings or defaults.

## Perf targets (proposals, not measurements)

Frame p95 ≤ 16.7 ms over 60 s; CPU sim ≤ 2 ms desktop, 3 ms mobile; upload at most 16 KiB/frame (16,384 bytes; clouds use 16,288); zero pipeline compiles after warm-up; zero sync readbacks.
