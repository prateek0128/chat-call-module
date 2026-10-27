/** Floating "sticky" date label while scrolling the message list. Pure. */
import type { MessageListRow } from "./grouping";

/** The label hides this long after the last scroll event. */
export const STICKY_LABEL_HIDE_MS = 1500;

/**
 * Day label for the oldest visible row of an inverted list (rows newest first): the first date
 * row at or after `topIndex` (date rows sit right after the oldest message of their day).
 */
export const stickyDateLabel = (rows: readonly MessageListRow[], topIndex: number): string | null => {
  if (!rows.length || topIndex < 0) return null;
  for (let i = Math.min(topIndex, rows.length - 1); i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === "date") return r.label;
  }
  return null;
};

/** Fade duration: 0 (instant) with reduced motion. */
export const stickyFadeDuration = (reducedMotion: boolean, base: number): number => (reducedMotion ? 0 : base);

export interface StickyLabelController {
  /** Call on every scroll event: shows the label and restarts the hide timer. */
  onScroll(): void;
  readonly visible: boolean;
  dispose(): void;
}

/**
 * Show-on-scroll / hide-after-idle timing. `onChange(visible)` fires only on changes.
 * Timers are injectable for tests.
 */
export const createStickyLabelController = (
  onChange: (visible: boolean) => void,
  opts: { hideAfterMs?: number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: any) => void } = {},
): StickyLabelController => {
  const hideAfter = opts.hideAfterMs ?? STICKY_LABEL_HIDE_MS;
  const set = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = opts.clearTimeout ?? ((h: any) => clearTimeout(h));
  let visible = false;
  let timer: unknown = null;
  const setVisible = (v: boolean) => {
    if (v === visible) return;
    visible = v;
    onChange(v);
  };
  return {
    onScroll() {
      setVisible(true);
      if (timer != null) clear(timer);
      timer = set(() => {
        timer = null;
        setVisible(false);
      }, hideAfter);
    },
    get visible() {
      return visible;
    },
    dispose() {
      if (timer != null) clear(timer);
      timer = null;
    },
  };
};
