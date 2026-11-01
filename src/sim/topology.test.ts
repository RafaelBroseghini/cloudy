import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { labelComponents, PairGate } from './topology.ts'

const graph = fc.integer({ min: 1, max: 30 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    edges: fc.array(fc.record({ a: fc.integer({ min: 0, max: n - 1 }), b: fc.integer({ min: 0, max: n - 1 }) }), { maxLength: 40 }),
  }),
)

describe('labelComponents', () => {
  it('agrees with a brute-force reachability closure and labels by smallest member', () => {
    fc.assert(
      fc.property(graph, ({ n, edges }) => {
        const root = labelComponents(n, edges)
        const reach = Array.from({ length: n }, (_, i) => new Set([i]))
        for (let changed = true; changed; ) {
          changed = false
          for (const e of edges) {
            const u = new Set([...(reach[e.a] as Set<number>), ...(reach[e.b] as Set<number>)])
            for (const x of u) {
              const r = reach[x] as Set<number>
              if (r.size !== u.size) {
                reach[x] = u
                changed = true
              }
            }
          }
        }
        for (let i = 0; i < n; i++) {
          expect(root[i]).toBe(Math.min(...(reach[i] as Set<number>)))
        }
      }),
      { numRuns: 100 },
    )
  })
})

describe('PairGate', () => {
  it('a split leaves every pair of pieces unarmed', () => {
    const g = new PairGate()
    g.recordSplit(1, [2, 3, 4], 10)
    expect(g.list().map((r) => `${r.a}:${r.b}:${r.splitStep}`).sort()).toEqual(['2:3:10', '2:4:10', '3:4:10'])
  })

  it('pieces of a later split inherit the original unarmed records and split step', () => {
    const g = new PairGate()
    g.recordSplit(1, [2, 3], 10)
    g.recordSplit(3, [4, 5], 50)
    expect(g.isUnarmed(2, 4)).toBe(true)
    expect(g.isUnarmed(2, 5)).toBe(true)
    expect(g.isUnarmed(4, 5)).toBe(true)
    expect(g.isUnarmed(2, 3)).toBe(false)
    expect(g.list().find((r) => r.a === 2 && r.b === 4)?.splitStep).toBe(10)
    expect(g.list().find((r) => r.a === 4 && r.b === 5)?.splitStep).toBe(50)
  })

  it('a merge retargets records and drops self-pairs', () => {
    const g = new PairGate()
    g.recordSplit(1, [2, 3, 4], 0)
    g.armWhere((r) => r.a === 3 && r.b === 4)
    g.recordMerge(3, 2) // 3 absorbed into 2
    expect(g.isUnarmed(2, 3)).toBe(false)
    expect(g.isUnarmed(2, 4)).toBe(true)
    expect(g.list().every((r) => r.a !== r.b)).toBe(true)
  })

  it('armWhere removes exactly the selected records', () => {
    const g = new PairGate()
    g.recordSplit(1, [2, 3, 4], 0)
    expect(g.armWhere((r) => r.a === 2)).toBe(2)
    expect(g.list()).toHaveLength(1)
  })
})
