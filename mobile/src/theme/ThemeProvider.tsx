/**
 * ThemeProvider / useTheme. Components work without a provider (light theme, glyph icons).
 */
import React, { createContext, ReactNode, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";
import { createTheme, lightTheme, resolveScheme, type Theme, type ThemeOverrides } from "./createTheme";
import type { ColorScheme, PresetName } from "./tokens";
import type { IconName } from "./iconNames";
import { applyDisplay, type Density, type TextSize } from "./display";
import { SlotsProvider, type ComponentSlots } from "./slots";

export interface IconRenderProps {
  size: number;
  color: string;
}

/** Return a node to replace the glyph, or `undefined` to keep the built-in glyph. */
export type IconRenderer = (name: IconName, props: IconRenderProps) => ReactNode | undefined;

interface ThemeContextValue {
  theme: Theme;
  renderIcon?: IconRenderer;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: lightTheme });

export interface ThemeProviderProps {
  children?: ReactNode;
  /**
   * Token overrides (merged into both schemes; per-scheme colours via `schemes`),
   * a ready theme, or a function building the theme for the resolved scheme.
   */
  theme?: ThemeOverrides | Theme | ((scheme: ColorScheme, preset: PresetName) => Theme);
  /**
   * Chat theme preset (default "indigo" = the base tokens). Applied to the overrides form of
   * `theme` and passed to the function form; a ready `Theme` object is used as is.
   * <AppearanceProvider> sets this (and `colorScheme`) from the user's choice.
   */
  preset?: PresetName;
  /** End-user reading preferences, applied on top of the resolved theme (set by <AppearanceProvider>). */
  textSize?: TextSize;
  density?: Density;
  /** `"system"` (default) follows the OS setting via `useColorScheme()`. */
  colorScheme?: ColorScheme | "system";
  /** Swap the built-in glyph icons for your icon set (e.g. @expo/vector-icons). */
  renderIcon?: IconRenderer;
  /** Replace built-in components (Avatar; chat-ui: MessageBubble, Composer, ConversationRow). Replacements get the default's props. */
  components?: ComponentSlots;
}

const isTheme = (t: unknown): t is Theme =>
  !!t && typeof t === "object" && "scheme" in (t as Theme) && "colors" in (t as Theme) && "layout" in (t as Theme) && "space" in (t as Theme);

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children, theme, colorScheme = "system", preset, textSize, density, renderIcon, components }) => {
  const system = useColorScheme();
  const scheme = resolveScheme(colorScheme, system);
  const value = useMemo<ThemeContextValue>(() => {
    let resolved: Theme;
    if (typeof theme === "function") resolved = theme(scheme, preset || "indigo");
    else if (isTheme(theme)) resolved = theme;
    else resolved = createTheme(preset ? { ...(theme || {}), preset } : theme || {}, scheme);
    return { theme: applyDisplay(resolved, { textSize, density }), renderIcon };
  }, [theme, scheme, preset, textSize, density, renderIcon]);
  return <ThemeContext.Provider value={value}>
      <SlotsProvider components={components}>{children}</SlotsProvider>
    </ThemeContext.Provider>;
};

/** Current theme (light defaults when there is no ThemeProvider). */
export const useTheme = (): Theme => useContext(ThemeContext).theme;

/** Host icon renderer from ThemeProvider, if any. */
export const useIconRenderer = (): IconRenderer | undefined => useContext(ThemeContext).renderIcon;
