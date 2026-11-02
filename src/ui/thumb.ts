// Gradient thumbnails for the scene chips: a sky for the scene's sun height and weather, with a few soft cloud ellipses.
// Pure strings, same palette as the mockup (these are CSS illustrations, not the game's own sky colours).
import type { SceneDef } from '../settings/index.ts'

type Rgb = readonly [number, number, number]

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round((a[i] as number) + ((b[i] as number) - (a[i] as number)) * t)) as unknown as Rgb
const css = (c: Rgb): string => `rgb(${c[0]},${c[1]},${c[2]})`

// Sky colours (top, horizon, bottom) by sun height: 0 dawn, .5 midday, .78 sunset, 1 purple dusk.
const SKY: readonly (readonly [number, string, string, string])[] = [
  [0, '#7a86c9', '#ffc9a8', '#ffe7cf'],
  [0.25, '#5aa0e6', '#cfe8f7', '#f2f6ee'],
  [0.5, '#4f9be0', '#bfe3f7', '#e9f3f2'],
  [0.78, '#5a6fb8', '#ffb27a', '#ffd9a8'],
  [1, '#3b2f6e', '#b36ab4', '#f2a6b8'],
]
const GREY = { clear: 0, rain: 0.75, thunder: 0.9, tornado: 0.9 } as const
const GREY_SKY = ['#55657d', '#8d9db0', '#a7b3c1'].map(hex)
const STORM_SKY = ['#2f374c', '#5e6a7f', '#7a8597'].map(hex)

function skyAt(t: number): Rgb[] {
  for (let i = 1; i < SKY.length; i++) {
    const a = SKY[i - 1]!
    const b = SKY[i]!
    if (t <= b[0]) {
      const u = (t - a[0]) / (b[0] - a[0])
      return [1, 2, 3].map((k) => mix(hex(a[k] as string), hex(b[k] as string), u))
    }
  }
  const last = SKY[SKY.length - 1]!
  return [1, 2, 3].map((k) => hex(last[k] as string))
}

export function sceneThumbBackground(def: SceneDef): string {
  const sun = def.sliders.timeOfDay ?? 0.5
  const storm = def.weather === 'thunder' ? 1 : 0
  const grey = GREY[def.weather]
  const c = skyAt(sun).map((base, i) => mix(base, mix(GREY_SKY[i]!, STORM_SKY[i]!, storm), grey))
  const cloud = def.weather === 'clear' ? '#fff' : def.weather === 'rain' ? '#e3e9f1' : '#cfd6e2'
  const puffs = def.layout === 'lone' ? [[50, 60, 22, 8]] : [[24, 40, 15, 6], [66, 52, 20, 7], [44, 72, 14, 5]]
  const blobs = puffs.map(([x, y, rx, ry]) => `radial-gradient(ellipse ${rx}px ${ry}px at ${x}% ${y}%, ${cloud} 62%, transparent 66%)`)
  return `${blobs.join(',')}, linear-gradient(180deg, ${css(c[0]!)}, ${css(c[1]!)} 62%, ${css(c[2]!)})`
}
