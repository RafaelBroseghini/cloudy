// The Sky panel: plain DOM over the settings controller. State flows one way: the panel calls the host (the controller),
// then repaints from `settings()` / `sliderState()` / `weather()`; it holds no game state of its own except the fold.
// `sync()` runs every rendered frame and repaints only when the settings, the weather or the resolved params changed, so
// harness calls, keys 1..4, the URL and the dev panel show up too.
//
// Every slider is a real <input type="range"> (keyboard, touch and screen readers work). The pointer never needs special
// handling for the canvas: the panel is a sibling of the canvas, so the canvas gets pointerleave when the mouse moves
// onto it and the sim cursor goes absent. Pointer events are NOT stopped, so a click here still unlocks audio.
import './panel.css'
import type { WeatherState } from '../params/index.ts'
import { SCENES, type SceneId, type Settings, type SliderKey, type SliderState, type StorageSource } from '../settings/index.ts'
import { dieSvg, icon } from './icons.ts'
import { loadMotion as defaultLoadMotion, pressIn, pressOut, relax, squash, stretch, tumble, type MotionApi } from './motion.ts'
import { SLIDER_UI, WEATHER_UI, panelView, reportOf, type PanelView, type UiReport } from './model.ts'
import { sceneThumbBackground } from './thumb.ts'
import { initialOpen, saveOpen } from './uiState.ts'

/** What the panel needs from the game: the settings controller plus the live weather and the resolved params. */
export interface SkyPanelHost {
  settings(): Settings
  sliderState(): Record<SliderKey, SliderState>
  /** The weather the game is on or blending toward (keys 1..4 move this without touching the settings). */
  weather(): WeatherState
  /** Changes identity whenever the resolved params change (unset sliders follow them). */
  resolved(): unknown
  setSlider(key: SliderKey, v: number): void
  clearSlider(key: SliderKey): void
  applyScene(id: SceneId): void
  setWeatherPreset(state: WeatherState): void
  /** The dice. The caller supplies the randomness. */
  randomize(): void
  reset(): void
}

export interface SkyPanelOptions {
  parent?: HTMLElement
  loadMotion?: () => Promise<MotionApi | null>
  reducedMotion?: () => boolean
  /** Phone-sized screen: starts folded. */
  narrow?: () => boolean
  storage?: StorageSource
}

export interface SkyPanel {
  readonly element: HTMLElement
  /** Repaint if anything the panel shows changed. Cheap enough to call every frame. */
  sync(): void
  isOpen(): boolean
  setOpen(open: boolean): void
  report(): UiReport
  dispose(): void
}

/** A phone in portrait (the sheet) or landscape (too short for an open panel). */
const NARROW_QUERY = '(max-width: 560px), (max-height: 480px)'
/** Time the dice swap their face: the midpoint of the tumble. */
const FACE_SWAP_MS = 240

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (html !== undefined) e.innerHTML = html
  return e
}
const setText = (e: Element, text: string): void => {
  if (e.textContent !== text) e.textContent = text
}
const setAttr = (e: Element, name: string, value: string): void => {
  if (e.getAttribute(name) !== value) e.setAttribute(name, value)
}

interface Row {
  readonly key: SliderKey
  readonly root: HTMLElement
  readonly input: HTMLInputElement
  readonly val: HTMLElement
  readonly ic: HTMLElement
}

export function createSkyPanel(host: SkyPanelHost, opts: SkyPanelOptions = {}): SkyPanel {
  const reduced = opts.reducedMotion ?? ((): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const narrow = opts.narrow ?? ((): boolean => window.matchMedia(NARROW_QUERY).matches)
  let motion: MotionApi | null = null

  const root = el('section', 'sky-panel')
  root.id = 'sky-panel'
  root.setAttribute('aria-label', 'Sky controls')

  // ----- header: mark, title, subtitle, dice, fold -----
  const mark = el('span', 'sky-mark', icon('cloud', 22, 'currentColor'))
  mark.setAttribute('aria-hidden', 'true')
  const title = el('h2', 'sky-title', 'Sky')
  const sub = el('p', 'sky-sub')
  const ttl = el('div', 'sky-ttl')
  ttl.append(title, sub)
  const dice = el('button', 'sky-dice', dieSvg(5))
  dice.type = 'button'
  dice.setAttribute('aria-label', 'Randomize the sky')
  dice.title = 'Surprise me'
  const fold = el('button', 'sky-fold', icon('chevron', 20))
  fold.type = 'button'
  fold.setAttribute('aria-controls', 'sky-body')
  const header = el('header', 'sky-head')
  header.append(mark, ttl, dice, fold)

  // ----- body -----
  const body = el('div', 'sky-body')
  body.id = 'sky-body'
  const section = (heading: string, content: HTMLElement): HTMLElement => {
    const s = el('div')
    s.append(el('h3', 'sky-h', heading), content)
    return s
  }

  const pebbleBox = el('div', 'sky-pebbles')
  pebbleBox.setAttribute('role', 'group')
  pebbleBox.setAttribute('aria-label', 'Weather')
  const pebbles = new Map<WeatherState, HTMLButtonElement>()
  for (const w of WEATHER_UI) {
    const b = el('button', 'sky-pebble', `${icon(w.icon, 24)}<span>${w.label}</span>`)
    b.type = 'button'
    b.dataset.weatherBtn = w.state
    if (w.soon) {
      b.disabled = true
      b.title = 'Coming last'
      b.setAttribute('aria-label', `${w.label} (coming last)`)
    } else {
      b.addEventListener('click', () => {
        host.setWeatherPreset(w.state)
        refresh()
      })
    }
    pebbles.set(w.state, b)
    pebbleBox.append(b)
  }

  const sceneBox = el('div', 'sky-scenes')
  sceneBox.setAttribute('role', 'group')
  sceneBox.setAttribute('aria-label', 'Scene presets')
  const scenes = new Map<SceneId, HTMLButtonElement>()
  for (const s of SCENES) {
    const b = el('button', 'sky-scene')
    const thumb = el('span', 'sky-thumb')
    thumb.style.background = sceneThumbBackground(s)
    b.append(thumb, el('span', undefined, s.name))
    b.type = 'button'
    b.dataset.scene = s.id
    b.addEventListener('click', () => {
      host.applyScene(s.id)
      refresh()
    })
    scenes.set(s.id, b)
    sceneBox.append(b)
  }

  const sliderBox = el('div', 'sky-sliders')
  const rows: Row[] = []
  let dragKey: SliderKey | null = null
  for (const key of Object.keys(SLIDER_UI) as SliderKey[]) {
    const ui = SLIDER_UI[key]
    const rowEl = el('div', ui.sky ? 'sky-row sunk' : 'sky-row')
    if (ui.fill) rowEl.style.setProperty('--fillc', ui.fill)
    if (ui.pattern) rowEl.style.setProperty('--pat', ui.pattern)
    const ic = el('span', 'sky-ic', icon(ui.icon, 20))
    const label = el('label', undefined, ui.label)
    const id = `sky-s-${key}`
    label.htmlFor = id
    const val = el('span', 'sky-val')
    val.setAttribute('aria-hidden', 'true') // aria-valuetext on the input says the same
    const top = el('div', 'sky-top')
    top.append(ic, label, val)
    const input = el('input')
    input.type = 'range'
    input.id = id
    input.min = '0'
    input.max = '1'
    input.step = '0.01'
    input.dataset.slider = key
    rowEl.append(top, input)
    sliderBox.append(rowEl)
    const row: Row = { key, root: rowEl, input, val, ic }
    rows.push(row)

    let last = Number.NaN
    let calm: ReturnType<typeof setTimeout> | undefined
    input.addEventListener('input', () => {
      const v = input.valueAsNumber
      host.setSlider(key, v)
      if (!reduced()) {
        ic.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.25) rotate(-6deg)' }, { transform: 'scale(.95)' }, { transform: 'scale(1)' }],
          { duration: 380, easing: 'ease-out' },
        )
        if (motion && dragKey === key && Math.abs(v - last) > 0.012) {
          stretch(motion, input)
          clearTimeout(calm)
          calm = setTimeout(() => {
            if (motion && dragKey === key) squash(motion, input)
          }, 110)
        }
      }
      last = v
      refresh()
    })
    input.addEventListener('pointerdown', () => {
      dragKey = key
      last = input.valueAsNumber
      if (motion && !reduced() && !input.disabled) squash(motion, input)
      const end = (): void => {
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        dragKey = null
        clearTimeout(calm)
        if (motion) relax(motion, input)
      }
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
    // A slider the player set can follow the scene again: Delete/Backspace on the handle, or double-click the name.
    const clear = (): void => {
      host.clearSlider(key)
      refresh()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') clear()
    })
    label.addEventListener('dblclick', clear)
  }

  const footer = el('footer', 'sky-foot')
  const saved = el('span', 'sky-saved', `${icon('check', 15)}Saved on this device`)
  const resetBtn = el('button', 'sky-reset', 'Reset scene')
  resetBtn.type = 'button'
  resetBtn.addEventListener('click', () => {
    host.reset()
    refresh()
  })
  footer.append(saved, resetBtn)

  body.append(section('Weather', pebbleBox), section('Scene', sceneBox), section('Tweak', sliderBox), footer)
  root.append(header, body)

  // ----- press feedback (Motion springs; nothing under reduced motion) -----
  const attachPress = (b: HTMLButtonElement): void => {
    let down = false
    b.addEventListener('pointerdown', () => {
      if (!motion || reduced() || b.disabled) return
      down = true
      pressIn(motion, b)
    })
    const up = (): void => {
      if (!down || !motion) return
      down = false
      pressOut(motion, b)
    }
    b.addEventListener('pointerup', up)
    b.addEventListener('pointerleave', up)
    b.addEventListener('pointercancel', up)
  }
  for (const b of [...pebbles.values(), ...scenes.values(), resetBtn]) attachPress(b)

  // ----- dice -----
  let faceTimer: ReturnType<typeof setTimeout> | undefined
  const setFace = (n: number): void => {
    dice.innerHTML = dieSvg(n)
  }
  dice.addEventListener('click', () => {
    const face = 1 + Math.floor(Math.random() * 6) // cosmetic only; the roll itself comes from the host
    clearTimeout(faceTimer)
    if (motion && !reduced()) {
      tumble(motion, dice)
      faceTimer = setTimeout(() => setFace(face), FACE_SWAP_MS)
    } else {
      setFace(face)
    }
    host.randomize()
    refresh()
  })

  // ----- fold -----
  let open = initialOpen(narrow(), opts.storage)
  const paintOpen = (): void => {
    root.dataset.open = String(open)
    fold.setAttribute('aria-expanded', String(open))
    fold.setAttribute('aria-label', open ? 'Collapse sky panel' : 'Expand sky panel')
    body.hidden = !open
  }
  const setOpen = (next: boolean): void => {
    open = next
    paintOpen()
    if (!narrow()) saveOpen(open, opts.storage)
  }
  fold.addEventListener('click', () => setOpen(!open))
  paintOpen()

  // ----- paint from the model -----
  let seen: { settings: Settings; weather: WeatherState; resolved: unknown } | null = null
  let view: PanelView | null = null
  const paint = (v: PanelView): void => {
    setAttr(root, 'data-weather', v.weather)
    setText(sub, v.subtitle)
    for (const p of v.pebbles) {
      const b = pebbles.get(p.state)
      if (b) setAttr(b, 'aria-pressed', String(p.pressed))
    }
    for (const s of v.scenes) {
      const b = scenes.get(s.id)
      if (b) setAttr(b, 'aria-pressed', String(s.pressed))
    }
    for (const r of rows) {
      const s = v.sliders.find((x) => x.key === r.key)
      if (!s) continue
      // The range input snaps to its step, so only move it when the model is clearly elsewhere (and never mid-drag).
      if (dragKey !== r.key && Math.abs(r.input.valueAsNumber - s.value) > 0.005) r.input.value = String(s.value)
      if (r.input.disabled !== s.disabled) r.input.disabled = s.disabled
      setAttr(r.root, 'data-off', String(s.disabled))
      setAttr(r.input, 'aria-valuetext', s.word)
      setText(r.val, s.word)
      const pct = `${s.percent}`
      if (r.root.style.getPropertyValue('--p') !== pct) r.root.style.setProperty('--p', pct)
      const ui = SLIDER_UI[r.key]
      const hint = s.set ? `${ui.label}: double-click the name to follow the weather again` : ''
      const lbl = r.root.querySelector('label')
      if (lbl && lbl.title !== hint) lbl.title = hint
    }
  }
  function refresh(): void {
    seen = { settings: host.settings(), weather: host.weather(), resolved: host.resolved() }
    view = panelView({ weather: seen.weather, settings: seen.settings, sliders: host.sliderState() })
    paint(view)
  }
  refresh()

  const parent = opts.parent ?? document.body
  parent.append(root)

  void (opts.loadMotion ?? defaultLoadMotion)().then((m) => {
    motion = m
    if (m) root.dataset.motion = 'on'
  })

  return {
    element: root,
    sync() {
      if (seen && seen.settings === host.settings() && seen.weather === host.weather() && seen.resolved === host.resolved()) return
      refresh()
    },
    isOpen: () => open,
    setOpen,
    report() {
      refresh()
      return reportOf(view as PanelView, open)
    },
    dispose() {
      clearTimeout(faceTimer)
      root.remove()
    },
  }
}
