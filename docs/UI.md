# Sky panel (M5 part 2)

`src/ui`: the player's panel, plain DOM + one stylesheet over the settings controller (`docs/SETTINGS.md`). A lazy chunk: `main.ts` imports `ui/panel.ts` after the game is ready, so the base bundle gains nothing (panel JS 11 kB, CSS 9 kB, Motion mini 8 kB, four woff2 fonts 65 kB, all fetched after first render).

- `model.ts` (pure): `panelView({ weather, settings, sliders })` gives the subtitle (`Midday · rain · custom`), pressed pebble and scene, one row per slider (word, `disabled` from `sliderState().enabled`). `thumb.ts`: scene thumbnails as CSS. `uiState.ts`: the fold in `localStorage` `cloudy:ui` (outside the settings schema; a phone always starts folded). `icons.ts`, `motion.ts`.
- `panel.ts`: builds the DOM, wires events, `sync()` per rendered frame repaints only when the settings object, the target weather or the resolved P changed (so keys 1..4, URL, harness and dev panel show up, and unset sliders follow the weather blend).

## State flow

UI event -> `SkyPanelHost` (the controller: `setSlider`, `clearSlider`, `applyScene`, `setWeatherPreset`, `randomize`, `reset`) -> game; then the panel repaints from `settings()`, `sliderState()` and the live weather. The DOM never holds state beyond the fold. `Math.random` appears only in `main.ts` (the dice) and the cosmetic die face. When the weather was moved behind the settings (keys 1..4) no scene chip is pressed and the subtitle says `custom`.

## Look

Tokens are custom properties on `.sky-panel` in `panel.css`; `data-weather` re-points them (light glass, slate for rain, dark for thunder and tornado). Fonts Fredoka 500 and Nunito 400/600/700, latin only, `font-display: swap`, resolved by Vite so a base path works. Phone (<= 560 px wide, or <= 480 px tall): bottom sheet with 16 px gutters and safe-area insets, `max-height` 100dvh - 64px, internal scroll, 44 px targets.

## Accessibility

Sliders are real `<input type="range">` with a `<label>` and `aria-valuetext` = the word (the visible word is `aria-hidden`); the thunder slider is `disabled` outside thunder. Weather and scene buttons use `aria-pressed`, the fold `aria-expanded`/`aria-controls`; Tornado is a disabled button. Buttons have `:focus-visible` outlines; a focused handle swaps to an amber-outlined cloud image (no square ring). Delete or double-click a slider name to unset it. Keys 1..4 still work with a slider or button focused.

## Reduced motion

`prefers-reduced-motion` is read at each event: no dice tumble (the face just swaps), no icon jiggle, no handle squash or press springs, instant panel tint and chevron. Motion (`motion/mini`, springs on WAAPI) drives the tumble, the press feedback and the handle's `--sx`/`--sy` (registered with `@property`); until it loads the panel just changes without animating.

## Pointer

The panel is a sibling of the canvas: moving the mouse onto it fires `pointerleave` on the canvas, so the sim cursor is absent. Pointer events are not stopped, so a click on the panel still unlocks audio.
