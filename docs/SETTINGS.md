# Player settings (M5)

`src/settings` is the model behind the Sky panel: pure TypeScript (no three, no DOM; only the storage adapter touches `window`). `controller.ts` turns settings into drive calls; `main.ts` and the harness call the controller.

## Sliders (0..1 positions, `sliders.ts`)

Each is stored as its 0..1 position and mapped by a monotone, clamped function. A slider the player has not set contributes nothing, so with no settings the resolved P is today's (a test pins it against a snapshot). `sliderValuesOf(P, set)` reads unset ones back from P.

| Slider | Field(s) | Range (0 .. 1) | Notes |
| --- | --- | --- | --- |
| `timeOfDay` | sky colours, sun x/y/size/strength/depth, `cloudLit/Mid/Shade` | keyframes 0 dawn, .25 morning, **.5 midday = defaults**, .78 sunset, 1 purple dusk (`timeOfDay.ts`) | Goes in `Layers.sky`, BELOW the weather, so rain's grey still wins; sun x is strictly increasing (the inverse key). Sunset and dusk put the sun behind the clouds (`skySunDepth` -0.1, -0.15) with warm or rosy tints |
| `breeze` | `breezeSpeed` | 0 .. 1.5 (the field's range) | |
| `puffiness` | `volErosion`, `volHeightCumulus` | .25 .. 1.15, .6 .. 1.7 (.5 = defaults .7 and 1.15) | Erosion carves the billows into the silhouette; the height is how deep a cumulus is along the view axis |
| `rain` | `rainRate` | 0 .. 1 | unset follows the weather |
| `thunder` | `strikeRate` | .07 .. .29 /s | only live in thunder weather (`sliderEnabled`); never sets `strikesEnabled` |
| `depth` | `parallaxStrength` | 0 .. 2 (.5 = today's) | scales the scenery and rain-band parallax and the volume's eye shift: cursor shift and idle sway; 0 is flat (no eye movement). The eye shift saturates smoothly (tanh) toward its largest value, so a high Depth adds mostly near the middle of the screen |
| `squish` | `squish` | .6 .. 1.6 (.5 = 1) | `resolve` divides `k_s` by it, multiplies `c`, `splitStrain` by its root, divides `yieldStrain` by its root (yield stays under .9 split); applied before the dev layer; gate, cursor and type fields untouched |

The user layer (`USER_KEYS`) can hold only those fields. `strikesEnabled`, raw interaction fields and sky colours are type errors there.

## Scenes (`scenes.ts`)

Each = weather + only its own sliders (the rest cleared) + a sim layout. Applying one blends the weather (4 s) and **respawns the clouds** when the layout differs (or when the same scene is applied again). Weather buttons and sliders never respawn.

| id | weather | sliders | layout |
| --- | --- | --- | --- |
| `sunny` | clear | none (= defaults) | `clear` |
| `lone` | clear | timeOfDay .46 | `lone` (one cumulus) |
| `sunset` / `dusk` | clear | timeOfDay .78 / .97 | `clear` |
| `rainy` / `storm` | rain / thunder | none | `rain` / `thunder` |

A weather button (`setWeatherPreset`) changes the weather only and clears the `rain` and `thunder` overrides. `scene` in the settings is a scene id, `custom` (any tweak) or `shuffled` (dice).

## Randomize (`randomize.ts`)

`randomize(rng)` is pure; `Math.random` is only passed in at the call site. Weather clear 50 / rain 28 / thunder 22 %; sun half the time .35..65, else anywhere; breeze .05..9; puffiness .12..97; rain 0 (25 %: up to .3) when clear, else .3..9; thunder .15..9 only in thunder, else 0; depth, squish anywhere; 1..3 clouds (1 is `lone`, else the weather's layout). All sliders are set.

## Storage (`storage.ts`)

Key `cloudy:settings`, value `{ version: 1, weather, scene, sliders }` (sliders: only the set ones). Load: read, `JSON.parse`, version (newer than known: defaults), `migrate(data, from)` (a no-op seam for v1), Valibot schema (unknown keys dropped; an unknown scene id becomes `custom`; an unknown weather or non-number slider means defaults), clamp sliders to 0..1. Writes are debounced 300 ms and flushed on `pagehide`. The layout is not stored: it is derived from the scene id, else the weather (a shuffled lone cloud comes back as the weather's layout).

Every storage access is in try/catch and reaches `window.localStorage` lazily (private mode, blocked storage, Safari's 7-day wipe): the game runs with defaults and a clean console. `?reset` forgets saved settings; `?weather=` still wins for the weather. Only this API writes: raw `setWeather`, `loadScene` and keys 1..4 do not.
