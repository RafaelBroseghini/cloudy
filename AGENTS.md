# Cloudy

A 2.5D browser game: a cursor pushes through springy clouds, splits them, and the pieces re-merge on touch. TypeScript, Vite, three.js r187 `WebGPURenderer` with TSL, Box2D v3 (`box2d3-wasm`) for blob springs. Target design and milestones: `docs/PLAN.md`. The code is the source of truth for what exists.

## Setup

Node is not on the non-interactive PATH. Start every shell with:

```bash
export PATH=~/.local/share/fnm/node-versions/v24.18.1/installation/bin:$PATH
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite on http://127.0.0.1:43200 (`?backend=webgl` forces WebGL2) |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | oxlint |
| `npm test` | Vitest + fast-check, node, `src/**/*.test.ts` |
| `npm run build` | typecheck + `vite build` |
| `npm run verify` | Build, then drive the game in a real browser on WebGPU, forced WebGL2 and a phone viewport; screenshots in `artifacts/verify/` |

## Before you finish

- Never assume it works because you wrote it. Run it.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Anything that renders or runs in the browser: run `npm run verify` (skill: `.agents/skills/verify`) and read the screenshots. A pass is not a look.
- Commit messages are conventional: `feat(scope):`, `fix(scope):`, `test:`, `docs:`, `chore:`.

## Architecture rules

- The CPU owns gameplay; the GPU only draws. Nothing is read back from the GPU.
- `src/sim` is pure TypeScript: no `three`, no DOM, runs under node tests. `src/render` draws; it never changes sim state.
- The play layer reaches the renderer only through the blob buffer (`src/sim/blobBuffer.ts`) and per-frame uniforms.
- Rendering uses `three/webgpu` and `three/tsl` only. Do not write WebGPU detection or fallback code; three falls back to WebGL2 itself, and `forceWebGL` is the only switch. Every visual must work on both backends.
- Do not hand-roll what a library does (renderer, physics, noise, schema validation). Adding a dependency needs a reason.
- The sim runs at a fixed 60 Hz step and never reads wall-clock time. Same inputs give the same result at any display rate.
- Wind never acts on the cursor. Lightning never changes sim or interaction parameters.
- Box2D: import `box2d3-wasm/compat` and free returned objects and defs with `.delete()`.

## Driving the game: `window.__GAME__`

Drive and read state through `window.__GAME__` (`src/harness.ts`), never by scraping the DOM or guessing pixels. Add a harness method when a new mechanic needs driving from tests or the verify skill.

## Browser work

- Use `npx agent-browser`, not Playwright. Set your own session first: `export AGENT_BROWSER_SESSION=<task-name>`; end with `npx agent-browser close`.
- Check `console` and `errors` after every run.

## Code conventions

- ESM TypeScript, explicit `.ts` extensions in relative imports, `import type` for types.
- Model states as discriminated unions so illegal states do not compile (weather, pointer present/absent, transitions).
- Tests sit next to code as `*.test.ts`. Prefer fast-check properties for sim invariants (see `docs/PLAN.md`).
- Match the surrounding code. Comments say why, not what.

## Where things are

- `docs/PLAN.md`: target design, milestones, invariants and perf targets.
- `docs/SIM.md`: how the sim maps onto Box2D, where it departs from PLAN, and every param.
- `docs/PARAMS.md`: layer order and the dev panel (`` ` `` or `?dev` opens it; tune any field live).
- `docs/RENDER.md`: render passes, how clouds are lit as 2.5D volumes, quality tiers and costs.
- `docs/HARNESS.md`: the full `window.__GAME__` API with a split-then-merge example.
- `.agents/skills/verify`: browser verification (real WebGPU needs a visible window under WSLg).
- `public/audio/`: thunder clips; every file must be CC0/public domain and credited in `CREDITS.md`.

## Keep this file small

It is loaded into every agent's context. Add a rule only if an agent would get it wrong without it. Put explanations and numbers in `docs/`.
