---
name: verify
description: Verify that Cloudy runs and looks right in a real browser on both render backends. Use after any change to rendering, the sim, input, the harness, or the scene, and before calling work done. Builds the game, drives a split and a merge through window.__GAME__ on WebGPU, forced WebGL2 and a phone viewport, fails on wrong backend, failed asserts or console errors, then tells you how to read the screenshots.
---

# Verify

`npm run verify` builds the game (`vite build`), serves it with `vite preview` on its own port (43210, `VERIFY_PORT` to change; never a dev server) and runs three passes, each in its own agent-browser session (`verify-webgpu`, `verify-webgl2`, `verify-mobile`). It exits non-zero on any failure and prints a summary table with the backend and GPU each pass saw. About 30 s with a display.

| Pass | Browser | Viewport | Must report |
| --- | --- | --- | --- |
| webgpu | headed on the real GPU if `$DISPLAY` is set, else headless SwiftShader | 1280x800 | `backend === "webgpu"` |
| webgl2 | headless, `?backend=webgl` | 1280x800 | `backend === "webgl2"` |
| mobile | headless, `?backend=webgl` | 390x844 | smoke: ready, clouds, screenshot |

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

Per desktop pass, through `window.__GAME__` (paused, fixed steps): `m1` loads with clouds and blobs; a fast drag through the biggest cloud raises the cloud count; the pieces are still more than the original 3 s later; herding two pieces together and waiting out the cooldown lowers the count; the `empty` scene has no clouds or blobs; `frame` keeps advancing. Counts are compared, never exact numbers, so sim tuning does not break it. Every pass first takes the pointer from the real mouse (`pointerAbsent()` before `loadScene`; the sim resets the cursor on load) and asserts every cloud centre has `densityAt >= cloudThreshold` (the mobile pass too, so faint phone clouds fail). Each desktop pass ends with a real mouse move to a known pixel with the override released, asserting the sim cursor is present within 0.3 units of the expected world point (covers `pointer.ts` / `clientToWorld`). After both desktop passes, the webgpu and webgl2 sequences (cloud counts and rounded cloud centres at load, split, 3 s, merge, empty) must be identical; `VERIFY_SEQ=1` prints them. Every pass also fails on page errors and console errors; Vite lines are ignored, and three's "WebGPU is not available" warning is expected only in the WebGL2 passes.

## Read the screenshots

A pass is not a look. Open `artifacts/verify/{webgpu,webgl2}-{initial,split,merge}.png` and `mobile-initial.png` and check by eye:

- Clouds are soft and white with a cool, bluish underside; no hard edges or banding.
- The cursor ring is visible after the split.
- Nothing is black or blank; the sky fills the whole screenshot and the clouds are inside it, including on the phone.
- WebGPU and WebGL2 look the same. A difference is a bug in one backend.

This does not replace `npm run typecheck && npm run lint && npm test`.
