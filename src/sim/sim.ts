// The CPU gameplay sim for the middle cloud layer: blobs, springs, shape matching, cursor, split and merge.
// Box2D owns integration, spring joints and cursor contacts; this file owns the rules around them.

import type { b2BodyId, b2JointId, b2WorldId } from 'box2d3-wasm/compat'
import { BLOB, BLOB_STRIDE, MAX_BLOBS } from './blobBuffer.ts'
import { loadBox2D, type Box2D } from './box2d.ts'
import { stepCursor, type CursorState, type Pointer } from './cursor.ts'
import { createFixedStepper, FIXED_DT, MAX_STEPS_PER_FRAME } from './fixedStep.ts'
import { blobDensity, influenceRadius } from './kernel.ts'
import { clampParams, type Params } from './params.ts'
import { buildLayout, sceneSpec, type SceneName, type SceneSpec } from './scene.ts'
import { computeRestOffsets, shapeMatchNudge, type ShapeData } from './shapeMatch.ts'
import { labelComponents, PairGate, type UnarmedPair } from './topology.ts'

/** Wind acceleration (units/s^2) at a point and time. Acts on blobs only, never on the cursor. */
export type Wind = (x: number, y: number, t: number) => { readonly x: number; readonly y: number }

export interface SimOptions {
  params?: Partial<Params>
  wind?: Wind | null
  maxStepsPerFrame?: number
}

export interface SimSnapshot {
  step: number
  clouds: number
  blobs: number
  springs: number
  cursor: { x: number; y: number; vx: number; vy: number; present: boolean }
  densityAtCursor: number
}

export interface SimInspect {
  step: number
  /** Cloud id per blob slot. */
  blobCloud: Int32Array
  mass: Float64Array
  springs: Array<{ a: number; b: number; L: number }>
  unarmed: UnarmedPair[]
  energy: { kinetic: number; spring: number; shape: number; total: number }
}

export interface Sim {
  setPointer(p: Pointer): void
  setWind(w: Wind | null): void
  /** One fixed step of 1/60 s. */
  step(): void
  /** Feed elapsed seconds through the fixed-step accumulator; returns steps run. */
  advance(elapsedSeconds: number): number
  /** Fill the blob buffer contract; returns live blob count. */
  writeBlobs(buf: Float32Array): number
  snapshot(): SimSnapshot
  /** Density rho(x, y) of the current blobs. */
  densityAt(x: number, y: number): number
  loadScene(scene: SceneName | SceneSpec, viewW: number, viewH: number): void
  /** Visible world size (view height is 10 units; width is 10 * aspect). Call on resize; loadScene also sets it. */
  setBounds(viewW: number, viewH: number): void
  setParams(partial: Partial<Params>): void
  getParams(): Params
  inspect(): SimInspect
  /** Test hook: destroy every spring (a, b) for which `pred` is true; marks topology dirty. Returns how many. */
  debugBreakSprings(pred: (a: number, b: number) => boolean): number
  dispose(): void
}

const SUBSTEPS = 4
/** Largest distance the cursor may move inside one Box2D step (about half a blob radius). */
const MAX_CURSOR_TRAVEL = 0.3
const MAX_SLICES = 10
/** Blob centres this far inside the visible rect are free; beyond that the containment force starts. */
const CONTAIN_MARGIN = 0.6
const CAT_BLOB = 1
const CAT_CURSOR = 2
export const CURSOR_RADIUS = 0.4
const MAX_BLOB_RADIUS = 0.7
const MIN_BLOB_RADIUS = 0.2
/** Time constant (s) over which blob speed above softSpeed decays. */
const OVERSPEED_TAU = 0.06
/** A split never sheds fewer blobs than this, however small the cloud. */
const MIN_PIECE_FLOOR = 4
/** Extra reach (beyond the cursor radius) within which a fast cursor weakens a spring. */
const CUT_REACH = 0.5
/** Merge springs added per merge, nearest first. */
const MAX_MERGE_SPRINGS = 6
/** Rest-length floor so near-coincident blobs cannot produce huge strains. */
const MIN_REST = 0.2

/** Distance from point (x, y) to the segment (ax, ay)-(bx, by). */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
  return Math.hypot(x - (ax + u * dx), y - (ay + u * dy))
}

interface Spring {
  a: number
  b: number
  L: number
  joint: b2JointId
  /** Reduced mass of the two blobs, used for the k/c to hertz/damping-ratio conversion. */
  mu: number
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export async function createSim(opts: SimOptions = {}): Promise<Sim> {
  const b2 = await loadBox2D()
  return makeSim(b2, opts)
}

function makeSim(b2: Box2D, opts: SimOptions): Sim {
  let params = clampParams(opts.params ?? {})
  let wind: Wind | null = opts.wind ?? null
  const stepper = createFixedStepper(FIXED_DT, opts.maxStepsPerFrame ?? MAX_STEPS_PER_FRAME)

  // Scratch Box2D value objects, reused so the hot path allocates nothing on the wasm side.
  const vec = new b2.b2Vec2(0, 0)
  const aabb = new b2.b2AABB()
  const origin = new b2.b2Vec2(0, 0)
  const queryFilter = b2.b2DefaultQueryFilter()
  // A shape is reported only if its mask contains the query's category, so the query poses as the cursor.
  queryFilter.categoryBits = CAT_CURSOR
  queryFilter.maskBits = CAT_BLOB

  // Blob state, struct-of-arrays, refreshed from Box2D once per step.
  const px = new Float64Array(MAX_BLOBS)
  const py = new Float64Array(MAX_BLOBS)
  const vx = new Float64Array(MAX_BLOBS)
  const vy = new Float64Array(MAX_BLOBS)
  const radius = new Float64Array(MAX_BLOBS)
  const mass = new Float64Array(MAX_BLOBS)
  const cloud = new Int32Array(MAX_BLOBS)
  const qx = new Float64Array(MAX_BLOBS)
  const qy = new Float64Array(MAX_BLOBS)
  const dvx = new Float64Array(MAX_BLOBS)
  const dvy = new Float64Array(MAX_BLOBS)
  const shape: ShapeData = { px, py, mass, qx, qy }

  let n = 0
  let step = 0
  let nextCloudId = 1
  let world: b2WorldId | null = null
  let bodies: b2BodyId[] = []
  let cursorBody: b2BodyId | null = null
  let springs: Spring[] = []
  let dirty = false
  const gate = new PairGate()
  let clouds = new Map<number, number[]>()
  const boxes = new Map<number, Box>()

  let halfW = 5
  let halfH = 5

  let pointer: Pointer = { kind: 'absent' }
  let cursor: CursorState = { x: 0, y: 0, vx: 0, vy: 0 }
  let cursorPresent = false
  let densityAtCursor = 0
  const hits: number[] = []
  // Pointer velocity by finite difference, fed to the cursor's damper. Zero on the first present step.
  let prevPointer: { x: number; y: number } | null = null
  const ptrVel = { x: 0, y: 0 }

  // ---- Box2D plumbing -------------------------------------------------------------------------------

  function destroyWorld(): void {
    if (world) b2.b2DestroyWorld(world)
    world = null
    bodies = []
    cursorBody = null
    springs = []
  }

  function createWorld(): void {
    const wd = b2.b2DefaultWorldDef()
    wd.gravity.x = 0
    wd.gravity.y = 0
    wd.enableSleep = false
    wd.workerCount = 0

    world = b2.b2CreateWorld(wd)
    wd.delete()

    const bd = b2.b2DefaultBodyDef()
    bd.type = b2.b2BodyType.b2_kinematicBody
    bd.isEnabled = false
    bd.enableSleep = false
    cursorBody = b2.b2CreateBody(world, bd)
    bd.delete()
    const sd = b2.b2DefaultShapeDef()
    sd.filter.categoryBits = CAT_CURSOR
    sd.filter.maskBits = CAT_BLOB
    sd.material.friction = 0
    const c = new b2.b2Circle()
    c.radius = CURSOR_RADIUS
    b2.b2CreateCircleShape(cursorBody, sd, c)
    sd.delete()
    c.delete()
  }

  function addBody(slot: number, x: number, y: number, r: number): void {
    if (!world) return
    const bd = b2.b2DefaultBodyDef()
    bd.type = b2.b2BodyType.b2_dynamicBody
    bd.position.x = x
    bd.position.y = y
    bd.enableSleep = false
    bd.linearDamping = params.blobDamping
    bd.motionLocks.angularZ = true
    const id = b2.b2CreateBody(world, bd)
    bd.delete()
    const sd = b2.b2DefaultShapeDef()
    sd.density = 1
    sd.userData = slot
    // Blobs overlap each other like metaballs: they collide only with the cursor.
    sd.filter.categoryBits = CAT_BLOB
    sd.filter.maskBits = CAT_CURSOR
    sd.material.friction = 0
    sd.material.restitution = 0
    const c = new b2.b2Circle()
    c.radius = r
    b2.b2CreateCircleShape(id, sd, c)
    sd.delete()
    c.delete()
    bodies[slot] = id
  }

  // Box2D distance joints are soft constraints parameterised by hertz and damping ratio, not k and c.
  // For two bodies the axial effective mass is the reduced mass mu = m_a m_b / (m_a + m_b), so
  //   omega = sqrt(k_s / mu), hertz = omega / 2pi, zeta = c / (2 sqrt(k_s mu)).
  const springHertz = (mu: number): number => Math.sqrt(params.k_s / mu) / (2 * Math.PI)
  const springZeta = (mu: number): number => params.c / (2 * Math.sqrt(params.k_s * mu))

  function addSpring(a: number, b: number, L: number): void {
    if (!world) return
    const ma = mass[a] ?? 1
    const mb = mass[b] ?? 1
    const mu = (ma * mb) / (ma + mb)
    const jd = b2.b2DefaultDistanceJointDef()
    jd.base.bodyIdA = bodies[a] as b2BodyId
    jd.base.bodyIdB = bodies[b] as b2BodyId
    jd.length = L
    jd.enableSpring = true
    jd.hertz = springHertz(mu)
    jd.dampingRatio = springZeta(mu)
    jd.enableLimit = false
    jd.minLength = 0.01
    jd.maxLength = 1e6
    const joint = b2.b2CreateDistanceJoint(world, jd)
    jd.delete()
    springs.push({ a, b, L, joint, mu })
  }

  // ---- State refresh --------------------------------------------------------------------------------

  function refreshCache(): void {
    for (let i = 0; i < n; i++) {
      const id = bodies[i] as b2BodyId
      const p = b2.b2Body_GetPosition(id)
      px[i] = p.x
      py[i] = p.y
      p.delete()
      const v = b2.b2Body_GetLinearVelocity(id)
      vx[i] = v.x
      vy[i] = v.y
      v.delete()
    }
  }

  function rebuildClouds(): void {
    clouds = new Map()
    for (let i = 0; i < n; i++) {
      const id = cloud[i] ?? 0
      const list = clouds.get(id)
      if (list) list.push(i)
      else clouds.set(id, [i])
    }
  }

  function refreshBoxes(): void {
    boxes.clear()
    for (const [id, members] of clouds) {
      const bx: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      for (const i of members) {
        const r = radius[i] ?? 0
        bx.x0 = Math.min(bx.x0, (px[i] ?? 0) - r)
        bx.y0 = Math.min(bx.y0, (py[i] ?? 0) - r)
        bx.x1 = Math.max(bx.x1, (px[i] ?? 0) + r)
        bx.y1 = Math.max(bx.y1, (py[i] ?? 0) + r)
      }
      boxes.set(id, bx)
    }
  }

  const boxGap = (a: Box, b: Box): number =>
    Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1))

  // ---- Density --------------------------------------------------------------------------------------

  // One Box2D AABB query finds the candidate blobs; the exact kernel sum runs on the cache.
  // Per-blob queries for touch detection cost ~17 us each through the wasm callback boundary, so cloud-pair
  // checks use a JS bounding-box cull and exact distances instead (see gapBetween).
  function density(x: number, y: number): number {
    if (n === 0 || !world) return 0
    const h = influenceRadius(MAX_BLOB_RADIUS)
    aabb.lowerBound.x = x - h
    aabb.lowerBound.y = y - h
    aabb.upperBound.x = x + h
    aabb.upperBound.y = y + h
    hits.length = 0
    b2.b2World_OverlapAABB(world, origin, aabb, queryFilter, (r: { shapeId: Parameters<typeof b2.b2Shape_GetUserData>[0] }) => {
      hits.push(b2.b2Shape_GetUserData(r.shapeId))
      return true
    })
    // Sum in slot order so the result does not depend on broadphase tree order.
    hits.sort((p, q) => p - q)
    let rho = 0
    for (const i of hits) {
      rho += blobDensity(mass[i] ?? 0, Math.hypot(x - (px[i] ?? 0), y - (py[i] ?? 0)), radius[i] ?? 1)
    }
    return rho
  }

  // ---- Springs, topology ----------------------------------------------------------------------------

  function updateSprings(): void {
    // Springs past splitStrain are only candidates: breaking them must not shed a wisp (see sparedLinks).
    let broken: Set<Spring> | null = null
    // A fast cursor tears springs it touches at a lower strain, so a flick cuts cleanly along its path while a slow
    // sweep, which never reaches flickRate, leaves the strain rule alone.
    const speed = cursorPresent ? Math.hypot(cursor.vx, cursor.vy) : 0
    const reach = CURSOR_RADIUS + CUT_REACH + 0.5 * speed * FIXED_DT
    for (const s of springs) {
      const ax = px[s.a] ?? 0
      const ay = py[s.a] ?? 0
      const bx = px[s.b] ?? 0
      const by = py[s.b] ?? 0
      const d = Math.hypot(ax - bx, ay - by)
      let limit = params.splitStrain
      // Speed per rest length, so small (portrait) clouds tear at proportionally lower cursor speeds.
      const t = Math.min(1, Math.max(0, speed / s.L / params.flickRate - 1))
      if (t > 0 && segmentDistance(cursor.x, cursor.y, ax, ay, bx, by) < reach) limit *= 1 - t * (1 - params.flickCut)
      if ((d - s.L) / s.L > limit) (broken ??= new Set()).add(s)
    }
    if (broken) for (const s of sparedLinks(broken)) broken.delete(s)
    let w = 0
    for (let r = 0; r < springs.length; r++) {
      const s = springs[r] as Spring
      if (broken?.has(s)) {
        b2.b2DestroyJoint(s.joint)
        dirty = true
        continue
      }
      const d = Math.hypot((px[s.a] ?? 0) - (px[s.b] ?? 0), (py[s.a] ?? 0) - (py[s.b] ?? 0))
      const strain = (d - s.L) / s.L
      if (Math.abs(strain) > params.yieldStrain) {
        s.L = Math.max(MIN_REST, s.L + params.creep * (d - s.L))
        b2.b2DistanceJoint_SetRestLength(s.joint, s.L)
      }
      springs[w++] = s
    }
    springs.length = w
  }

  /**
   * Of the candidate springs, those to keep so that no piece smaller than minPieceFrac of its cloud (at least MIN_PIECE_FLOOR
   * blobs) is shed; a cloud under twice that never splits. A tiny component keeps its links to the neighbour it shares most
   * candidates with and reattaches, because those springs stay stretched and pull it back. Tearing off a wisp of a few
   * blobs reads as shredding, not splitting.
   */
  function sparedLinks(candidates: ReadonlySet<Spring>): Spring[] {
    const spared = new Set<Spring>()
    const kept: Array<{ readonly a: number; readonly b: number }> = []
    for (const s of springs) if (!candidates.has(s)) kept.push(s)
    for (let guard = 0; guard < candidates.size; guard++) {
      const root = labelComponents(n, kept)
      const size = new Map<number, number>()
      const cloudSize = new Map<number, number>()
      for (let i = 0; i < n; i++) {
        size.set(root[i] ?? i, (size.get(root[i] ?? i) ?? 0) + 1)
        cloudSize.set(cloud[i] ?? 0, (cloudSize.get(cloud[i] ?? 0) ?? 0) + 1)
      }
      // Smallest tiny component first, ties by root, so the choice is deterministic.
      let tiny = -1
      for (const [r, sz] of size) {
        const whole = cloudSize.get(cloud[r] ?? 0) ?? 0
        const limit = Math.max(MIN_PIECE_FLOOR, Math.ceil(params.minPieceFrac * whole))
        if (sz >= limit) continue
        if (tiny < 0 || sz < (size.get(tiny) ?? 0) || (sz === (size.get(tiny) ?? 0) && r < tiny)) {
          if ([...candidates].some((c) => !spared.has(c) && (root[c.a] === r) !== (root[c.b] === r))) tiny = r
        }
      }
      if (tiny < 0) break
      const links = new Map<number, Spring[]>()
      for (const c of candidates) {
        if (spared.has(c)) continue
        const ra = root[c.a] ?? c.a
        const rb = root[c.b] ?? c.b
        if ((ra === tiny) === (rb === tiny)) continue
        const other = ra === tiny ? rb : ra
        const list = links.get(other)
        if (list) list.push(c)
        else links.set(other, [c])
      }
      let best: Spring[] = []
      let bestRoot = -1
      for (const [r, list] of links) {
        if (list.length > best.length || (list.length === best.length && r < bestRoot)) {
          best = list
          bestRoot = r
        }
      }
      for (const c of best) {
        spared.add(c)
        kept.push(c)
      }
    }
    return [...spared]
  }

  function relabel(): void {
    dirty = false
    const root = labelComponents(n, springs)
    const byOld = new Map<number, Map<number, number[]>>()
    for (let i = 0; i < n; i++) {
      const old = cloud[i] ?? 0
      let comps = byOld.get(old)
      if (!comps) byOld.set(old, (comps = new Map()))
      const rt = root[i] ?? i
      const list = comps.get(rt)
      if (list) list.push(i)
      else comps.set(rt, [i])
    }
    for (const [old, comps] of byOld) {
      if (comps.size === 1) continue
      const pieces: number[] = []
      for (const members of comps.values()) {
        const id = nextCloudId++
        pieces.push(id)
        for (const i of members) cloud[i] = id
        computeRestOffsets(members, shape)
      }
      gate.recordSplit(old, pieces, step)
    }
    rebuildClouds()
  }

  /** Smallest surface gap between two clouds, or any value > cap if they are farther apart than cap. */
  function gapBetween(a: number, b: number, cap: number): number {
    const ba = boxes.get(a)
    const bb = boxes.get(b)
    const ma = clouds.get(a)
    const mb = clouds.get(b)
    if (!ba || !bb || !ma || !mb) return Infinity
    const bg = boxGap(ba, bb)
    if (bg > cap) return bg
    let best = Infinity
    for (const i of ma) {
      for (const j of mb) {
        const g = Math.hypot((px[i] ?? 0) - (px[j] ?? 0), (py[i] ?? 0) - (py[j] ?? 0)) - (radius[i] ?? 0) - (radius[j] ?? 0)
        if (g < best) best = g
      }
    }
    return best
  }

  function armPairs(): void {
    const tauSteps = Math.round(params.tau / FIXED_DT)
    gate.armWhere((r) => step - r.splitStep >= tauSteps || gapBetween(r.a, r.b, params.d_release) > params.d_release)
  }

  function mergeClouds(a: number, b: number): void {
    const ma = clouds.get(a) ?? []
    const mb = clouds.get(b) ?? []
    const cross: Array<{ i: number; j: number; gap: number; d: number }> = []
    for (const i of ma) {
      for (const j of mb) {
        const d = Math.hypot((px[i] ?? 0) - (px[j] ?? 0), (py[i] ?? 0) - (py[j] ?? 0))
        const gap = d - (radius[i] ?? 0) - (radius[j] ?? 0)
        if (gap <= params.d_touch) cross.push({ i, j, gap, d })
      }
    }
    cross.sort((p, q) => p.gap - q.gap || p.i - q.i || p.j - q.j)
    for (const c of cross.slice(0, MAX_MERGE_SPRINGS)) addSpring(c.i, c.j, Math.max(MIN_REST, c.d))
    // The bigger cloud keeps its id; ties keep the lower one.
    const keep = ma.length > mb.length || (ma.length === mb.length && a < b) ? a : b
    const drop = keep === a ? b : a
    for (const i of keep === a ? mb : ma) cloud[i] = keep
    gate.recordMerge(drop, keep)
    computeRestOffsets([...ma, ...mb], shape)
  }

  function mergeTouching(): void {
    for (let pass = 0; pass < MAX_BLOBS; pass++) {
      const ids = [...clouds.keys()]
      const used = new Set<number>()
      let merged = false
      for (let x = 0; x < ids.length; x++) {
        const a = ids[x] as number
        if (used.has(a)) continue
        for (let y = x + 1; y < ids.length; y++) {
          const b = ids[y] as number
          if (used.has(b) || gate.isUnarmed(a, b)) continue
          const ba = boxes.get(a)
          const bb = boxes.get(b)
          if (!ba || !bb || boxGap(ba, bb) > params.d_touch) continue
          if (gapBetween(a, b, params.d_touch) > params.d_touch) continue
          mergeClouds(a, b)
          used.add(a)
          used.add(b)
          merged = true
          break
        }
      }
      if (!merged) return
      rebuildClouds()
      refreshBoxes()
    }
  }

  // ---- Cursor ---------------------------------------------------------------------------------------

  function syncCursorPresence(): void {
    if (!world || !cursorBody) return
    if (pointer.kind === 'present' && !cursorPresent) {
      cursor = { x: pointer.x, y: pointer.y, vx: 0, vy: 0 }
      vec.x = pointer.x
      vec.y = pointer.y
      b2.b2Body_SetTransform(cursorBody, vec, b2.b2Rot_identity)
      b2.b2Body_Enable(cursorBody)
      cursorPresent = true
    } else if (pointer.kind === 'absent' && cursorPresent) {
      b2.b2Body_Disable(cursorBody)
      cursor = { x: cursor.x, y: cursor.y, vx: 0, vy: 0 }
      cursorPresent = false
      densityAtCursor = 0
    }
  }

  // ---- Public ---------------------------------------------------------------------------------------

  /**
   * Soft containment: a blob centre beyond the visible rect (inset by CONTAIN_MARGIN) feels a critically damped spring
   * back toward it (damping acts only while outside, so it arrives at the edge slowly instead of coasting across the
   * view). Strays drift home instead of bouncing off a wall. Blobs only; never the cursor.
   */
  function contain(): void {
    const k = params.containK
    const c = 2 * Math.sqrt(k)
    const lx = halfW - CONTAIN_MARGIN
    const ly = halfH - CONTAIN_MARGIN
    for (let i = 0; i < n; i++) {
      const x = px[i] ?? 0
      const y = py[i] ?? 0
      const ex = x > lx ? x - lx : x < -lx ? x + lx : 0
      const ey = y > ly ? y - ly : y < -ly ? y + ly : 0
      if (ex !== 0) dvx[i] = (dvx[i] ?? 0) - FIXED_DT * (k * ex + c * (vx[i] ?? 0))
      if (ey !== 0) dvy[i] = (dvy[i] ?? 0) - FIXED_DT * (k * ey + c * (vy[i] ?? 0))
    }
  }

  /**
   * Blobs thrown faster than softSpeed shed the excess with time constant OVERSPEED_TAU, so a flicked piece slows
   * within a fraction of a second instead of sailing to the edge and piling onto its neighbours. Contact still hands
   * a blob the cursor's speed each step, so a cursor pushes at full strength; this acts once it lets go.
   */
  function bleedOverspeed(): void {
    const keep = Math.exp(-FIXED_DT / OVERSPEED_TAU)
    for (let i = 0; i < n; i++) {
      const sp = Math.hypot(vx[i] ?? 0, vy[i] ?? 0)
      if (sp <= params.softSpeed) continue
      const f = (params.softSpeed + (sp - params.softSpeed) * keep) / sp - 1
      dvx[i] = (dvx[i] ?? 0) + f * (vx[i] ?? 0)
      dvy[i] = (dvy[i] ?? 0) + f * (vy[i] ?? 0)
    }
  }

  function setBounds(viewW: number, viewH: number): void {
    if (Number.isFinite(viewW) && viewW > 0) halfW = viewW / 2
    if (Number.isFinite(viewH) && viewH > 0) halfH = viewH / 2
  }

  function pointerVel(): { readonly x: number; readonly y: number } {
    ptrVel.x = 0
    ptrVel.y = 0
    if (pointer.kind === 'present') {
      if (prevPointer) {
        ptrVel.x = (pointer.x - prevPointer.x) / FIXED_DT
        ptrVel.y = (pointer.y - prevPointer.y) / FIXED_DT
        const sp = Math.hypot(ptrVel.x, ptrVel.y)
        if (sp > params.cursorMaxSpeed) {
          ptrVel.x *= params.cursorMaxSpeed / sp
          ptrVel.y *= params.cursorMaxSpeed / sp
        }
      }
      prevPointer = { x: pointer.x, y: pointer.y }
    } else prevPointer = null
    return ptrVel
  }

  function stepOnce(): void {
    if (!world || !cursorBody) return
    syncCursorPresence()
    if (!cursorPresent) prevPointer = null

    if (cursorPresent) {
      densityAtCursor = density(cursor.x, cursor.y)
      cursor = stepCursor(cursor, pointer, pointerVel(), params, densityAtCursor, FIXED_DT)
      // Drive the kinematic body by velocity so contacts push blobs; Box2D moves it by v dt during the step.
      vec.x = cursor.vx
      vec.y = cursor.vy
      b2.b2Body_SetLinearVelocity(cursorBody, vec)
    }

    dvx.fill(0, 0, n)
    dvy.fill(0, 0, n)
    for (const members of clouds.values()) shapeMatchNudge(members, shape, params.alpha, FIXED_DT, dvx, dvy)
    if (wind) {
      const t = step * FIXED_DT
      for (let i = 0; i < n; i++) {
        const w = wind(px[i] ?? 0, py[i] ?? 0, t)
        dvx[i] = (dvx[i] ?? 0) + w.x * FIXED_DT
        dvy[i] = (dvy[i] ?? 0) + w.y * FIXED_DT
      }
    }
    if (params.containK > 0) contain()
    if (params.softSpeed < 1000) bleedOverspeed()
    for (let i = 0; i < n; i++) {
      const ax = dvx[i] ?? 0
      const ay = dvy[i] ?? 0
      if (ax === 0 && ay === 0) continue
      vec.x = (vx[i] ?? 0) + ax
      vec.y = (vy[i] ?? 0) + ay
      b2.b2Body_SetLinearVelocity(bodies[i] as b2BodyId, vec)
    }

    // A fast cursor would hop over blobs between contact updates, so split the world step into slices that each move
    // it less than MAX_CURSOR_TRAVEL. Only fast frames pay for extra slices.
    const slices = cursorPresent
      ? Math.min(MAX_SLICES, Math.max(1, Math.ceil((Math.hypot(cursor.vx, cursor.vy) * FIXED_DT) / MAX_CURSOR_TRAVEL)))
      : 1
    for (let k = 0; k < slices; k++) b2.b2World_Step(world, FIXED_DT / slices, SUBSTEPS)
    refreshCache()

    updateSprings()
    if (dirty) relabel()
    refreshBoxes()
    armPairs()
    mergeTouching()
    step++
  }

  function loadScene(scene: SceneName | SceneSpec, viewW: number, viewH: number): void {
    setBounds(viewW, viewH)
    destroyWorld()
    createWorld()
    const spec = typeof scene === 'string' ? sceneSpec(scene, viewW, viewH) : scene
    const layout = buildLayout(spec)
    n = layout.blobs.length
    step = 0
    dirty = false
    gate.clear()
    cursorPresent = false
    prevPointer = null
    densityAtCursor = 0
    stepper.reset()
    nextCloudId = spec.clouds.length + 1
    layout.blobs.forEach((b, i) => {
      px[i] = b.x
      py[i] = b.y
      vx[i] = 0
      vy[i] = 0
      radius[i] = Math.min(MAX_BLOB_RADIUS, Math.max(MIN_BLOB_RADIUS, b.radius))
      mass[i] = Math.PI * (radius[i] ?? 0) ** 2
      cloud[i] = b.cloud + 1
      addBody(i, b.x, b.y, radius[i] ?? 0)
    })
    for (const [a, b] of layout.springs) {
      addSpring(a, b, Math.hypot((px[a] ?? 0) - (px[b] ?? 0), (py[a] ?? 0) - (py[b] ?? 0)))
    }
    rebuildClouds()
    for (const members of clouds.values()) computeRestOffsets(members, shape)
    refreshBoxes()
  }

  function setParams(partial: Partial<Params>): void {
    const prev = params
    params = clampParams(partial, params)
    if (params.k_s !== prev.k_s || params.c !== prev.c) {
      for (const s of springs) {
        b2.b2DistanceJoint_SetSpringHertz(s.joint, springHertz(s.mu))
        b2.b2DistanceJoint_SetSpringDampingRatio(s.joint, springZeta(s.mu))
      }
    }
    if (params.blobDamping !== prev.blobDamping) {
      for (let i = 0; i < n; i++) b2.b2Body_SetLinearDamping(bodies[i] as b2BodyId, params.blobDamping)
    }
  }

  function energy(): SimInspect['energy'] {
    let kinetic = 0
    for (let i = 0; i < n; i++) kinetic += 0.5 * (mass[i] ?? 0) * ((vx[i] ?? 0) ** 2 + (vy[i] ?? 0) ** 2)
    let spring = 0
    for (const s of springs) {
      const d = Math.hypot((px[s.a] ?? 0) - (px[s.b] ?? 0), (py[s.a] ?? 0) - (py[s.b] ?? 0))
      spring += 0.5 * params.k_s * (d - s.L) ** 2
    }
    let sm = 0
    dvx.fill(0, 0, n)
    dvy.fill(0, 0, n)
    for (const members of clouds.values()) sm += shapeMatchNudge(members, shape, params.alpha, FIXED_DT, dvx, dvy)
    return { kinetic, spring, shape: sm, total: kinetic + spring + sm }
  }

  loadScene('empty', 10, 10)

  return {
    setPointer(p) {
      pointer =
        p.kind === 'present' && Number.isFinite(p.x) && Number.isFinite(p.y) ? { kind: 'present', x: p.x, y: p.y } : { kind: 'absent' }
    },
    setWind(w) {
      wind = w
    },
    step: stepOnce,
    advance(elapsed) {
      return stepper.advance(elapsed, stepOnce)
    },
    writeBlobs(buf) {
      const count = Math.min(n, Math.floor(buf.length / BLOB_STRIDE))
      for (let i = 0; i < count; i++) {
        const o = i * BLOB_STRIDE
        buf[o + BLOB.x] = px[i] ?? 0
        buf[o + BLOB.y] = py[i] ?? 0
        buf[o + BLOB.radius] = radius[i] ?? 0
        buf[o + BLOB.mass] = mass[i] ?? 0
        buf[o + BLOB.vx] = vx[i] ?? 0
        buf[o + BLOB.vy] = vy[i] ?? 0
        buf[o + BLOB.cloudId] = cloud[i] ?? 0
        buf[o + BLOB.alive] = 1
      }
      buf.fill(0, count * BLOB_STRIDE)
      return count
    },
    snapshot() {
      return {
        step,
        clouds: clouds.size,
        blobs: n,
        springs: springs.length,
        cursor: { x: cursor.x, y: cursor.y, vx: cursor.vx, vy: cursor.vy, present: cursorPresent },
        densityAtCursor,
      }
    },
    densityAt: density,
    loadScene,
    setBounds,
    setParams,
    getParams: () => ({ ...params }),
    inspect() {
      return {
        step,
        blobCloud: cloud.slice(0, n),
        mass: mass.slice(0, n),
        springs: springs.map((s) => ({ a: s.a, b: s.b, L: s.L })),
        unarmed: gate.list(),
        energy: energy(),
      }
    },
    debugBreakSprings(pred) {
      let w = 0
      let broken = 0
      for (const s of springs) {
        if (pred(s.a, s.b)) {
          b2.b2DestroyJoint(s.joint)
          broken++
        } else springs[w++] = s
      }
      springs.length = w
      if (broken > 0) {
        dirty = true
        relabel()
        refreshBoxes()
      }
      return broken
    },
    dispose() {
      destroyWorld()
      vec.delete()
      aabb.delete()
      origin.delete()
      queryFilter.delete()
    },
  }
}
