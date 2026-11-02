// Inline SVG for the Sky panel (stroke icons on a 24 grid), lifted from the approved mockup. Static strings only.
export const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  cloud: '<path d="M7.5 18.5a4.2 4.2 0 0 1-.6-8.36A5.6 5.6 0 0 1 17.6 9.4a4.55 4.55 0 0 1-.1 9.1z"/>',
  rain: '<path d="M7.5 15.5a4 4 0 0 1-.5-7.97A5.4 5.4 0 0 1 17.3 7a4.2 4.2 0 0 1 0 8.5z"/><path d="M8.5 18.5l-1 2.5M12.5 18.5l-1 2.5M16.5 18.5l-1 2.5"/>',
  bolt: '<path d="M7.5 15a4 4 0 0 1-.5-7.97A5.4 5.4 0 0 1 17.3 6.5a4.2 4.2 0 0 1 .2 8.5"/><path d="M12.5 11l-2.5 4.5h3.5L11.5 21"/>',
  wind: '<path d="M3 8.5h10.5a2.7 2.7 0 1 0-2.6-3.3M3 12.5h14.5a2.7 2.7 0 1 1-2.6 3.3M3 16.5h6"/>',
  layers: '<path d="M12 3.5l9 4.7-9 4.7-9-4.7z"/><path d="M3 12.6l9 4.7 9-4.7"/><path d="M3 16.6l9 4.7 9-4.7"/>',
  blob: '<path d="M12 4.5c4.2 0 7.5 2.9 7.5 7s-3 8-7.5 8-7.5-3.5-7.5-8 3.3-7 7.5-7z"/><path d="M9 9.5c.8-1 1.8-1.5 3-1.5"/>',
  tornado: '<path d="M4 5h16M6 9h12M8 13h8M10 17h4M12 21h.01"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
} as const
export type IconName = keyof typeof ICONS

export const icon = (name: IconName, size = 22, fill = 'none'): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`

const PIPS: Record<number, readonly (readonly [number, number])[]> = {
  1: [[12, 12]],
  2: [[8, 8], [16, 16]],
  3: [[8, 8], [12, 12], [16, 16]],
  4: [[8, 8], [16, 8], [8, 16], [16, 16]],
  5: [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]],
  6: [[8, 8], [16, 8], [8, 12], [16, 12], [8, 16], [16, 16]],
}

/** A die face 1..6 (anything else shows 5). */
export const dieSvg = (n: number): string => {
  const pips = PIPS[n] ?? PIPS[5] ?? []
  const dots = pips.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.3" fill="currentColor" stroke="none"/>`).join('')
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/>${dots}</svg>`
}
