# Harness: `window.__GAME__`

Installed always (dev and preview). World units: y up, origin at screen centre, view height 10, width `10 * aspect`.

- `getState()`: `{ ready, backend, frame, step, paused, clouds, blobs, springs, cursor: {x,y,present}, densityAtCursor, view: {width,height}, weather, rainRate }`. `view` is the visible world size; `cursor` is the sim cursor (what is drawn). `weather` is `{ kind: "steady", state, progress: 1 }` or `{ kind: "transition", from, to, progress }` (progress 0..1, linear in weather time; the blend weight is its smoothstep). `rainRate` is the resolved `P.rainRate` right now. `audio` is `{ state, outputLatency }`: the AudioContext state (`"none"` until the first pointerdown/touchend/keydown creates it, then `"running"`, `"suspended"`, ...) and its output latency in seconds (null if unknown). `strikes` is `{ count, last }`, `last` the latest strike record (see `forceStrike`) or null.
- `pause(on)`: while paused the rAF loop still renders but does not advance the sim.
- `tick(ms)`: advance exactly `round(ms / (1000/60))` fixed steps synchronously (works paused), then refresh the renderer's blobs and look. Weather time advances by one `FIXED_DT` per step, so `tick(ms)` moves a weather transition by the same ms and a paused harness run is deterministic. `drag` does the same.
- `pointer(x, y)` / `pointerAbsent()`: override the live pointer (world units) until `pointerRelease()` hands control back to real input.
- `drag(x0, y0, x1, y1, seconds)`: move the overridden pointer linearly over `seconds` of fixed steps, stepping the sim as it goes; leaves the pointer at `(x1, y1)`. Put the pointer at the start and `tick` first so the cursor is already there.
- `loadScene("m1" | "empty")`: reset the sim to a named scene sized to the current view.
- `setWeather(state, seconds)`: `state` is `"clear" | "rain" | "thunder" | "tornado"`; start a blend to it over `seconds` of weather time (0 = instant). From mid-blend it restarts from the current values (no jump); asking for the state already being approached is ignored. Also on the URL (`?weather=rain`, initial state) and keys 1..4 (4 s blends).
- `forceStrike({ intensity?, d?, x? })`: fire a strike now and return its record `{ id, tStrike, clock, d, intensity, x, latency, scheduledThunderAt, skippedReason }`. `intensity` 0..1, `d` seconds from flash peak to thunder, `x` 0..1 across the screen; missing fields are drawn from a separate seeded stream. `tStrike` is the flash PEAK, 0.1 s ahead of the clock `clock` (`"audio"`: AudioContext render clock; `"perf"`: `performance.now()/1000`, used while audio is locked). `scheduledThunderAt = tStrike + d - latency` on the audio clock, or null with `skippedReason` one of `locked | late | not-loaded | voice-cap`. Scheduled strikes (thunder weather, `strikeRate`) fire from the fixed steps, so `tick` advances them too; they are stamped with the real clock when they fire.
- `flash()`: the current flash value (0..1) read off the strike clock (what `fxFlash` is). `holdFlash(tau | null)`: freeze the latest strike's flash at `tau` seconds from its peak (negative = during the rise, peak = 0) for screenshots; `null` releases.
- `resolved()`: the full flat resolved `P` (every field, numbers) as the game sees it now: defaults + scene + weather (+ user + dev + transient).
- `setDev(partial)` / `clearDev(keys?)` / `getDev()`: the dev layer (any field, interaction included; the dev panel drives the same one). `setDev` clamps each value to its range and ignores non-finite ones; overrides persist across weather changes and win over weather/user, but the strike flash (lighting/post-FX only) still goes on top. `clearDev()` drops all overrides, `clearDev(["k_s"])` just those keys (they fall back to weather). `getDev()` is a copy of what is stored; `resolved()` shows the effect, including the `d_touch < d_release` clamp. Open the panel with ` or `?dev`.
- `getParams()` / `setParams(partial)`: read / write sim interaction params (clamped; see `src/sim/params.ts`). `getParams()` returns the resolved weather values, because the game pushes `interactionOf(P)` to the sim whenever it changes. A manual `setParams` lasts until the next weather-driven change.
- `cloudCentres()`: `[{ id, x, y, blobs }]`, mass-weighted centre per cloud, to aim a drag.
- `densityAt(x, y)`: the sim's density at a world point. `constants()`: `{ cloudThreshold, influenceFactor }`, the shared values from `src/sim/blobBuffer.ts`; cloud cores must have `densityAt >= cloudThreshold` or they render faint.

Force a split, then a merge (`tau` is the merge cooldown, 1.5 s by default):

```js
const g = __GAME__; g.pause(true); g.loadScene("m1"); g.tick(1000);
const big = g.cloudCentres().sort((a, b) => b.blobs - a.blobs)[0];
g.pointer(big.x - 6, big.y); g.tick(1500); g.drag(big.x - 6, big.y, big.x + 6, big.y, 0.15); // fast drag: clouds goes up
g.tick(3000); /* slowly drag one piece into another, pointerAbsent(), tick past tau: clouds goes down */
```

Rain, paused and deterministic (the rain look needs a few rendered frames to settle; weather time follows `tick`):

```js
const g = __GAME__; g.pause(true); g.loadScene("m1");
g.setWeather("rain", 4); g.tick(2000);   // halfway: getState().weather = { kind: "transition", progress: 0.5, ... }
g.tick(2100);                            // done: { kind: "steady", state: "rain", progress: 1 }, rainRate 0.7
g.resolved().windX; g.getParams().k_s;   // resolved P, and the sim's interaction params (weather's values)
```

Thunder, audio unlocked by a real click (the pointer events must be real input, e.g. `agent-browser mouse move/down/up`):

```js
const g = __GAME__; g.getState().audio;                  // { state: "running", outputLatency: 0.1 } after the click
const r = g.forceStrike({ intensity: 1, d: 1.5, x: 0.3 }); // r.scheduledThunderAt - r.tStrike = r.d - r.latency
g.holdFlash(0); /* screenshot at the flash peak */ g.holdFlash(null);
```
