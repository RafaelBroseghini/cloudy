# Player settings

`src/settings` is the model behind the Sky panel: pure TypeScript (only the storage adapter touches `window`). `controller.ts` turns settings into drive calls; `main.ts`, the panel and the harness all go through it. The sliders' mappings are in `sliders.ts`, the scenes in `scenes.ts`, the time-of-day keyframes in `timeOfDay.ts`.

## Why it is shaped this way

- A slider is stored as its 0..1 position, not the field value, so a retuned mapping still reads old saves. Each mapping is monotone and lands inside its field's range (tested), and an unset slider contributes nothing, so with no settings the resolved P is exactly the game before settings existed: `p.snapshot.json` pins it and must never be regenerated (new fields are allowed; old values may not move).
- An unset slider reads its position back from P (`sliderValuesOf`), so it follows the weather blend instead of freezing.
- Time of day goes in the `sky` layer, below the weather, so rain's grey still wins; the midday keyframe is the field defaults, and the sun's x increases along the day so the slider can be read back from it. The other sliders go in the `user` layer, above the weather, and can only hold `USER_KEYS`: a slider cannot reach `strikesEnabled` or a raw interaction field. Squish reaches the sim only as a bounded multiplier, and never touches the merge gate, cursor or type fields.
- The thunder slider is live only in thunder weather (`sliderEnabled`): it sets a rate, never whether strikes exist.
- Applying a scene sets its weather and only its own sliders (clearing the rest) and respawns the clouds when the layout differs or the same scene is applied again. Weather buttons and sliders never respawn: the player's torn clouds survive a tweak. A weather button also clears the rain and thunder sliders so they follow the new weather. Every scene sets the breeze to `SCENE_BREEZE` (nearly windless) so a scene never opens gusty; `DEFAULT_SETTINGS` is the sunny scene, so the first load matches. That makes `breezeSpeed` the one old-default field the snapshot test exempts, besides `volume`.
- `randomize(rng)` is pure; `Math.random` is passed in only at the call site, so the dice are testable and a seed replays a roll.

## Storage (`storage.ts`)

Key `cloudy:settings`, a versioned record holding only the set sliders. Load is read, parse, version check (newer than known means defaults), `migrate`, a Valibot schema, then clamp. An unknown scene id becomes `custom`; anything else invalid gives defaults. Writes are debounced and flushed on `pagehide`. The cloud layout is not stored: it derives from the scene id, else the weather.

Every storage access is in try/catch and reaches `window.localStorage` lazily (private mode, blocked storage, Safari's 7-day wipe), so the game runs on defaults with a clean console. `?reset` forgets saved settings; `?weather=` still wins for the weather. Only the settings API writes; raw `setWeather`, `loadScene` and keys 1..4 do not.
