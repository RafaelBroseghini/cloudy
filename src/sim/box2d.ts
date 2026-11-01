// One Box2D wasm module for the whole page. `/compat` is the single-threaded build (the default entry picks a threaded one under node).
import Box2DFactory from 'box2d3-wasm/compat'

export type Box2D = Awaited<ReturnType<typeof Box2DFactory>>

let loading: Promise<Box2D> | null = null

export function loadBox2D(): Promise<Box2D> {
  loading ??= Box2DFactory()
  return loading
}
