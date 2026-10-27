/** Theme object + `createTheme(overrides, scheme)`. Pure: no React, no react-native. */
import {
  avatarPalette,
  colorTokens,
  font,
  layout,
  motion,
  radius,
  shadow,
  space,
  themePresets,
  type ColorScheme,
  type ColorTokens,
  type FontWeight,
  type PresetName,
  type ShadowToken,
} from "./tokens";

export interface Theme {
  scheme: ColorScheme;
  colors: ColorTokens;
  avatarPalette: string[];
  radius: typeof radius;
  space: typeof space;
  font: {
    /** CSS font stack from tokens.json (web). Not used on native. */
    family: string;
    /** Native font family. `undefined` = platform system font (default). */
    nativeFamily?: string;
    size: typeof font.size;
    weight: Record<keyof typeof font.weight, FontWeight>;
    lineHeight: number;
  };
  shadow: Record<keyof typeof shadow, ShadowToken>;
  motion: typeof motion;
  layout: typeof layout;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ThemeOverrides extends DeepPartial<Omit<Theme, "scheme" | "colors">> {
  /**
   * Chat theme preset (tokens.json themePresets). Replaces the accent family and outgoing-bubble
   * colours of the light/dark base; "indigo" (default) equals the base. Host `colors` / `schemes`
   * overrides still win over the preset.
   */
  preset?: PresetName;
  /** Colour overrides applied to both schemes. */
  colors?: Partial<ColorTokens>;
  /** Per-scheme colour overrides (win over `colors`). */
  schemes?: { light?: Partial<ColorTokens>; dark?: Partial<ColorTokens> };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const merge = <T>(base: T, patch: unknown): T => {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out as T;
};

/** Builds a full theme for `scheme` from the tokens plus host overrides. */
export const createTheme = (overrides: ThemeOverrides = {}, scheme: ColorScheme = "light"): Theme => {
  const { colors, schemes, preset, ...rest } = overrides;
  const presetColors = isPresetName(preset) ? themePresets[scheme][preset] : undefined;
  const base: Theme = {
    scheme,
    colors: { ...colorTokens[scheme], ...(presetColors || {}), ...(colors || {}), ...((schemes && schemes[scheme]) || {}) },
    avatarPalette: avatarPalette.slice(),
    radius: { ...radius },
    space: { ...space },
    font: { family: font.family, nativeFamily: undefined, size: { ...font.size }, weight: { ...font.weight }, lineHeight: font.lineHeight },
    shadow: { sm: shadow.sm, md: shadow.md, lg: shadow.lg },
    motion: { duration: { ...motion.duration }, easing: { ...motion.easing } },
    layout: { ...layout },
  };
  const merged = merge(base, rest);
  if (rest.avatarPalette && rest.avatarPalette.length) merged.avatarPalette = rest.avatarPalette.slice();
  return merged;
};

/** True for a known preset name. */
export const isPresetName = (v: unknown): v is PresetName => typeof v === "string" && (themePresets.order as string[]).includes(v);

/** `"system"` resolves to the OS scheme (`null`/unknown -> light). */
export const resolveScheme = (preference: ColorScheme | "system" | undefined, system: string | null | undefined): ColorScheme => {
  if (preference === "light" || preference === "dark") return preference;
  return system === "dark" ? "dark" : "light";
};

/** Line height in px for a font size (tokens use a 1.4 multiplier). */
export const lineHeightFor = (theme: Pick<Theme, "font">, size: number): number => Math.round(size * theme.font.lineHeight);

/** RN shadow style for a shadow token (iOS shadow* + Android elevation). */
export const shadowStyle = (theme: Pick<Theme, "shadow" | "scheme">, level: keyof Theme["shadow"]) => {
  const token = theme.shadow[level];
  const s = token.rn;
  // Shadow colour comes from the token's CSS value (opacity is applied separately on native).
  const rgb = token.css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return {
    shadowColor: rgb ? `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})` : "black",
    shadowOpacity: s.shadowOpacity,
    shadowRadius: s.shadowRadius,
    shadowOffset: { width: 0, height: s.shadowOffsetY },
    elevation: s.elevation,
  };
};

export const lightTheme: Theme = createTheme({}, "light");
export const darkTheme: Theme = createTheme({}, "dark");
