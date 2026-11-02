// End-to-end check of the built game in a real browser. Drives window.__GAME__ through a split and a merge on each
// backend, screenshots the result and exits non-zero on any failed assert, page error or console error.
//
//   npm run verify                       every pass
//   VERIFY_ONLY=webgl2 npm run verify    one pass: webgpu | webgl2 | mobile
//   VERIFY_WEBGPU=gpu|swiftshader|skip   override how the webgpu pass gets its adapter (default: gpu if $DISPLAY is set)
//   VERIFY_PORT=43210                    port for the preview server
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const PORT = process.env.VERIFY_PORT ?? "43210"
const APP = `http://127.0.0.1:${PORT}/`
const OUT = join(ROOT, "artifacts", "verify")
const ONLY = process.env.VERIFY_ONLY
const WEBGPU_MODE = process.env.VERIFY_WEBGPU ?? (process.env.DISPLAY ? "gpu" : "swiftshader")
const READY_TIMEOUT_MS = 60_000

// Console errors that are not our bug. Anything else at [error] level fails the pass.
const HARMLESS_ERRORS = [
  { re: /favicon\.ico/, why: "the page ships no favicon" },
]
// Warnings are only printed, never failing, except these which mean the wrong backend ran.
const WEBGPU_UNAVAILABLE = /WebGPU is not available/

const PASSES = [
  { name: "webgpu", w: 1280, h: 800, query: "", expect: "webgpu" },
  { name: "webgl2", w: 1280, h: 800, query: "?backend=webgl", expect: "webgl2" },
  { name: "mobile", w: 390, h: 844, query: "?backend=webgl", expect: "webgl2", smoke: true },
].filter((p) => !ONLY || p.name === ONLY)
if (ONLY && PASSES.length === 0) throw new Error(`VERIFY_ONLY=${ONLY}: expected webgpu, webgl2 or mobile`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// What each scene must hold, by dominant type (SIM.md, "Scene shapes"). Minimums, so sim tuning does not break it.
const TYPE_RULES = {
  m1: { what: "only cumulus", ok: (t) => t.cumulus >= 1 && t.stratus === 0 && t.cumulonimbus === 0 },
  clear: { what: "cumulus and at least one stratus", ok: (t) => t.cumulus >= 1 && t.stratus >= 1 },
  rain: { what: "at least 2 stratus", ok: (t) => t.stratus >= 2 },
  thunder: { what: "at least 1 cumulonimbus", ok: (t) => t.cumulonimbus >= 1 },
  mixed: { what: "all three types", ok: (t) => t.cumulus >= 1 && t.stratus >= 1 && t.cumulonimbus >= 1 },
}

// Each pass is its own agent-browser session (its own daemon), because browser args and --webgpu are fixed at daemon
// start and forced WebGL2 needs a session that never asked for WebGPU.
function makeAb(pass, mode) {
  const env = { ...process.env, AGENT_BROWSER_SESSION: `verify-${pass.name}` }
  delete env.AGENT_BROWSER_ARGS
  delete env.AGENT_BROWSER_WEBGPU
  const flags = []
  // `set viewport` only emulates a size; the compositor still draws no more than the real window, and the real window has
  // its own chrome and a minimum width. Open it bigger than the viewport so the emulated size is the one on screen.
  const args = [`--window-size=${Math.max(pass.w, 600)},${pass.h + 200}`]
  if (pass.name === "webgpu" && mode === "gpu") {
    flags.push("--headed")
    args.push("--enable-unsafe-webgpu", "--use-webgpu-adapter=opengles")
  } else if (pass.name === "webgpu") {
    flags.push("--webgpu")
  }
  env.AGENT_BROWSER_ARGS = args.join("\n")
  const run = (...args) =>
    execFileSync("npx", ["agent-browser", ...args], { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 })
  return {
    run,
    open: (url) => run(...flags, "open", url),
    // Evaluate an expression that returns a JSON string; give back the parsed value.
    json(expr) {
      const out = run("eval", expr).trim()
      let v = JSON.parse(out)
      if (typeof v === "string") v = JSON.parse(v)
      return v
    },
    close() {
      try {
        run("close")
      } catch {
        // Not running.
      }
    },
  }
}

const game = (body) => `(() => { const g = window.__GAME__; ${body} })()`
// `sig` fingerprints where the clouds are (rounded centres), so passes can be compared for identical play.
const snap = `const s = g.getState(); const sig = g.cloudCentres().map((c) => c.id + ":" + c.blobs + ":" + c.x.toFixed(2) + ":" + c.y.toFixed(2)).join(" ");
  return JSON.stringify({ clouds: s.clouds, blobs: s.blobs, frame: s.frame, backend: s.backend, sig })`

const STEPS = {
  // The webgpu pass is headed on the real desktop and tick falls back to real input unless overridden, so take the pointer
  // away from the real mouse before anything steps; loadScene resets the cursor too.
  load: game(`g.pause(true); g.pointerAbsent(); g.loadScene("m1"); g.tick(1000); ${snap}`),
  // Every cloud centre must sit in dense enough field to render solid (density >= the shared edge threshold).
  density: game(`
    const k = g.constants();
    return JSON.stringify({ threshold: k.cloudThreshold, centres: g.cloudCentres().map((c) => ({ id: c.id, rho: g.densityAt(c.x, c.y) })) })`),
  // A fast drag straight through the middle of the biggest cloud tears it; if that misses, once more across it.
  split: game(`
    const before = g.getState().clouds;
    const view = g.getState().view;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      if (g.getState().clouds > before) break;
      const big = g.cloudCentres().sort((a, b) => b.blobs - a.blobs)[0];
      // Just clear of the cloud's edge (about 0.4 * sqrt(blobs) wide at the default spacing), so only it is torn.
      const reach = Math.min(1.6 * Math.sqrt(0.16 * big.blobs) + 1, (dx ? view.width : view.height) / 2 + 1);
      g.pointer(big.x - dx * reach, big.y - dy * reach); g.tick(1500);
      g.drag(big.x - dx * reach, big.y - dy * reach, big.x + dx * reach, big.y + dy * reach, 0.15);
    }
    ${snap}`),
  persist: game(`g.pointerAbsent(); g.tick(3000); ${snap}`),
  // Herd the two closest pieces into each other (the lighter one towards the heavier), then let go past tau. A few tries:
  // where the pieces end up after a split is the sim's business, not this script's.
  merge: (peak) => game(`
    const peak = ${peak};
    for (let k = 0; k < 5 && g.getState().clouds >= peak; k++) {
      const cs = g.cloudCentres();
      let best = null;
      for (const p of cs) for (const q of cs) {
        if (p.id === q.id || p.blobs < q.blobs) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || d < best.d) best = { a: p, b: q, d };
      }
      if (!best) break;
      const { a, b } = best, d = best.d || 1;
      const sx = b.x + ((b.x - a.x) / d) * 2.5, sy = b.y + ((b.y - a.y) / d) * 2.5;
      g.pointer(sx, sy); g.tick(800);
      g.drag(sx, sy, a.x, a.y, 1.5);
      g.pointerAbsent(); g.tick(2500);
    }
    ${snap}`),
  empty: game(`g.loadScene("empty"); g.tick(500); ${snap}`),
  params: game(`return JSON.stringify(g.getParams())`),
  // The Sky panel is a lazy chunk, so ui() reports ready:false for a moment after load.
  ui: game(`return JSON.stringify(g.ui())`),
  panelOpen: (open) => game(`g.setPanelOpen(${open}); return JSON.stringify(g.ui())`),
  // Rain at once (0 s blend). Desktop reloads m1 first, since the earlier steps left the sim empty.
  rain: (ms, reload) => game(`
    ${reload ? `g.pointerAbsent(); g.loadScene("m1");` : ""} g.setWeather("rain", 0); g.tick(${ms});
    return JSON.stringify({ weather: g.getState().weather, rainRate: g.getState().rainRate, params: g.getParams() })`),
  // A 2 s blend back to clear: a transition at 1 s, steady clear at 2.5 s.
  clearStart: game(`g.setWeather("clear", 2); g.tick(1000); return JSON.stringify({ weather: g.getState().weather, rainRate: g.getState().rainRate })`),
  clearEnd: game(`g.tick(1500); return JSON.stringify({ weather: g.getState().weather, rainRate: g.getState().rainRate })`),
  // Thunder: take the pointer back from the real click that unlocked audio, then thunder weather and 500 ms of steps.
  thunderOn: game(`g.pointerAbsent(); g.setWeather("thunder", 0); g.tick(500); return JSON.stringify({ audio: g.getState().audio, weather: g.getState().weather })`),
  // The output latency is read in the same call as the strike: Chrome moves outputLatency between reads, and the strike
  // used the value at fire time.
  strike: game(`const r = g.forceStrike({ intensity: 1, d: 1.0, x: 0.3 }); return JSON.stringify({ r, audio: g.getState().audio })`),
  // Freeze the strike at its flash peak (tau 0) for the screenshot.
  holdPeak: game(`g.holdFlash(0); return JSON.stringify(g.flash())`),
  holdRelease: game(`g.holdFlash(null); return JSON.stringify(g.flash())`),
  flash: game(`return JSON.stringify(g.flash())`),
  thunderEnd: game(`g.setWeather("clear", 0); g.tick(100); return JSON.stringify(g.getState().weather)`),
  // A scene's own mix: loaded in the clear weather it is drawn in, 200 ms of steps, then each centre's type and density.
  types: (name) => game(`
    g.pointerAbsent(); g.loadScene("${name}"); g.tick(200);
    const s = g.getState();
    return JSON.stringify({
      threshold: g.constants().cloudThreshold,
      clouds: s.clouds,
      types: s.types,
      centres: g.cloudCentres().map((c) => ({ id: c.id, type: c.type, rho: g.densityAt(c.x, c.y) })),
    })`),
  // No x given: the strike must start inside a cumulonimbus. Thunder weather is set before the scene so the storm mix shows.
  anchor: game(`
    g.pointerAbsent(); g.setWeather("thunder", 0); g.loadScene("thunder"); g.tick(200);
    const r = g.forceStrike({ intensity: 1 });
    const s = g.getState();
    return JSON.stringify({
      x: r.x, wx: (r.x - 0.5) * s.view.width,
      nimbi: g.cloudCentres().filter((c) => c.type === "cumulonimbus").map((c) => ({ x: c.x, y: c.y })),
    })`),
  tier: game(`return JSON.stringify({ tier: g.getState().tier })`),
  // Headless has no coarse pointer, so a phone-sized load may pick "hi": report what it picked, then set "low" and read it back.
  tierLow: game(`const picked = g.getState().tier; if (picked !== "low") g.setTier("low"); return JSON.stringify({ picked, tier: g.getState().tier })`),
  // Back to the state the real-mouse step has always run in: clear weather, m1, pointer released from the harness.
  reset: game(`g.setWeather("clear", 0); g.pointerAbsent(); g.loadScene("m1"); g.tick(200); return JSON.stringify({ clouds: g.getState().clouds })`),
  state: game(snap),
  // Real mouse path: the harness override is released, so tick reads pointer.ts / clientToWorld. Called after a real move.
  realInput: game(`
    g.pointerRelease(); g.tick(100);
    const s = g.getState();
    const out = JSON.stringify({ cursor: s.cursor, view: s.view });
    g.pointerAbsent();
    return out`),
}

// The GPU behind the page. Chrome hides WebGPU adapter info and requestAdapter can stall a busy software-rendered page,
// so this reads the WebGL renderer string, which names the same device.
const ADAPTER = `(() => {
  try { const c = document.createElement("canvas").getContext("webgl2"); return JSON.stringify(c.getParameter(c.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL)); } catch { return JSON.stringify("unknown"); }
})()`

async function runPass(pass, report) {
  const mode = pass.name === "webgpu" ? WEBGPU_MODE : "-"
  const failures = []
  const seq = []
  const row = { pass: pass.name, backend: "-", adapter: "-", ok: false, note: "", trail: "", core: NaN, seq }
  report.push(row)
  if (pass.name === "webgpu" && mode === "skip") {
    row.ok = true
    row.note = "skipped"
    return
  }
  const fail = (msg) => failures.push(msg)
  const expect = (cond, msg) => {
    if (!cond) fail(msg)
    return cond
  }
  // Every cloud centre must sit in dense enough field to render solid; `where` names the scene in the message.
  const denseCentres = (dens, where) => {
    for (const c of dens.centres) {
      expect(c.rho >= dens.threshold, `${where}cloud ${c.id} centre density ${c.rho.toFixed(3)} is below the render threshold ${dens.threshold}: it would draw faint`)
    }
  }
  const ab = makeAb(pass, mode)
  const shot = (step) => {
    const path = join(OUT, `${pass.name}-${step}.png`)
    ab.run("screenshot", path)
    console.log(`  ${path}`)
  }
  ab.close() // a leftover daemon would keep its old env
  try {
    // Open first: any other command starts the daemon, and a daemon started without the open flags is headless.
    ab.open(APP + pass.query)
    ab.run("set", "viewport", String(pass.w), String(pass.h))
    let ready = false
    const t0 = Date.now()
    while (!ready && Date.now() - t0 < READY_TIMEOUT_MS) {
      try {
        // Scenes are sized to the view, so also wait for the resize to land before loading one.
        ready = ab.json(`(() => { const s = window.__GAME__?.getState(); return JSON.stringify(!!s && s.ready && Math.abs(s.view.width / s.view.height - ${pass.w / pass.h}) < 0.01) })()`)
      } catch {
        // Page still loading.
      }
      if (!ready) await sleep(500)
    }
    if (!ready) throw new Error(`window.__GAME__ not ready after ${READY_TIMEOUT_MS / 1000}s`)

    const first = ab.json(STEPS.state)
    row.backend = first.backend ?? "none"
    if (!expect(first.backend === pass.expect, `backend is ${first.backend}, expected ${pass.expect}${hint(pass, mode, first.backend)}`)) {
      throw new Error("wrong backend, skipping the rest of this pass")
    }
    if (mode === "swiftshader") row.note = "software adapter"

    const loaded = ab.json(STEPS.load)
    const clear = ab.json(STEPS.params) // clear-weather params, before any rain
    const trail = [`load ${loaded.clouds}`]
    const step = (name, v) => (trail.push(`${name} ${v.clouds}`), (row.trail = trail.join(", ")), seq.push([name, v.clouds, v.sig]), v)
    expect(loaded.clouds >= 1, `m1 loaded ${loaded.clouds} clouds`)
    expect(loaded.blobs > 0, `m1 loaded ${loaded.blobs} blobs`)
    const dens = ab.json(STEPS.density)
    row.core = Math.min(...dens.centres.map((c) => c.rho))
    denseCentres(dens, "")
    seq.push(["load", loaded.clouds, loaded.sig])
    if (pass.smoke) {
      // The phone's tier, before its first shot so the phone screenshots render at the tier it asserts.
      const t = ab.json(STEPS.tierLow)
      console.log(`  mobile tier: picked ${t.picked} on load, ${t.tier} after setTier("low")`)
      expect(t.tier === "low", `phone tier is ${t.tier} after setTier("low"), expected low`)
    }
    await sleep(300) // a frame or two of the loaded scene
    shot("initial")

    // Sky panel: built after the game is ready, folded on the phone, seven sliders, thunder off outside thunder weather.
    let ui = ab.json(STEPS.ui)
    for (let i = 0; i < 20 && !ui.ready; i++) {
      await sleep(500)
      ui = ab.json(STEPS.ui)
    }
    expect(ui.ready, "the Sky panel never became ready")
    expect(ui.open === !pass.smoke, `the Sky panel starts ${ui.open ? "open" : "folded"} on ${pass.name}, expected ${pass.smoke ? "folded (phone)" : "open"}`)
    expect(ui.sliders.length === 7, `the Sky panel has ${ui.sliders.length} sliders, expected 7`)
    const th = ui.sliders.find((r) => r.key === "thunder")
    expect(th && th.disabled && th.word === "Storm weather only", `the thunder slider outside thunder weather: ${JSON.stringify(th)}`)
    if (pass.smoke) {
      ab.json(STEPS.panelOpen(true))
      await sleep(400)
    }
    shot("panel")
    if (pass.smoke) ab.json(STEPS.panelOpen(false))

    if (pass.smoke) {
      const rain = ab.json(STEPS.rain(500, false))
      expect(rain.rainRate > 0, `rain on the phone has rainRate ${rain.rainRate}`)
      await sleep(300)
      shot("rain")
      return
    }

    const split = step("split", ab.json(STEPS.split))
    expect(split.clouds > loaded.clouds, `a fast drag did not split: clouds ${loaded.clouds} -> ${split.clouds}`)
    await sleep(300)
    shot("split")

    const persist = step("3s", ab.json(STEPS.persist))
    expect(persist.clouds > loaded.clouds, `pieces did not persist: clouds ${loaded.clouds} -> ${split.clouds} at the split -> ${persist.clouds} 3s later`)

    const merged = step("merge", ab.json(STEPS.merge(split.clouds)))
    expect(merged.clouds < split.clouds, `pieces never merged: clouds ${split.clouds} at the split, ${merged.clouds} after herding`)
    await sleep(300)
    shot("merge")

    const empty = step("empty", ab.json(STEPS.empty))
    expect(empty.clouds === 0, `the empty scene has ${empty.clouds} clouds`)
    expect(empty.blobs === 0, `the empty scene has ${empty.blobs} blobs`)

    // Weather: rain at once, then a 2 s blend back to clear. Rain must change the look and the interaction params.
    const rain = ab.json(STEPS.rain(1000, true))
    expect(rain.weather.kind === "steady" && rain.weather.state === "rain", `setWeather("rain", 0) left weather ${JSON.stringify(rain.weather)}`)
    expect(rain.rainRate > 0, `rain has rainRate ${rain.rainRate}`)
    const moved = Object.keys(clear).filter((k) => clear[k] !== rain.params[k])
    expect(moved.length > 0, "rain changed no interaction param from clear")
    seq.push(["rain", rain.rainRate.toFixed(3), rain.weather])
    await sleep(300)
    shot("rain")
    const fading = ab.json(STEPS.clearStart)
    expect(fading.weather.kind === "transition", `a 2 s blend to clear, 1 s in, is ${JSON.stringify(fading.weather)}, not a transition`)
    const cleared = ab.json(STEPS.clearEnd)
    expect(cleared.weather.kind === "steady" && cleared.weather.state === "clear" && cleared.rainRate === 0, `after the blend to clear: ${JSON.stringify(cleared)}`)

    // Thunder. Audio unlocks only from a real gesture: a click on the canvas (installUnlock listens for pointerdown).
    ab.run("click", "canvas")
    await sleep(500) // the clips decode once the context exists; a strike before that is skipped as not-loaded
    const on = ab.json(STEPS.thunderOn)
    expect(on.audio.state === "running", `audio is ${on.audio.state} after a real click on the canvas: the gesture unlock broke (pointerdown/touchend/keydown in src/audio/engine.ts)`)
    const before = ab.json(STEPS.params)
    const { r, audio } = ab.json(STEPS.strike)
    expect(r.scheduledThunderAt !== null, `thunder was not scheduled: skippedReason ${r.skippedReason}`)
    // StrikeSync: thunder is heard d after the flash peak, so it starts d - outputLatency after the peak.
    const latency = audio.outputLatency ?? 0
    const lead = r.scheduledThunderAt === null ? NaN : r.scheduledThunderAt - r.tStrike
    console.log(`  thunder: scheduledThunderAt - tStrike ${lead.toFixed(4)} s (d ${r.d}, outputLatency ${audio.outputLatency} s, record latency ${r.latency} s)`)
    expect(Math.abs(lead - (r.d - latency)) < 0.02, `thunder starts ${lead.toFixed(4)} s after the flash peak, expected d - outputLatency = ${(r.d - latency).toFixed(4)} s`)
    const peak = ab.json(STEPS.holdPeak)
    expect(peak > 0.5, `flash at the peak is ${peak}, expected above 0.5`)
    await sleep(300) // a few rendered frames with the held peak, so the flash reaches the transient layer
    shot("flash")
    const lit = ab.json(STEPS.params)
    const litChanged = Object.keys(before).filter((k) => before[k] !== lit[k])
    expect(litChanged.length === 0, `the lit flash changed interaction params: ${litChanged.join(", ")}`)
    ab.json(STEPS.holdRelease)
    await sleep(2500) // the flash runs on the strike clock (real time); tick does not age it
    const tail = ab.json(STEPS.flash)
    expect(tail < 0.05, `flash 2.5 s after the peak is ${tail}, expected under 0.05`)
    const after = ab.json(STEPS.params)
    const changed = Object.keys(before).filter((k) => before[k] !== after[k])
    expect(changed.length === 0, `a strike changed interaction params: ${changed.join(", ")}`)
    seq.push(["thunder", r.d, Math.round(peak * 100) / 100])
    ab.json(STEPS.thunderEnd)

    // Types: each scene's mix by dominant type, every centre dense enough, and the screenshots of the non-m1 scenes.
    const mixes = []
    for (const [name, rule] of Object.entries(TYPE_RULES)) {
      const t = ab.json(STEPS.types(name))
      expect(t.clouds >= 1, `${name} loaded ${t.clouds} clouds`)
      expect(rule.ok(t.types), `${name} should have ${rule.what}, got ${JSON.stringify(t.types)}`)
      const tally = { cumulus: 0, stratus: 0, cumulonimbus: 0 }
      for (const c of t.centres) tally[c.type] += 1
      expect(Object.keys(tally).every((k) => tally[k] === t.types[k]), `${name}: cloudCentres() types ${JSON.stringify(tally)} disagree with getState().types ${JSON.stringify(t.types)}`)
      denseCentres(t, `${name}: `)
      mixes.push(`${name}:${t.types.cumulus}/${t.types.stratus}/${t.types.cumulonimbus}`)
      if (name !== "m1") {
        await sleep(300)
        shot(`types-${name}`)
      }
    }
    seq.push(["types", mixes.join(" ")])
    console.log(`  types (cumulus/stratus/nimbus): ${mixes.join(" ")}`)

    // Strike anchor: thunder weather, then a forced strike with no x must land at the x of a cumulonimbus (the record's x is a
    // 0..1 screen fraction; wx is the same point in world units). The harness exposes centres, not blob extents, so this is
    // the loose check: within 3 units of some cumulonimbus centre.
    const anchor = ab.json(STEPS.anchor)
    expect(anchor.nimbi.length >= 1, "the thunder scene shows no cumulonimbus for a strike to anchor in")
    const nearest = Math.min(...anchor.nimbi.map((c) => Math.abs(c.x - anchor.wx)))
    console.log(`  strike anchor: x ${anchor.x.toFixed(3)} screen = ${anchor.wx.toFixed(2)} units, ${nearest.toFixed(2)} from the nearest of ${anchor.nimbi.length} cumulonimbus centres`)
    expect(nearest <= 3, `a forced strike with no x landed at x ${anchor.wx.toFixed(2)} (screen ${anchor.x.toFixed(3)}), ${nearest.toFixed(2)} units from the nearest cumulonimbus centre`)

    // Tier: desktop is "hi" (not a coarse pointer). The setter is checked on the phone pass.
    const tier = ab.json(STEPS.tier)
    expect(tier.tier === "hi", `desktop tier is ${tier.tier}, expected hi`)
    ab.json(STEPS.reset)

    // Real mouse through pointer.ts: move the browser's own pointer to a known pixel, no override.
    const px = Math.round(pass.w / 2), py = Math.round(pass.h / 8)
    ab.run("mouse", "move", String(px), String(py))
    const real = ab.json(STEPS.realInput)
    const wx = (px / pass.w - 0.5) * real.view.width, wy = (0.5 - py / pass.h) * real.view.height
    expect(real.cursor.present, `a real mouse move to ${px},${py} left the cursor absent`)
    expect(Math.hypot(real.cursor.x - wx, real.cursor.y - wy) < 0.3, `real mouse at ${px},${py} should put the cursor near (${wx.toFixed(2)}, ${wy.toFixed(2)}), got (${real.cursor.x.toFixed(2)}, ${real.cursor.y.toFixed(2)})`)

    // Over the panel the sim cursor is absent (the panel is above the canvas, so the canvas gets pointerleave).
    ab.json(STEPS.panelOpen(true))
    ab.run("mouse", "move", "200", "300")
    await sleep(200)
    const over = ab.json(STEPS.realInput)
    expect(!over.cursor.present, "the sim cursor is still present with the real mouse over the Sky panel")

    await sleep(500)
    const later = ab.json(STEPS.state)
    expect(later.frame > empty.frame, `the render loop stopped: frame ${empty.frame} -> ${later.frame}`)
  } catch (error) {
    fail(`stopped: ${error.message}`)
  } finally {
    try {
      const pageErrors = ab.run("errors").trim()
      if (pageErrors && !/no (page )?errors/i.test(pageErrors)) fail(`page errors:\n${pageErrors}`)
      const lines = ab.run("console").split("\n").map((l) => l.trim()).filter(Boolean)
      const bad = lines.filter((l) => {
        if (/^\[vite\]/.test(l)) return false
        if (WEBGPU_UNAVAILABLE.test(l)) return pass.name === "webgpu" // expected only where we asked for WebGL2
        if (!l.startsWith("[error]")) return false
        return !HARMLESS_ERRORS.some((h) => h.re.test(l))
      })
      if (bad.length) fail(`console:\n${bad.slice(0, 8).join("\n")}`)
    } catch (error) {
      fail(`could not read console/errors: ${error.message}`)
    }
    try {
      row.adapter = ab.json(ADAPTER).slice(0, 90)
    } catch {
      // Page gone.
    }
    ab.close()
    row.ok = failures.length === 0
    if (!row.ok) row.note = failures.join("\n")
  }
}

function hint(pass, mode, got) {
  if (pass.name !== "webgpu") return ""
  if (mode === "gpu") return " (headed WebGPU needs $DISPLAY and a working GPU; try VERIFY_WEBGPU=swiftshader)"
  return got === "webgl2" ? " (three fell back to WebGL2; the software WebGPU adapter was not available)" : ""
}

// -- main ------------------------------------------------------------------------------------------------------------
const started = Date.now()
const report = []
let preview
const stopPreview = () => {
  if (preview?.pid) {
    try {
      process.kill(-preview.pid, "SIGTERM")
    } catch {
      // Already gone.
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopPreview()
    for (const p of PASSES) makeAb(p, "-").close()
    process.exit(130)
  })
}

let fatal = ""
try {
  try {
    await fetch(APP)
    throw new Error(`something is already listening on ${APP}; set VERIFY_PORT`)
  } catch (error) {
    if (error.message.startsWith("something")) throw error
  }
  mkdirSync(OUT, { recursive: true })
  console.log("building...")
  execFileSync("npx", ["vite", "build", "--logLevel", "error"], { cwd: ROOT, stdio: "inherit" })
  preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", PORT, "--strictPort"], { cwd: ROOT, stdio: "ignore", detached: true })
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(APP).then((r) => r.ok, () => false)
    if (!up) await sleep(250)
  }
  if (!up) throw new Error(`preview server did not start on ${APP}`)
  for (const pass of PASSES) {
    console.log(`pass ${pass.name} (${pass.w}x${pass.h}${pass.query ? " " + pass.query : ""}${pass.name === "webgpu" ? ", " + WEBGPU_MODE : ""})`)
    await runPass(pass, report)
  }
} catch (error) {
  fatal = error.message
} finally {
  stopPreview()
}

// WebGPU and WebGL2 must play the identical game: same cloud counts and the same cloud positions at every step.
const gpu = report.find((r) => r.pass === "webgpu" && r.ok && r.seq.length > 0)
const gl = report.find((r) => r.pass === "webgl2" && r.ok && r.seq.length > 0)
let equivalence = "skipped (needs both the webgpu and webgl2 passes)"
if (gpu && gl) {
  const diffs = []
  for (let i = 0; i < Math.max(gpu.seq.length, gl.seq.length); i++) {
    const a = JSON.stringify(gpu.seq[i]), b = JSON.stringify(gl.seq[i])
    if (a !== b) diffs.push(`step ${i}: webgpu ${a} vs webgl2 ${b}`)
  }
  if (diffs.length) {
    equivalence = "FAIL"
    gpu.ok = false
    gl.ok = false
    gpu.note = `backend divergence:\n${diffs.join("\n")}\n${gpu.note}`
    gl.note = gpu.note
  } else equivalence = `identical across ${gpu.seq.length} steps`
}
console.log(`backend equivalence: ${equivalence}`)
const pad = (s, n) => String(s).padEnd(n)
console.log(`\n${pad("pass", 8)}${pad("backend", 9)}${pad("result", 22)}adapter`)
for (const r of report) {
  const first = r.note.split("\n")[0]
  console.log(`${pad(r.pass, 8)}${pad(r.backend, 9)}${pad(r.ok ? `ok${first ? ` (${first})` : ""}` : "FAIL", 22)}${r.adapter}`)
}
for (const r of report) if (r.trail) console.log(`${r.pass}: clouds ${r.trail}`)
for (const r of report) if (Number.isFinite(r.core)) console.log(`${r.pass}: min cloud-core density ${r.core.toFixed(2)}`)

if (process.env.VERIFY_SEQ) for (const r of report) console.log(`${r.pass} seq: ${JSON.stringify(r.seq)}`)
const failed = report.filter((r) => !r.ok)
for (const r of failed) console.error(`\n${r.pass}: ${r.note}`)
if (fatal) console.error(`\nverify failed: ${fatal}`)
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s, screenshots in ${OUT}`)
process.exit(failed.length || fatal ? 1 : 0)
