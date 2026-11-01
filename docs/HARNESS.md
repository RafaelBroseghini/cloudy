# Harness: `window.__GAME__`

Installed always (dev and preview). World units: y up, origin at screen centre, view height 10, width `10 * aspect`.

- `getState()`: `{ ready, backend, frame, step, paused, clouds, blobs, springs, cursor: {x,y,present}, densityAtCursor, view: {width,height} }`. `view` is the visible world size; `cursor` is the sim cursor (what is drawn).
- `pause(on)`: while paused the rAF loop still renders but does not advance the sim.
- `tick(ms)`: advance exactly `round(ms / (1000/60))` fixed steps synchronously (works paused), then refresh the renderer's blobs.
- `pointer(x, y)` / `pointerAbsent()`: override the live pointer (world units) until `pointerRelease()` hands control back to real input.
- `drag(x0, y0, x1, y1, seconds)`: move the overridden pointer linearly over `seconds` of fixed steps, stepping the sim as it goes; leaves the pointer at `(x1, y1)`. Put the pointer at the start and `tick` first so the cursor is already there.
- `loadScene("m1" | "empty")`: reset the sim to a named scene sized to the current view.
- `getParams()` / `setParams(partial)`: read / write sim params (clamped; see `src/sim/params.ts`).
- `cloudCentres()`: `[{ id, x, y, blobs }]`, mass-weighted centre per cloud, to aim a drag.
- `densityAt(x, y)`: the sim's density at a world point. `constants()`: `{ cloudThreshold, influenceFactor }`, the shared values from `src/sim/blobBuffer.ts`; cloud cores must have `densityAt >= cloudThreshold` or they render faint.

Force a split, then a merge (`tau` is the merge cooldown, 1.5 s by default):

```js
const g = __GAME__; g.pause(true); g.loadScene("m1"); g.tick(1000);
const big = g.cloudCentres().sort((a, b) => b.blobs - a.blobs)[0];
g.pointer(big.x - 6, big.y); g.tick(1500); g.drag(big.x - 6, big.y, big.x + 6, big.y, 0.15); // fast drag: clouds goes up
g.tick(3000); /* slowly drag one piece into another, pointerAbsent(), tick past tau: clouds goes down */
```
