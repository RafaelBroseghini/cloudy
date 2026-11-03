---
name: verify
description: Verify that Cloudy runs and looks right in a real browser on both render backends. Use after any change to rendering, the sim, input, the harness, or the scene, and before calling work done. Builds the game, drives a split and a merge through window.__GAME__ on WebGPU, forced WebGL2 and a phone viewport, fails on wrong backend, failed asserts or console errors, then tells you how to read the screenshots.
---

# Verify

`npm run verify` builds the game (`vite build`), serves it with `vite preview` on its own port (43210, `VERIFY_PORT` to change; never a dev server) and runs three passes, each in its own agent-browser session (`verify-webgpu`, `verify-webgl2`, `verify-mobile`). It exits non-zero on any failure and prints a summary table with the backend and GPU each pass saw. About 120 s with a display.

| Pass | Browser | Viewport | Must report |
| --- | --- | --- | --- |
| webgpu | headed on the real GPU if `$DISPLAY` is set, else headless SwiftShader | 1280x800 | `backend === "webgpu"` |
| webgl2 | headless, `?backend=webgl` | 1280x800 | `backend === "webgl2"` |
| mobile | headless, `?backend=webgl` | 390x844 | smoke: ready, clouds, tier `low`, screenshot |

```bash
VERIFY_ONLY=webgl2 npm run verify                 # one pass: webgpu | webgl2 | mobile
VERIFY_WEBGPU=swiftshader npm run verify          # software WebGPU even with a display (gpu | swiftshader | skip)
```

## Why it is set up this way

- Real-GPU WebGPU only works headed under WSLg, with `--enable-unsafe-webgpu --use-webgpu-adapter=opengles` (three r187 asks for `featureLevel: "compatibility"` itself). Headless Chrome only offers a SwiftShader WebGPU adapter: it exercises three's WebGPU backend, in software. The summary says which one ran.
- Forced WebGL2 must be a separate session from any `--webgpu` one: `forceWebGL` gets a null context in a session started with WebGPU.
- Browser args are fixed when the agent-browser daemon starts, so each pass closes its session first and again at the end. Run `npx agent-browser close --all` if one is stuck.
- `set viewport` only emulates a size, so the window is opened larger than the viewport; otherwise the screenshot is cropped to the real window.

## What it asserts

Per desktop pass, through `window.__GAME__` (paused, fixed steps): `m1` loads with clouds and blobs; a fast drag through the biggest cloud raises the cloud count; the pieces are still more than the original 3 s later; herding two pieces together and waiting out the cooldown lowers the count; the `empty` scene has no clouds or blobs; rain (`setWeather("rain", 0)`) gives a steady `rainRate > 0` that changes some interaction params, and a 2 s blend back to clear passes through `transition` and ends at `rainRate` 0; `frame` keeps advancing. The mobile pass takes a rain shot with `rainRate > 0`. Counts are compared, never exact numbers, so sim tuning does not break it. Every pass first takes the pointer from the real mouse (`pointerAbsent()` before `loadScene`; the sim resets the cursor on load) and asserts every cloud centre has `densityAt >= cloudThreshold` (the mobile pass too, so faint phone clouds fail). Each desktop pass ends with a real mouse move to a known pixel with the override released, asserting the sim cursor is present within 0.3 units of the expected world point (covers `pointer.ts` / `clientToWorld`). After both desktop passes, the webgpu and webgl2 sequences (cloud counts and rounded cloud centres at load, split, 3 s, merge, empty; then rain's `rainRate` to 3 decimals and weather state) must be identical; `VERIFY_SEQ=1` prints them. Every pass also fails on page errors and console errors; Vite lines are ignored, and three's "WebGPU is not available" warning is expected only in the WebGL2 passes.

Thunder, per desktop pass, after the weather step: a real click on the canvas must leave `audio.state` `"running"` (else the gesture unlock broke). Then `setWeather("thunder", 0)` and one `forceStrike({ intensity: 1, d: 1, x: 0.3 })` must be scheduled, with `scheduledThunderAt - tStrike` equal to `d - outputLatency` within 20 ms (both read in one call). The flash is above 0.5 at the peak (`holdFlash(0)`, shot `{pass}-flash.png`) and under 0.05 2.5 s later in real time, and the strike leaves `getParams()` unchanged. The sequence gets `["thunder", d, peak]`, no latency values, since they differ per backend.

Types, per desktop pass, after thunder: each scene (`m1`, `clear`, `rain`, `thunder`, `mixed`) loads and ticks 200 ms, then holds its mix by dominant type (`m1` only cumulus; `clear` cumulus and stratus; `rain` at least 2 stratus; `thunder` at least 1 cumulonimbus; `mixed` all three), with `getState().types` equal to the `cloudCentres()` tally and every centre at `densityAt >= cloudThreshold`. The per-scene counts (`cumulus/stratus/nimbus`) join the equivalence sequence. Strike anchor: in thunder weather a forced strike with no `x` must land within 3 world units of a cumulonimbus centre. This is the loose check: the harness exposes centres, not blob extents, so it cannot test the anchor's true width. Tier: desktop reports `mid` (the default; `hi` is opt-in), with `getState().render` showing an upload of at most 16,384 bytes, a march target within the 0.5 MP mid cap, no overflowed tile list on a shipped scene and the erosion noise baked (every pass waits for `render.noiseReady` before its first shot); the phone reports what it picked on load (headless has no coarse pointer, so `mid`), then `setTier("low")` must read back `low`. That proves the setter, not the phone's default; a real phone gets `low` from `pickTier`, and `?tier=low` forces it by hand.

## Read the screenshots

A pass is not a look. Open `artifacts/verify/{webgpu,webgl2}-{initial,split,merge,rain,flash,types-clear,types-rain,types-thunder,types-mixed}.png` and `mobile-{initial,rain}.png` and check by eye:

- Clouds are soft 3D volumes: bright tops, shaded blue-grey undersides, translucent edges, a little grain at most (no hard edges, no diagonal hatching on the thin stratus sheets). Mid is the default tier, so mid shots look a little flatter than `?tier=hi`.
- Types shots: cumulus is puffy with volume; stratus is a soft, layered, flat sheet; cumulonimbus is a lit tower with a soft slate base. All three must be distinguishable at a glance.
- The cursor ring is visible after the split.
- Nothing is black or blank; the sky fills the whole screenshot and the clouds are inside it, including on the phone.
- Rain shots: rain streaks are visible; the play clouds are clearly lighter than the sky; the scenery layers show behind them.
- Flash shots: the sky is lifted; the cloud nearest the strike is lit from inside; it is not a white-out, and the rest of the frame stays close to the rain shot.
- WebGPU and WebGL2 look the same. A difference is a bug in one backend.

## Not covered (needs a real iPhone)

- The `touchend` unlock (headless passes only click with the mouse, which fires `pointerdown`).
- The silent switch is respected, and other audio keeps playing (mixing).
- `getOutputTimestamp` and `outputLatency` in Safari, where they may be missing.
- Resume after an interruption (a phone call, the tab backgrounded).
- Whether the thunder is perceived in sync with the flash.

This does not replace `npm run typecheck && npm run lint && npm test`.
