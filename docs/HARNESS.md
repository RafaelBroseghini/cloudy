# Harness: `window.__GAME__`

The API is `GameHarnessApi` in `src/harness.ts`; each method's JSDoc says what it does. This file covers how to use it without fooling yourself. It is installed in dev and preview builds alike.

- World units: y up, origin at the screen centre, view height 10. `getState().view` gives the visible size.
- Determinism: `pause(true)` then `tick`/`drag`. Weather time and scheduled strikes advance with the fixed sim steps, so a paused run gives the same result on any machine and either backend (verify compares them).
- The real mouse wins unless you override it: call `pointerAbsent()` (or `pointer`) before `loadScene` in a headed browser, or the desktop cursor leaks in.
- Audio unlocks only on real input (agent-browser `mouse` / `click`), never on a scripted event. Until then strikes flash with no thunder (`skippedReason: "locked"`).
- Changing weather never respawns clouds: call `loadScene` after `setWeather` to see that weather's own composition.
- Before a screenshot, wait for `getState().render.noiseReady` (the clouds are smooth ellipsoids for the first second) and for the Sky panel's `ui().ready` if it matters.
- `debugView` and `debugEye` are for measurements: they show the frame ungraded and with no bloom (see `docs/RENDER.md`).
- Only the settings calls (`setSlider`, `applyScene`, `randomize`, ...) persist to localStorage. Raw `setWeather`, `loadScene` and keys 1..4 do not.
- `bench` only means something headed on a real GPU, and only against another build in the same session.

Force a split, then a merge (`tau` is the merge cooldown):

```js
const g = __GAME__; g.pause(true); g.pointerAbsent(); g.loadScene("m1"); g.tick(1000);
const big = g.cloudCentres().sort((a, b) => b.blobs - a.blobs)[0];
g.pointer(big.x - 6, big.y); g.tick(1500); g.drag(big.x - 6, big.y, big.x + 6, big.y, 0.15); // fast drag: clouds goes up
g.tick(3000); /* slowly drag one piece into another, pointerAbsent(), tick past tau: clouds goes down */
```

Rain, paused and deterministic:

```js
const g = __GAME__; g.pause(true); g.loadScene("m1");
g.setWeather("rain", 4); g.tick(2000);   // halfway: getState().weather is a transition at progress 0.5
g.tick(2100);                            // steady rain
g.resolved().windX; g.getParams().k_s;   // resolved P, and the sim's interaction params
```

Thunder, after a real click has unlocked audio:

```js
const g = __GAME__; g.getState().audio;                  // state "running"
const r = g.forceStrike({ intensity: 1, d: 1.5, x: 0.3 }); // r.scheduledThunderAt - r.tStrike = r.d - r.latency
g.holdFlash(0); /* screenshot at the flash peak */ g.holdFlash(null);
```
