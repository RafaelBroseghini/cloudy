// Motion (springs and keyframes for the panel's small touches). `motion/mini` is the WAAPI build (a few kB, the springs
// are baked into native easings), loaded by dynamic import so it is its own chunk and the base bundle never pays for it;
// until it arrives the panel simply changes without animating. The caller skips every call under reduced motion.
export interface MotionApi {
  animate: typeof import('motion/mini').animate
}

let cached: Promise<MotionApi | null> | undefined
export function loadMotion(): Promise<MotionApi | null> {
  cached ??= import('motion/mini').then((m) => ({ animate: m.animate }) as MotionApi).catch(() => null)
  return cached
}

const PRESS = { type: 'spring', stiffness: 520, damping: 24 } as const
const RELEASE = { type: 'spring', stiffness: 380, damping: 11 } as const

/** The dice: two full turns with a bounce, a hop in scale; the die face is swapped by the caller at the midpoint. */
export function tumble(m: MotionApi, el: HTMLElement): void {
  m.animate(el, { rotate: ['0deg', '720deg'] }, { type: 'spring', duration: 0.9, bounce: 0.22 })
  m.animate(el, { scale: [1, 1.28, 1] }, { duration: 0.6, ease: 'easeInOut' })
}

/** A pebble or chip pressed in, then released with a little overshoot. */
export function pressIn(m: MotionApi, el: HTMLElement): void {
  m.animate(el, { scale: 0.94 }, PRESS)
}
export function pressOut(m: MotionApi, el: HTMLElement): void {
  m.animate(el, { scale: 1 }, RELEASE)
}

/**
 * The slider handle's squash and stretch. The thumb is a pseudo-element Motion cannot address, so the CSS reads
 * `--sx` / `--sy` off the input (declared with `@property`, so the browser can interpolate them) and Motion animates those.
 */
export function squash(m: MotionApi, input: HTMLElement): void {
  m.animate(input, { '--sx': 1.14, '--sy': 0.9 }, PRESS)
}
export function stretch(m: MotionApi, input: HTMLElement): void {
  m.animate(input, { '--sx': 1.26, '--sy': 0.84 }, { type: 'spring', stiffness: 700, damping: 30 })
}
export function relax(m: MotionApi, input: HTMLElement): void {
  m.animate(input, { '--sx': 1, '--sy': 1 }, RELEASE)
}
