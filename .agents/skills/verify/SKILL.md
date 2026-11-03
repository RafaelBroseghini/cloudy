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

The checks live in `scripts/verify.mjs` (`STEPS` and the pass loop); read it for specifics. In outline, each desktop pass, paused and on fixed steps: load, split, persist, merge and empty; rain and a blend back to clear; thunder (a real click must unlock audio; thunder is scheduled `d - outputLatency` after the flash peak; the flash peaks and decays; a strike leaves the sim params unchanged); each scene's cloud-type mix; the default tier and `render` stats inside budget; a real mouse move landing on the sim cursor. Every cloud centre must be dense enough to render solid. The webgpu and webgl2 sequences must be identical (`VERIFY_SEQ=1` prints them), and any page or console error fails the pass. Counts are compared, never exact numbers, so sim tuning does not break it. The phone pass is a smoke test: headless has no coarse pointer, so it proves `setTier("low")`, not the phone's default.

## Read the screenshots

A pass is not a look. Open `artifacts/verify/{webgpu,webgl2}-{initial,split,merge,rain,flash,types-clear,types-rain,types-thunder,types-mixed}.png` and `mobile-{initial,rain}.png` and check by eye:

- Clouds are soft 3D volumes: bright tops, shaded blue-grey undersides, translucent edges, a little grain at most (no hard edges, no diagonal hatching on the thin stratus sheets). Mid is the default tier, so mid shots look a little flatter than `?tier=hi`.
- Types shots: cumulus is puffy with volume; stratus is a soft, layered, flat sheet; cumulonimbus is a cauliflower tower with a wide sheared anvil, a sunlit top and a flat, darker, slightly ragged base. All three must be distinguishable at a glance.
- The cursor ring is visible after the split.
- Nothing is black or blank; the sky fills the whole screenshot and the clouds are inside it, including on the phone.
- Rain shots: rain streaks are visible; the play clouds are clearly lighter than the sky; the scenery layers show behind them.
- Flash shots: the sky is lifted; the cloud nearest the strike is lit from inside; it is not a white-out, and the rest of the frame stays close to the rain shot.
- Bloom: only the hottest rims and a flash glow. A haze or halo around ordinary sunlit cloud faces means the threshold is too low.
- WebGPU and WebGL2 look the same. A difference is a bug in one backend.

## Not covered (needs a real iPhone)

- The `touchend` unlock (headless passes only click with the mouse, which fires `pointerdown`).
- The silent switch is respected, and other audio keeps playing (mixing).
- `getOutputTimestamp` and `outputLatency` in Safari, where they may be missing.
- Resume after an interruption (a phone call, the tab backgrounded).
- Whether the thunder is perceived in sync with the flash.

This does not replace `npm run typecheck && npm run lint && npm test`.
