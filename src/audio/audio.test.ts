import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { thunderUrls } from './manifest.ts'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : [p]
  })
}

describe('iOS audio session', () => {
  it('src/ never references the page-level audio session API (silent switch and mixing stay as the platform default)', () => {
    // Built from parts so this file does not match itself.
    const needle = 'audio' + 'Session'
    const hits = sources(join(import.meta.dirname, '..')).filter((f) => readFileSync(f, 'utf8').includes(needle))
    expect(hits).toEqual([])
  })
})

describe('thunderUrls', () => {
  it('accepts an array of names, objects, or an object holding a list', () => {
    expect(thunderUrls(['a.mp3', 'b.mp3'], '/x/audio/')).toEqual(['/x/audio/a.mp3', '/x/audio/b.mp3'])
    expect(thunderUrls([{ file: 'a.mp3' }, { src: 'b.mp3' }, { nope: 1 }], '/audio/')).toEqual(['/audio/a.mp3', '/audio/b.mp3'])
    expect(thunderUrls({ files: ['a.mp3'] }, '/audio/')).toEqual(['/audio/a.mp3'])
    expect(thunderUrls({ files: [{ url: '/abs/a.mp3' }] }, '/audio/')).toEqual(['/abs/a.mp3'])
  })
  it('returns nothing for junk', () => {
    expect(thunderUrls(null, '/a/')).toEqual([])
    expect(thunderUrls(5, '/a/')).toEqual([])
    expect(thunderUrls({ files: 3 }, '/a/')).toEqual([])
  })
})
