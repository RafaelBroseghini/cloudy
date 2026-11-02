// UI-only state (the fold) under its own key, "cloudy:ui". Deliberately outside the validated settings schema: it is not
// gameplay. Every access is in try/catch (private mode, blocked storage) and the page works without it.
import { browserStorage, type StorageSource } from '../settings/index.ts'

export const UI_KEY = 'cloudy:ui'

/** The saved fold state, or null when nothing usable is stored. */
export function parseOpen(raw: string | null | undefined): boolean | null {
  if (typeof raw !== 'string') return null
  try {
    const json: unknown = JSON.parse(raw)
    const open = typeof json === 'object' && json !== null ? (json as { open?: unknown }).open : undefined
    return typeof open === 'boolean' ? open : null
  } catch {
    return null
  }
}

/**
 * Open or folded at load. A phone always starts folded (the sheet must not cover the game before the player asks for it);
 * elsewhere the last choice wins, else open.
 */
export function initialOpen(narrow: boolean, source: StorageSource = browserStorage): boolean {
  if (narrow) return false
  try {
    return parseOpen(source()?.getItem(UI_KEY)) ?? true
  } catch {
    return true
  }
}

export function saveOpen(open: boolean, source: StorageSource = browserStorage): void {
  try {
    source()?.setItem(UI_KEY, JSON.stringify({ open }))
  } catch {
    // Blocked or full: the fold just does not persist.
  }
}
