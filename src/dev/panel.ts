// The developer tweak panel (lil-gui). Loaded lazily by toggle.ts; everything is generated from FIELD_SPECS (model.ts),
// so a new field shows up as a slider (or a colour) with no change here. Not part of gameplay: it only talks to the
// harness (`setDev` / `clearDev` / `getDev` / `resolved` ...), so the panel and tests drive the same dev layer.
import GUI, { type Controller } from 'lil-gui'
import { WEATHER_STATES, type FieldKey, type P, type WeatherReport, type WeatherState } from '../params/index.ts'
import { buildRows, isClamped, linearToHex, overridesJson, srgbHexToLinear, type Row } from './model.ts'
import type { DevHost, DevPanel } from './toggle.ts'

const STYLE = `
.lil-gui.cloudy-dev { --width: 270px; --font-size: 11px; --input-font-size: 11px; --name-width: 48%; }
.cloudy-dev .lil-controller.dev-override > .lil-name { color: #ffb347; font-weight: 600; }
.cloudy-dev .lil-controller.dev-clamped > .lil-name { color: #ff6b6b; text-decoration: underline wavy; }
.cloudy-dev .dev-stats { padding: 4px var(--padding, 6px); font: 10px/1.35 ui-monospace, monospace; opacity: .85; white-space: pre-wrap; }
`

/** Narrow screens start folded to the title bar so the panel never covers the game. */
const NARROW_PX = 600
const STATS_EVERY_MS = 250

type Trio = readonly [FieldKey, FieldKey, FieldKey]

interface Item {
  readonly keys: readonly FieldKey[]
  readonly ctrl: Controller
  /** Push the resolved value into the control; returns nothing, touches the DOM only when the shown value changed. */
  refresh(p: P, dev: Readonly<Partial<Record<FieldKey, number>>>): void
}

interface Group {
  readonly name: string
  readonly gui: GUI
  readonly items: Item[]
}

export function createDevPanel(host: DevHost): DevPanel {
  const { api } = host
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.append(style)

  const narrow = window.innerWidth < NARROW_PX
  const gui = new GUI({ title: narrow ? 'dev' : 'dev (` to hide)', width: Math.min(270, window.innerWidth - 30) })
  gui.domElement.classList.add('cloudy-dev')
  if (narrow) gui.close()

  // ----- top section: weather, actions, stats -----
  const stats = document.createElement('div')
  stats.className = 'dev-stats'
  gui.domElement.querySelector('.lil-children')?.prepend(stats)

  const ui = { weather: 'clear' as WeatherState, seconds: 4 }
  const w0 = api.getState().weather
  ui.weather = w0.kind === 'steady' ? w0.state : w0.to
  gui.add(ui, 'weather', [...WEATHER_STATES]).onChange(() => (document.activeElement as HTMLElement | null)?.blur())
  gui.add(ui, 'seconds', 0, 20, 0.5).name('transition s')
  gui.add({ go: () => api.setWeather(ui.weather, ui.seconds) }, 'go').name('go (blend to weather)')
  gui.add({ f: () => api.forceStrike() }, 'f').name('force strike')
  for (const name of ['m1', 'clear', 'rain', 'thunder', 'mixed', 'empty'] as const) {
    gui.add({ f: () => api.loadScene(name) }, 'f').name(`load scene ${name}`)
  }
  const pauseCtrl = gui.add({ f: () => api.pause(!api.getState().paused) }, 'f').name('pause')
  gui.add(
    {
      f: () => {
        api.pause(true)
        api.tick(1000 / 60) // exactly one fixed step
      },
    },
    'f',
  ).name('step one fixed step')

  const copyCtrl = gui
    .add(
      {
        f: () => {
          const json = overridesJson(api.getDev())
          const done = (label: string): void => {
            copyCtrl.name(label)
            setTimeout(() => copyCtrl.name('copy overrides JSON'), 1200)
          }
          const fallback = (): void => {
            console.log(json)
            done('logged to console')
          }
          if (!navigator.clipboard) return fallback()
          navigator.clipboard.writeText(json).then(() => done('copied!'), fallback)
        },
      },
      'f',
    )
    .name('copy overrides JSON')
  gui.add({ f: () => api.clearDev() }, 'f').name('reset all overrides')

  // ----- one folder per FIELD_SPECS group -----
  const groups: Group[] = []

  for (const { group, rows } of buildRows()) {
    const folder = gui.addFolder(group)
    if (group !== 'interaction' || narrow) folder.close() // phones: every folder folded, the panel stays a short list
    const items: Item[] = []
    const g: Group = { name: group, gui: folder, items }
    const hdr = { f: () => api.clearDev(items.flatMap((i) => i.keys)) }
    folder.add(hdr, 'f').name(`reset ${group}`)
    for (const row of rows) items.push(addRow(folder, row, api))
    groups.push(g)
  }

  // ----- live refresh: resolved values into untouched controls, override markers, stats -----
  let visible = false
  let raf = 0
  let frames = 0
  let fpsT = performance.now()
  let fps = 0
  let statsT = 0
  const titles = new Map<Group, string>()

  const tick = (now: number): void => {
    raf = visible ? requestAnimationFrame(tick) : 0
    frames++
    if (now - fpsT >= 500) {
      fps = (frames * 1000) / (now - fpsT)
      frames = 0
      fpsT = now
    }
    const p = api.resolved()
    const dev = api.getDev()
    if (!gui._closed) {
      for (const g of groups) {
        let n = 0
        for (const it of g.items) if (it.keys.some((k) => k in dev)) n++
        const title = n ? `${g.name} (${n} set)` : g.name
        if (titles.get(g) !== title) {
          titles.set(g, title)
          g.gui.title(title)
        }
        if (g.gui._closed) continue
        for (const it of g.items) it.refresh(p, dev)
      }
    }
    if (now - statsT >= STATS_EVERY_MS) {
      statsT = now
      const s = api.getState()
      const pauseLabel = s.paused ? 'resume' : 'pause'
      if (pauseCtrl.$name.textContent !== pauseLabel) pauseCtrl.name(pauseLabel)
      stats.textContent =
        `${fps.toFixed(0)} fps   sim ${host.simStepMs().toFixed(2)} ms/step   ${s.backend ?? '?'}\n` +
        `${s.clouds} clouds  ${s.blobs} blobs  ${s.springs} springs\n` +
        `weather ${weatherText(s.weather)}   ${Object.keys(dev).length} overrides`
    }
  }

  // Enter / Escape leave a focused text box (the colour hex field keeps focus otherwise), handing 1..4 and ` back to the game.
  gui.domElement.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') (document.activeElement as HTMLElement | null)?.blur()
  }, true) // capture: lil-gui stops keydown from bubbling out of its controllers

  return {
    setVisible(on) {
      visible = on
      gui.show(on)
      if (on && !raf) {
        fpsT = performance.now()
        frames = 0
        raf = requestAnimationFrame(tick)
      }
    },
  }
}

function weatherText(w: WeatherReport): string {
  return w.kind === 'steady' ? w.state : `${w.from} -> ${w.to} ${(w.progress * 100).toFixed(0)}%`
}

function addRow(folder: GUI, row: Row, api: DevHost['api']): Item {
  return row.kind === 'number' ? addNumber(folder, row, api) : addColor(folder, row.name, row.keys, api)
}

/** Double-click a control's name to drop just that override. */
function clearOnDblClick(ctrl: Controller, keys: readonly FieldKey[], api: DevHost['api']): void {
  ctrl.$name.title = 'double-click to clear this override'
  ctrl.$name.addEventListener('dblclick', () => api.clearDev([...keys]))
}

/** Don't fight the user: skip a refresh while they are typing in this control. */
const editing = (ctrl: Controller): boolean => ctrl.domElement.contains(document.activeElement)

function addNumber(folder: GUI, row: Extract<Row, { kind: 'number' }>, api: DevHost['api']): Item {
  const { key } = row
  const vals = { [key]: 0 } as Record<FieldKey, number>
  const ctrl = folder.add(vals, key, row.min, row.max, row.step).onChange((v: number) => api.setDev({ [key]: v }))
  clearOnDblClick(ctrl, [key], api)
  let shown = Number.NaN
  let flags = ''
  return {
    keys: [key],
    ctrl,
    refresh(p, dev) {
      const f = `${key in dev}${isClamped(dev, p, key)}`
      if (f !== flags) {
        flags = f
        ctrl.domElement.classList.toggle('dev-override', key in dev)
        const clamped = isClamped(dev, p, key)
        ctrl.domElement.classList.toggle('dev-clamped', clamped)
        ctrl.$name.title = clamped ? 'clamped: the resolved value differs from your override (d_touch < d_release gap)' : 'double-click to clear this override'
      }
      const v = Number(p[key].toPrecision(4)) // blends are long decimals; four digits fit the narrow box
      if (v === shown || editing(ctrl)) return
      shown = vals[key] = v
      ctrl.updateDisplay()
    },
  }
}

function addColor(folder: GUI, name: string, keys: Trio, api: DevHost['api']): Item {
  const vals = { [name]: '#000000' }
  const ctrl = folder.addColor(vals, name).onChange((hex: string) => {
    const [r, g, b] = srgbHexToLinear(hex)
    api.setDev({ [keys[0]]: r, [keys[1]]: g, [keys[2]]: b })
  })
  clearOnDblClick(ctrl, keys, api)
  let shown = ''
  let flag = ''
  return {
    keys,
    ctrl,
    refresh(p, dev) {
      const set = keys.some((k) => k in dev)
      if (String(set) !== flag) {
        flag = String(set)
        ctrl.domElement.classList.toggle('dev-override', set)
      }
      const hex = linearToHex(p[keys[0]], p[keys[1]], p[keys[2]])
      if (hex === shown || editing(ctrl)) return
      shown = vals[name] = hex
      ctrl.updateDisplay()
    },
  }
}
