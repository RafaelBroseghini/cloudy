// Opens the dev panel: the ` key or `?dev`. lil-gui is a separate chunk, loaded by dynamic import the first time the
// panel opens, so this file (which main.ts imports) costs nothing when the panel is never used.
import type { GameHarnessApi } from '../harness.ts'

export interface DevHost {
  readonly api: GameHarnessApi
  /** Moving average of the wall-clock cost of one sim step, ms. */
  simStepMs(): number
}

export interface DevPanel {
  setVisible(on: boolean): void
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'number', 'search', 'tel', 'url', 'email', 'password'])

/** True while a key press is going into a text field (so keys 1..4 and ` must not act as game shortcuts). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)
}

export function installDevPanel(host: DevHost): void {
  let panel: DevPanel | null = null;
  let loading = false;
  let wantOpen = false;

  const setOpen = async (open: boolean): Promise<void> => {
    wantOpen = open;
    if (panel) return panel.setVisible(open);
    if (!open || loading) return;
    loading = true;
    try {
      const m = await import('./panel.ts');
      panel = m.createDevPanel(host);
    } catch (err) {
      console.error('dev panel failed to load', err);
    } finally {
      loading = false;
    }
    panel?.setVisible(wantOpen);
  };

  window.addEventListener('keydown', (e) => {
    if (e.key !== '`' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    void setOpen(!wantOpen);
  }, true); // capture: lil-gui stops keydown from bubbling out of its controls, and ` must still close the panel
  if (new URLSearchParams(location.search).has('dev')) void setOpen(true);
}
