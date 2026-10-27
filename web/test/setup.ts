import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom gaps used by the UI
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ||= RO;
if (!window.matchMedia) {
  window.matchMedia = (q: string) =>
    ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList;
}
Element.prototype.scrollTo = Element.prototype.scrollTo || function () {};
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {};
(window as any).CSS ||= {};
(window as any).CSS.escape ||= (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\$&");
let n = 0;
URL.createObjectURL = URL.createObjectURL || (() => `blob:test/${++n}`);
URL.revokeObjectURL = URL.revokeObjectURL || (() => {});
window.requestAnimationFrame = window.requestAnimationFrame || ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
window.focus = () => {};
