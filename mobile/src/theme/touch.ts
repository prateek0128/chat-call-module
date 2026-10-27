/** Touch-target helpers (pure). */

export interface SlopInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** hitSlop that grows a `size` element to the `target` touch size (layout.tapTarget, 44pt). */
export const slopFor = (size: number | undefined, target: number): SlopInsets | undefined => {
  if (!size || size >= target) return undefined;
  const d = Math.ceil((target - size) / 2);
  return { top: d, bottom: d, left: d, right: d };
};
