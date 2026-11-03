# Params

`src/params` is pure TypeScript: one flat record `P` of numeric fields, resolved from layers and the weather. Every field's group, blend kind, range and default is in `FIELD_SPECS` (`fields.ts`), with what it means in its JSDoc; this file says why the pieces fit together the way they do.

## Layer order

`P = defaults ⊕ scene ⊕ sky ⊕ weather ⊕ user ⊕ dev ⊕ transient` (`resolve.ts`). A later layer wins per field, and an unset or non-finite value falls through. Then every field is clamped to its range and the interaction subset goes through `clampParams`, so `d_touch < d_release` holds even mid-blend.

- `scene`: any field. The weather blends against the values below it, so a scene shows through wherever a preset leaves a field unset.
- `sky` (`SKY_KEYS` only): the time-of-day slider. It sits below the weather so that a grey rain sky wins over a sunset and blends in over a transition.
- `user` (`USER_KEYS` only): the other player sliders (`docs/SETTINGS.md`). It can never hold `strikesEnabled` or a raw interaction field (type error, and ignored if smuggled), so a slider cannot break a sim invariant. Squish reaches the sim only as the bounded `squish` multiplier, applied after this layer and before dev.
- `dev`: any field, from the dev panel or the harness. It sits above weather and user so an override survives weather changes while untouched fields keep following the blend. Gameplay code never writes it.
- `transient`: typed to lighting and post-FX keys, and `resolve` reads only `TRANSIENT_KEYS`, so a strike cannot change interaction even through a cast.

## Blending and weather

`linear` fields lerp; `step` fields (`strikesEnabled`) keep the `from` value until the blend ends, so a feature never half-exists. The blend weight is the smoothstep of the transition's progress. `Weather` (`weather.ts`) keeps a snapshot of the weights being left, so starting a new transition mid-blend never jumps. Presets (`WEATHER_PRESETS`) are sparse and never touch cursor or merge-gate params: weather changes how clouds feel, never whether pieces can re-merge.

## The weather drive (`drive.ts`)

`createDriveRunner` steps the weather once per fixed sim step (the rAF stepper and harness `tick`/`drag` alike), so weather time and sim time stay in lockstep and a paused harness run is deterministic. It resolves only when something changed and pushes `interactionOf(P)` to the sim only when an interaction field differs; `applyLook` pushes the render fields as uniforms once per rendered frame when P changed.

- Wind acts on blobs only, scaled by `WIND_ACCEL_GAIN` because full gain swept every cloud to the edge within seconds. M4's vortex replaces uniform wind.
- `breezeOf(P)` turns the breeze fields into the sim's `FlowParams` (`null` when drift and turbulence are both 0, which leaves the sim bit-identical). The renderer reads the same breeze, scaled by depth, so the scenery drifts with the play clouds.
- Changing weather never respawns clouds; applying a settings scene does.

## Look

- Rain and storms keep the play clouds readable by darkening the sky below their lit tops rather than greying the clouds, and by hazing the scenery banks (lower opacity, more tint toward the horizon).
- The play clouds' noise is sampled in the air's frame (`scene.setAir(sim.flowState())`), so erosion stays put on a drifting cloud instead of sliding through it; billows evolve along a CPU-integrated phase, so rate changes never jump. Reduced motion slows the render's evolution and drift, not the sim's breeze (the sim must not depend on a display preference).
- Rain is stateless analytic streaks in the composite (`rain.ts`, `RAIN_BANDS`): no particles, no compute, no extra pass, so both backends draw the same rain. The streak frame slides by a CPU-integrated phase, so rate, speed and slant changes never jump the streaks.
- Post (M6, `docs/RENDER.md`): the clear-weather grade is near neutral because the time-of-day keyframes already paint sunset and dusk; a grade on top would double them. The grade fields are weather-owned, so they blend with the weather. A strike raises the bloom in `look.ts` (render-only, like every lightning effect).

## Strikes (`src/strikes` pure, `src/audio` Web Audio)

One strike record feeds both the flash and the thunder, so they cannot disagree.

- Clock: a strike lives on the AudioContext's render clock while audio runs, else on `performance.now()` (flash only, thunder skipped as `locked`). The render clock is `getOutputTimestamp()` plus the output latency, because that timestamp names the sample leaving the speaker now. The flash peak is `tStrike`; thunder starts at `tStrike + d - latency`, so heard thunder minus flash peak is `d` for any latency. A thunder that would start late is skipped, never played late.
- Scheduler: seeded and stepped per fixed sim step, so a replay is deterministic. Gaps are a floor plus an exponential, so strikes never bunch.
- Anchoring: when a cumulonimbus is on screen, a strike without an explicit `x` starts inside one (`anchor.ts`). It reuses the strike's existing draws, so anchoring adds no rng draws and replays are unchanged.
- Flash: written through the transient layer, so interaction cannot change. The composite lifts the sky and scenery; the volume march lights the cloud body from inside, so dark undersides light up.
- Thunder: clips decode once, after the first gesture. No navigator audio-session API is used (a test greps `src/`), so iOS keeps the silent switch and mixes with other audio.

## Dev panel (`src/dev`)

The backtick key or `?dev` opens a lil-gui panel, loaded by dynamic import so it is its own chunk. `model.ts` builds it from `FIELD_SPECS`, so a new field appears without touching the panel. Touching a control sets a dev override (orange name); double-click clears it; "copy overrides JSON" gives a paste-ready layer for `presets.ts`. A red wavy name means the resolved value differs from the stored override (the gate clamp). Nothing persists.
