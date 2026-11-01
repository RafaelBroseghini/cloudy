// Cloud topology on plain arrays: union-find labelling and the split/merge hysteresis records. No wasm.

/** Connected components of `n` nodes under `edges`. Returns a root index per node (smallest node index in the component). */
export function labelComponents(n: number, edges: ReadonlyArray<{ readonly a: number; readonly b: number }>): Int32Array {
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while ((parent[r] ?? r) !== r) r = parent[r] ?? r
    while ((parent[x] ?? x) !== r) {
      const nx = parent[x] ?? x
      parent[x] = r
      x = nx
    }
    return r
  }
  for (const e of edges) {
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra === rb) continue
    // Smaller index becomes the root so labels are deterministic.
    if (ra < rb) parent[rb] = ra
    else parent[ra] = rb
  }
  const out = new Int32Array(n)
  for (let i = 0; i < n; i++) out[i] = find(i)
  return out
}

/** A split pair that has not armed yet: it cannot merge until it arms. */
export interface UnarmedPair {
  readonly a: number
  readonly b: number
  /** Sim step at which the pair was split from each other. */
  readonly splitStep: number
}

const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)
const make = (a: number, b: number, splitStep: number): UnarmedPair =>
  a < b ? { a, b, splitStep } : { a: b, b: a, splitStep }

/** Records of pairs of clouds that split from each other and have not armed yet. Absence of a record means armed. */
export class PairGate {
  private readonly records = new Map<string, UnarmedPair>()

  list(): UnarmedPair[] {
    return [...this.records.values()]
  }

  clear(): void {
    this.records.clear()
  }

  isUnarmed(a: number, b: number): boolean {
    return this.records.has(key(a, b))
  }

  /**
   * Cloud `oldId` split into `pieces`. Pieces are unarmed against each other from `step`, and they inherit
   * every unarmed record the old cloud had (with the original split step), so NoThrash survives repeated splits.
   */
  recordSplit(oldId: number, pieces: readonly number[], step: number): void {
    const inherited: UnarmedPair[] = []
    for (const r of [...this.records.values()]) {
      if (r.a !== oldId && r.b !== oldId) continue
      this.records.delete(key(r.a, r.b))
      inherited.push(r)
    }
    for (const r of inherited) {
      const other = r.a === oldId ? r.b : r.a
      for (const p of pieces) this.put(make(p, other, r.splitStep))
    }
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) this.put(make(pieces[i] ?? 0, pieces[j] ?? 0, step))
    }
  }

  /** Cloud `dropId` was absorbed into `keepId`: retarget its records. Self-pairs vanish; on a clash the later split wins. */
  recordMerge(dropId: number, keepId: number): void {
    for (const r of [...this.records.values()]) {
      if (r.a !== dropId && r.b !== dropId) continue
      this.records.delete(key(r.a, r.b))
      const other = r.a === dropId ? r.b : r.a
      if (other === keepId) continue
      this.put(make(keepId, other, r.splitStep))
    }
  }

  /** Remove (arm) every record for which `shouldArm` is true. Returns how many armed. */
  armWhere(shouldArm: (r: UnarmedPair) => boolean): number {
    let n = 0
    for (const [k, r] of [...this.records]) {
      if (shouldArm(r)) {
        this.records.delete(k)
        n++
      }
    }
    return n
  }

  private put(r: UnarmedPair): void {
    const k = key(r.a, r.b)
    const prev = this.records.get(k)
    if (!prev || prev.splitStep < r.splitStep) this.records.set(k, r)
  }
}
