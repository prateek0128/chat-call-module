/**
 * commskit/theme — design tokens, theme, and the shared UI primitives used by
 * chat-ui and call-ui (Avatar, Icon, ScalePressable, safe-area insets).
 * Imports only react / react-native. Never imports chat, call or any *-ui.
 */

export {
  tokens,
  colorTokens,
  avatarPalette,
  radius,
  space,
  font,
  shadow,
  motion,
  layout,
  type ColorName,
  type ColorScheme,
  type ColorTokens,
  type CubicBezier,
  type FontWeight,
  type ShadowToken,
  type Tokens,
  themePresets,
  wallpapers,
  type PresetColorKey,
  type PresetColors,
  type PresetName,
  type WallpaperSchemeTokens,
} from "./tokens";
export { createTheme, isPresetName, darkTheme, lightTheme, lineHeightFor, resolveScheme, shadowStyle, type Theme, type ThemeOverrides } from "./createTheme";
export { gradientStops, mixColor, parseColor, toColorString, withAlpha, type Rgba } from "./color";
export { decideLayout, MAX_CONTENT_WIDTH, type LayoutDecision, type LayoutTokens } from "./layout";
export { avatarColor, initialsOf } from "./avatarColors";
export { DEFAULT_GLYPHS, type IconName } from "./iconNames";
export { ThemeProvider, useIconRenderer, useTheme, type IconRenderer, type IconRenderProps, type ThemeProviderProps } from "./ThemeProvider";
export { announce, useReducedMotion, useResponsiveLayout } from "./hooks";
export { useSafeInsets, ZERO_INSETS, type EdgeInsets } from "./safeArea";
export { Avatar, type AvatarProps } from "./Avatar";
export { Icon, type IconProps } from "./Icon";
export { ScalePressable, type ScalePressableProps } from "./ScalePressable";
export { slopFor, type SlopInsets } from "./touch";
export {
  applyWallpaper,
  clampDim,
  DEFAULT_APPEARANCE,
  DEFAULT_WALLPAPER,
  parseAppearance,
  removeWallpaperOverride,
  resolveWallpaper,
  sanitizeAppearance,
  sanitizeWallpaper,
  serializeAppearance,
  wallpaperForPeer,
  type AppearanceMode,
  type AppearanceState,
  type Wallpaper,
  type WallpaperRender,
} from "./appearance";
export {
  APPEARANCE_STORAGE_KEY,
  createMemoryStorage,
  defaultAppearanceStorage,
  loadAppearance,
  saveAppearance,
  type AppearanceStorage,
} from "./appearanceStorage";
export { AppearanceProvider, useAppearance, type AppearanceController, type AppearanceProviderProps } from "./AppearanceProvider";
