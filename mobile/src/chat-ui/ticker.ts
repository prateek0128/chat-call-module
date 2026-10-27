/**
 * One shared interval per period for relative-time labels ("last seen 5 min ago"): any number of
 * subscribers, one timer, started with the first subscriber and stopped with the last. Pure.
 */

export interface SharedTicker {
  subscribe(listener: () => void): () => void;
  /** Increments on every tick. */
  getTick(): number;
  /** Active subscribers (tests). */
  readonly size: number;
}

export const createSharedTicker = (
  intervalMs: number,
  timers: { setInterval?: (fn: () => void, ms: number) => unknown; clearInterval?: (h: any) => void } = {},
): SharedTicker => {
  const set = timers.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = timers.clearInterval ?? ((h: any) => clearInterval(h));
  const listeners = new Set<() => void>();
  let handle: unknown = null;
  let tick = 0;
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (handle == null) {
        handle = set(() => {
          tick += 1;
          listeners.forEach((l) => l());
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && handle != null) {
          clear(handle);
          handle = null;
        }
      };
    },
    getTick: () => tick,
    get size() {
      return listeners.size;
    },
  };
};

const tickers = new Map<number, SharedTicker>();

/** The process-wide ticker for `intervalMs` (default 60 s). */
export const sharedTicker = (intervalMs = 60000): SharedTicker => {
  let t = tickers.get(intervalMs);
  if (!t) {
    t = createSharedTicker(intervalMs);
    tickers.set(intervalMs, t);
  }
  return t;
};
