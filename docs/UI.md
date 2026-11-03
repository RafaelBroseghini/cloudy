# Sky panel

`src/ui`: the player's panel, plain DOM and one stylesheet over the settings controller (`docs/SETTINGS.md`). It is a lazy chunk: `main.ts` imports `ui/panel.ts` after the game is ready, so the first frame never waits on the panel, its fonts or Motion.

- `model.ts` (pure) turns settings, slider state and the live weather into what the panel shows, so the panel's logic is testable without a DOM.
- `panel.ts` builds the DOM and repaints in `sync()` once per rendered frame, only when the settings, the target weather or the resolved P changed. That is how keys 1..4, the URL, the harness and the dev panel show up in it, and how unset sliders follow a weather blend.

## State flow

UI event -> the controller -> game; then the panel repaints from the controller and the live weather. The DOM holds no state beyond the fold (`cloudy:ui`, outside the settings schema). When the weather was changed behind the settings (keys 1..4), no scene is pressed and the subtitle says `custom`.

## Look

Tokens are custom properties on `.sky-panel` in `panel.css`; `data-weather` re-points them, so each weather restyles the panel without new rules. Fonts are self-hosted and resolved by Vite so the Pages base path works. On a phone the panel is a bottom sheet that starts folded, with safe-area insets and 44 px targets.

## Drag to fold

The header (with a grab bar on top) drags the panel up open or down shut, following the pointer, and snaps on release to whichever end it is past or was flicked toward (`sheetDrag.ts`). A press must travel a few pixels before it counts as a drag, so the header's buttons still click, and a drag that started on one swallows that button's click. Move and release are heard on the window, because the folded pill is too short to keep the pointer over it. Under reduced motion the snap is instant. The fold button stays the keyboard and screen-reader way to fold.

## Accessibility

Sliders are real `<input type="range">` with a `<label>` and `aria-valuetext` set to the word the panel shows. Weather and scene buttons use `aria-pressed`, the fold `aria-expanded`; Tornado is a disabled button until M4. Focus is always visible. Delete or double-click a slider name to unset it. Keys 1..4 still work with a slider or button focused.

## Reduced motion

`prefers-reduced-motion` is read at each event, so toggling it applies at once: no dice tumble, jiggle, squash or springs; tints and the chevron change instantly. Motion (`motion/mini`) drives the animations; until it loads the panel changes without animating.

## Pointer

The panel is a sibling of the canvas, so moving onto it fires `pointerleave` and the sim cursor goes absent. Pointer events are not stopped, so a click on the panel still unlocks audio.
