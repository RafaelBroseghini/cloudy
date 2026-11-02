// thunder.json lists the clips. Accept the obvious shapes (array, or an object holding one) so the list can be edited by hand.

const NAME_KEYS = ['file', 'src', 'url', 'path', 'name'] as const

function entryName(e: unknown): string | null {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    for (const k of NAME_KEYS) {
      const v = (e as Record<string, unknown>)[k]
      if (typeof v === 'string') return v
    }
  }
  return null
}

/** URLs of the clips, relative names resolved against `dir` (e.g. `/audio/`). Anything unusable is dropped. */
export function thunderUrls(manifest: unknown, dir: string): string[] {
  let list: unknown = manifest
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>
    list = o.files ?? o.sounds ?? o.clips ?? o.thunder ?? o.items
  }
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const e of list) {
    const n = entryName(e)
    if (!n) continue
    out.push(/^(https?:)?\/\//.test(n) || n.startsWith('/') ? n : dir + n)
  }
  return out
}
