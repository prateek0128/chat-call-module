/** Reading preferences chosen by the end user: text size and density. Pure: no React, no react-native. */
import type { Theme } from "./createTheme";

export type TextSize = "small" | "medium" | "large";
export type Density = "comfortable" | "compact";

export const TEXT_SIZES: readonly TextSize[] = ["small", "medium", "large"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];
export const DEFAULT_TEXT_SIZE: TextSize = "medium";
export const DEFAULT_DENSITY: Density = "comfortable";

const TEXT_SCALE: Record<TextSize, number> = { small: 0.9, medium: 1, large: 1.2 };
const SPACE_SCALE: Record<Density, number> = { comfortable: 1, compact: 0.75 };

export const isTextSize = (v: unknown): v is TextSize => v === "small" || v === "medium" || v === "large";
export const isDensity = (v: unknown): v is Density => v === "comfortable" || v === "compact";

const scaleValues = <T extends Record<string, number>>(obj: T, k: number): T => {
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(obj)) out[key] = Math.max(1, Math.round(val * k));
  return out as T;
};

/** Theme with font sizes scaled by the text size and spacing scaled by the density (defaults return `theme` itself). */
export const applyDisplay = (theme: Theme, display: { textSize?: TextSize; density?: Density }): Theme => {
  const text = TEXT_SCALE[display.textSize || DEFAULT_TEXT_SIZE] ?? 1;
  const space = SPACE_SCALE[display.density || DEFAULT_DENSITY] ?? 1;
  if (text === 1 && space === 1) return theme;
  return {
    ...theme,
    font: text === 1 ? theme.font : { ...theme.font, size: scaleValues(theme.font.size, text) },
    space: space === 1 ? theme.space : scaleValues(theme.space, space),
  };
};
