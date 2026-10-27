/** Small colour helpers (pure). Accepts #RGB, #RRGGBB and rgb()/rgba() strings. */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const parseColor = (input: string): Rgba | null => {
  const c = (input || "").trim();
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split("").map((x) => parseInt(x + x, 16));
    return { r, g, b, a: 1 };
  }
  m = c.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
  return null;
};

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0").toUpperCase();

export const toColorString = ({ r, g, b, a }: Rgba): string =>
  a >= 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;

/** Linear mix of two colours: t = 0 -> a, t = 1 -> b. Unparseable input returns `a`. */
export const mixColor = (a: string, b: string, t: number): string => {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  const k = Math.min(1, Math.max(0, t));
  return toColorString({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k, a: x.a + (y.a - x.a) * k });
};

/** Same colour with a new alpha (0..1). */
export const withAlpha = (color: string, alpha: number): string => {
  const c = parseColor(color);
  return c ? toColorString({ ...c, a: Math.min(1, Math.max(0, alpha)) }) : color;
};

/** `steps` colours evenly spaced from `start` to `end` (a stepped vertical gradient without native deps). */
export const gradientStops = (start: string, end: string, steps: number): string[] => {
  const n = Math.max(2, Math.floor(steps));
  return Array.from({ length: n }, (_, i) => mixColor(start, end, i / (n - 1)));
};
