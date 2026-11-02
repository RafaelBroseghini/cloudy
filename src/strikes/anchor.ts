// Lightning starts in storm clouds: when a cumulonimbus is on screen, a strike's x (and the glow's height) land inside it.
// Pure. The strike's own x draw is reused (no extra rng draws), so the replay sequence for a seed does not change.
import type { CloudSummary } from '../sim/cloudInfo.ts'
import type { StrikeEvent } from './scheduler.ts'

/** A place a strike may start, in screen fractions: x from `x0` to `x1` (0 left .. 1 right), glow at height `y` (0 bottom .. 1 top). */
export interface StrikeAnchor {
  readonly x0: number
  readonly x1: number
  readonly y: number
}

/** The share of a cloud's width (centred) strikes may land in: inside the body, not on a wispy edge. */
const CORE_SHARE = 0.6
/** The glow sits this far up the cloud's height: low in the body, where the dark base is. */
const GLOW_HEIGHT = 0.4
/** An anchor narrower than this (screen fraction, after clipping to the view) is skipped. */
const MIN_WIDTH = 0.03

/** One anchor per cumulonimbus cloud (dominant type) that has some of its core on screen. */
export function nimbusAnchors(clouds: readonly CloudSummary[], viewW: number, viewH: number): StrikeAnchor[] {
  const out: StrikeAnchor[] = []
  for (const c of clouds) {
    if (c.type !== 'cumulonimbus') continue
    const half = (CORE_SHARE * (c.x1 - c.x0)) / 2
    const mid = (c.x0 + c.x1) / 2
    const x0 = Math.max(0, (mid - half) / viewW + 0.5)
    const x1 = Math.min(1, (mid + half) / viewW + 0.5)
    const y = (c.y0 + GLOW_HEIGHT * (c.y1 - c.y0)) / viewH + 0.5
    if (x1 - x0 < MIN_WIDTH || y < 0 || y > 1) continue
    out.push({ x0, x1, y })
  }
  return out
}

/** Move a strike into one of the anchors (chosen by its `pick` draw, x by its own x draw); no anchors leaves it as it is. */
export function anchorStrike(e: StrikeEvent, anchors: readonly StrikeAnchor[]): StrikeEvent {
  const a = anchors[Math.min(anchors.length - 1, Math.floor(e.pick * anchors.length))]
  if (!a) return e
  // e.x spans 0.1..0.9; map that range across the anchor.
  const u = Math.min(1, Math.max(0, (e.x - 0.1) / 0.8))
  return { ...e, x: a.x0 + (a.x1 - a.x0) * u, y: a.y }
}
