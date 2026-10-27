import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sharedTicker } from "commskit/engine";

/** Re-render every `periodMs` (default 60 s) through one shared timer: "last seen 5 min ago" stays fresh. */
export const useTicker = (periodMs = 60000): number => {
  const t = sharedTicker(periodMs);
  return useSyncExternalStore(t.subscribe, t.getTick, t.getTick);
};

export const useReducedMotion = (): boolean => {
  const query = "(prefers-reduced-motion: reduce)";
  const get = () => {
    try {
      return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [v, setV] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setV(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return v;
};

/** Width of an element (ResizeObserver), used for the single / split layout decision. */
export const useElementWidth = <T extends HTMLElement>(): [React.RefObject<T | null>, number] => {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1024));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.round(el.getBoundingClientRect().width) || window.innerWidth);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return [ref, w];
};

/** Height the on-screen keyboard takes from the layout viewport (0 when closed / unsupported). */
export const useKeyboardInset = (): number => {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const on = () => {
      const i = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setInset(i > 80 ? i : 0); // small differences are browser chrome, not a keyboard
    };
    on();
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);
  return inset;
};

/** Polite screen-reader announcements: render `<LiveRegion text>` and call `announce(text)`. */
export const useAnnouncer = (): { text: string; announce: (text: string) => void } => {
  const [text, setText] = useState("");
  const flip = useRef(false);
  const announce = useCallback((t: string) => {
    flip.current = !flip.current;
    // a trailing zero-width char makes repeated identical messages re-announce
    setText(t + (flip.current ? "" : "​"));
  }, []);
  return { text, announce };
};

/** document.visibilityState === "visible", reactive. */
export const useTabVisible = (): boolean => {
  const get = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const [v, setV] = useState(get);
  useEffect(() => {
    const on = () => setV(get());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
};

export interface ToastItem {
  id: number;
  text: string;
  tone?: "info" | "error" | "success";
  action?: { label: string; onClick: () => void };
}

export const useToasts = (ttlMs = 4000) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, opts: { tone?: ToastItem["tone"]; action?: ToastItem["action"]; ms?: number } = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-2), { id, text, tone: opts.tone, action: opts.action }]);
      const ms = opts.ms ?? ttlMs;
      if (ms > 0) setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss, ttlMs],
  );
  return { toasts, show, dismiss };
};
