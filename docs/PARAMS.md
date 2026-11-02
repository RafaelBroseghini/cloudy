# Params (M2)

`src/params`: pure TypeScript (no three, no DOM). One flat record `P` of numeric fields, resolved from layers and weather. Wired into the game through `drive.ts` (see Integration).

## Layer order

`P = defaults ⊕ scene ⊕ weather ⊕ user ⊕ transient`. Later wins per field; unset fields (and non-finite values) fall through. Then every field is clamped to its range and the interaction subset goes through `clampParams` (`d_touch < d_release`).

- `scene`: `Layer` (any field). The weather layer is blended against the scene-below values, so a scene shows through wherever a preset leaves a field unset.
- `user`: `UserLayer`, a placeholder limited to `SLIDER_KEYS` (continuous, non-interaction). Empty until M5.
- `transient`: `TransientLayer`, typed to lighting and post-FX keys only. `resolve` also reads only `TRANSIENT_KEYS`, so a cast cannot smuggle in sim fields.

## Field groups (`FIELD_SPECS`: group, kind, min, max, default)

- `interaction`: the sim's `PARAM_SPECS`, unchanged.
- `sky`: `skyTop/Horizon/Bottom/Sun{R,G,B}` (linear RGB), horizon height, sun x/y/size/strength.
- `lighting`: `lightDirX/Y`, `lightGain`, `lightAmbient`, `cloudLit/Mid/Shade{R,G,B}`.
- `scenery`: `far`, `mid`, `near` x `Opacity|Tint|Drift|Density`. Render-only.
- `weather`: `rainRate/Angle/Speed`, `windX/Y`, `vortexStrength` (0, M4), `strikeRate` (strikes per second, mean), `strikesEnabled` (step).
- `postfx`: `fxExposure`, `fxFlash` (0), `fxFlashX` (0.5: screen x of the flash glow).

Defaults match today's `sky.ts` / `cloudField.ts` uniforms (hex converted to linear RGB).

## Blend kinds

`linear`: `(1 - s)a + s b` per channel. `step` (`strikesEnabled`): holds the `from` value until the blend ends. Blend weight `s = smoothstep(progress)`.

## Weather

`Weather = steady | transition { from, to, progress, duration, fromWeights }`. `P(s) = sum_i w_i preset_i`. `fromWeights` is a snapshot of the weights being left; starting a transition mid-blend uses the current weights as `from`, so values do not jump. `from` stays the label whose step values are held.

## Presets (`WEATHER_PRESETS`, sparse over defaults; cursor and gate params never touched)

- `clear`: sets nothing: today's look and defaults.
- `rain`: grey low-contrast sky, denser banks, `rainRate` 0.7; heavier clouds (more drag and creep, softer springs).
- `thunder`: darker, `rainRate` 0.9, stiffer springs, splits sooner, `strikeRate` 0.1 (a strike about every 10 s), `strikesEnabled` 1.
- `tornado`: green-grey sky, strong wind, weaker springs, `vortexStrength` placeholder 0.6.

## Integration (as wired)

`drive.ts` is the pure per-step weather drive; `main.ts` runs it, `harness.ts` shows it.

```ts
const drive = createDriveRunner(sim, {}, parseWeatherParam(location.search)) // ?weather=clear|rain|thunder|tornado
// once per FIXED sim step (rAF stepper and harness tick/drag alike), so weather time and sim time are in lockstep:
drive.step(FIXED_DT)   // advanceWeather -> resolve (only if the weather changed) -> sim.setParams(interactionOf(P)) only if an
                       // interaction field differs -> sim.setWind(...) only if P changed (null while wind is 0)
sim.step()
// per rendered frame, only when P changed: applyLook(scene, P)  (uniforms; rain slant/rate included)
```

- Wind: blob acceleration is `WIND_ACCEL_GAIN (0.2) * windX|windY`, uniform for now. It goes to `sim.setWind`, which acts on blobs only; the cursor equation has no wind input. Uniform wind leans every cloud toward one view edge, so in tornado they pile up and merge after about a minute. M4 replaces it with the vortex plus curl noise.
- Rain: `windX` also slants the streaks: `tan(angle) = tan(rainAngle) + 0.12 * windX`.
- Transitions: `setDriveWeather` (harness `setWeather`, keys 1..4 use 4 s). Layers (`setDriveLayers`) swap scene/user/transient for M3/M5.

## Rain (`src/render/rain.ts`, render-only)

Stateless analytic streaks in the composite shader: no particles, no compute, no extra pass, so WebGPU and WebGL2 draw the same rain. Each band tiles a frame rotated to the fall direction into cells; one integer-hashed streak per cell at most (P = `rainRate` x band `maxFill` x tier). The frame slides by a CPU-integrated phase, so rate, speed and slant changes never jump the streaks. A uniform branch skips a band at `rainRate` 0 (no draw call, no recompile).

| Band | Depth (parallax) | Cell v x u | Length (of cell) | Half-width | Speed x `rainSpeed` | Alpha | Haze | Over play clouds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| far | 0.3 (behind the mid clouds and the play layer) | 0.34 x 1.5 | 0.3-0.6 | 0.011 | 0.4 | 0.55 | 0.4 | hidden by them |
| mid | 0.75 (behind the play layer) | 0.6 x 2.4 | 0.25-0.5 | 0.016 | 0.62 | 0.65 | 0.2 | hidden by them |
| near | 1.5 (in front, shifts opposite) | 1.1 x 3.6 | 0.22-0.42 | 0.026 | 0.95 | 0.55 | 0 | muted by 0.7 where play density is high |

`scene.rain.setTier(0..1)` scales the streak count (the quality tier hook; no governor yet). Streaks are never thinner than a device pixel (dimmed instead).

## Look tuning (rain, thunder, tornado)

The play clouds keep contrast by making the sky darker than their lit tops (`cloudLit` near white, `lightGain` 3.4-3.6, dark `cloudShade` undersides), while scenery banks get hazier: lower `*Opacity`, higher `*Tint` (blend toward the sky horizon colour).

## Strikes (M3: `src/strikes` pure, `src/audio` Web Audio)

One strike record `{ id, tStrike, clock, intensity, d, x, pick, pitch }` feeds the flash and the thunder.

- Scheduler: seeded, stepped once per fixed sim step with the resolved `strikesEnabled` / `strikeRate`. A strike fires when the integral of `strikeRate` reaches `0.35 + Exp(0.65)` (mean gap `1 / strikeRate`, never under `0.35 / strikeRate`). Disabled or rate 0: none. `d` 0.4..3 s, softer when longer; `x` 0.1..0.9.
- Clocks: the strike lives on the AudioContext render clock R while the context is running, else on `performance.now()` (flash only, thunder skipped as `locked`). R is `getOutputTimestamp()` (the heard clock: `contextTime + (perf - performanceTime)`) plus `outputLatency` (else `baseLatency`, else 0), because that timestamp names the sample leaving the speaker now; without `getOutputTimestamp` it is `currentTime` plus the time since it last ticked. `tStrike` = R now + 0.1 s.
- Timing: the flash PEAK is `tStrike`. Thunder starts at `tStrike + d - latency` and is heard at `tStrike + d`, so heard minus flash peak is `d` for any latency. A start before `max(R, currentTime)` or a heard time already past is skipped (`late`); never played late.
- Envelope `E(tau)`, `tau = t - tStrike`: 0 before `-0.04`; smoothstep rise 0.04 s to 1 at `tau = 0`; flickers peaking 0.7 at 0.12 s and 0.4 at 0.27 s (decays 0.09, 0.12, 0.15 s) over a 0.3 afterglow (0.45 s decay); 0 from 2 s. `prefers-reduced-motion`: one 0.1 s rise to 0.45, 0.4 s decay, no flicker.
- Flash: `fxFlash = max_i intensity_i * E` and `fxFlashX` of the strongest, written through the transient layer (`setLayers({ transient })`), so interaction fields cannot change. Composite shader: sky and scenery lifted (x1.3 plus a cool tint and a wide soft pool at `fxFlashX`), play clouds get an additive blue-white light inside the pool and a little everywhere, so dark undersides light up. Uniforms only.
- Thunder: one of `public/audio/thunder.json`'s clips per strike, rate 0.85..1.1, gain `0.2 + 0.8 * intensity^1.5`, low-pass 16 kHz (near) down to 1.2 kHz (far), at most 3 voices (`voice-cap`). Clips are decoded once, after the first gesture. No navigator audio session API is used (a test greps `src/`), so iOS keeps the silent switch and mixes with other audio.
