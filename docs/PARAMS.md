# Params (M2 core)

`src/params`: pure TypeScript (no three, no DOM). One flat record `P` of numeric fields, resolved from layers and weather. Not wired into the game yet.

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
- `weather`: `rainRate/Angle/Speed`, `windX/Y`, `vortexStrength` (0, M4), `strikeRate` (0, M3), `strikesEnabled`.
- `postfx`: `fxExposure`, `fxFlash` (0).

Defaults match today's `sky.ts` / `cloudField.ts` uniforms (hex converted to linear RGB).

## Blend kinds

`linear`: `(1 - s)a + s b` per channel. `step` (`strikesEnabled`): holds the `from` value until the blend ends. Blend weight `s = smoothstep(progress)`.

## Weather

`Weather = steady | transition { from, to, progress, duration, fromWeights }`. `P(s) = sum_i w_i preset_i`. `fromWeights` is a snapshot of the weights being left; starting a transition mid-blend uses the current weights as `from`, so values do not jump. `from` stays the label whose step values are held.

## Presets (`WEATHER_PRESETS`, sparse over defaults; cursor and gate params never touched)

- `clear`: sets nothing: today's look and defaults.
- `rain`: grey low-contrast sky, denser banks, `rainRate` 0.7; heavier clouds (more drag and creep, softer springs).
- `thunder`: darker, `rainRate` 0.9, stiffer springs, splits sooner, `strikeRate` placeholder 0.15, `strikesEnabled` 1.
- `tornado`: green-grey sky, strong wind, weaker springs, `vortexStrength` placeholder 0.6.

## Integration recipe

```ts
weather = advanceWeather(weather, frameDt)                 // 1. each frame (also on startTransition)
const p = resolve({ scene, user, transient }, weather)     // 2. cheap, pure
if (changed(interactionOf(p))) sim.setParams(interactionOf(p))  // 3. only on change
// 4. push groupOf(p,'sky'|'lighting'|'scenery'|'weather'|'postfx') / colorOf(p,'skyTop') to uniforms
```

Colours are linear: use `color.setRGB(r, g, b)`, never hex.
