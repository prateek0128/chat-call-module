/**
 * Appearance model: colour mode, chat theme preset and chat wallpapers (global + per chat).
 * Pure: no React, no react-native. Local device preferences only; nothing is sent to the peer.
 */
import { isPresetName } from "./createTheme";
import { DEFAULT_DENSITY, DEFAULT_TEXT_SIZE, isDensity, isTextSize, type Density, type TextSize } from "./display";
import { colorTokens, wallpapers, type ColorScheme, type PresetName } from "./tokens";

export type AppearanceMode = "system" | "light" | "dark";

/**
 * A chat background. `solid` / `gradient` hold an index into `wallpapers.<scheme>.solids|gradients`
 * so the choice follows light/dark. `image.dim` is 0..imageDimMax; omitted = the scheme default
 * (`wallpapers.<scheme>.imageDimDefault`).
 */
export type Wallpaper =
  | { kind: "default" }
  | { kind: "solid"; index: number }
  | { kind: "gradient"; index: number }
  | { kind: "image"; uri: string; dim?: number };

export interface AppearanceState {
  mode: AppearanceMode;
  preset: PresetName;
  /** Text size (scales font sizes). */
  textSize: TextSize;
  /** Spacing density (comfortable or compact). */
  density: Density;
  /** Global wallpaper ("All chats"). */
  wallpaper: Wallpaper;
  /** Per-chat overrides by peer id ("This chat only"). */
  perChat: Record<string, Wallpaper>;
}

export const DEFAULT_WALLPAPER: Wallpaper = { kind: "default" };

export const DEFAULT_APPEARANCE: AppearanceState = { mode: "system", preset: "indigo", textSize: DEFAULT_TEXT_SIZE, density: DEFAULT_DENSITY, wallpaper: DEFAULT_WALLPAPER, perChat: {} };

/** What to draw for a wallpaper in a scheme. */
export type WallpaperRender =
  | { kind: "color"; color: string; pattern: boolean }
  | { kind: "gradient"; colors: [string, string]; start: { x: number; y: number }; end: { x: number; y: number }; fallbackColor: string }
  | { kind: "image"; uri: string; fallbackColor: string; overlayColor: string; overlayOpacity: number };

/** Dim for an image wallpaper: clamped to 0..imageDimMax; missing/invalid -> the scheme default. */
export const clampDim = (dim: unknown, scheme: ColorScheme = "light"): number => {
  const n = typeof dim === "number" && Number.isFinite(dim) ? dim : wallpapers[scheme].imageDimDefault;
  return Math.round(Math.min(wallpapers.imageDimMax, Math.max(0, n)) * 100) / 100;
};

const validIndex = (i: unknown, length: number): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < length;

/** Validated copy of an untrusted wallpaper value; anything unusable -> `default`. */
export const sanitizeWallpaper = (w: unknown): Wallpaper => {
  if (!w || typeof w !== "object") return DEFAULT_WALLPAPER;
  const v = w as Record<string, unknown>;
  switch (v.kind) {
    case "solid":
      return validIndex(v.index, wallpapers.light.solids.length) ? { kind: "solid", index: v.index } : DEFAULT_WALLPAPER;
    case "gradient":
      return validIndex(v.index, wallpapers.light.gradients.length) ? { kind: "gradient", index: v.index } : DEFAULT_WALLPAPER;
    case "image": {
      if (typeof v.uri !== "string" || !v.uri.trim()) return DEFAULT_WALLPAPER;
      return typeof v.dim === "number" && Number.isFinite(v.dim) ? { kind: "image", uri: v.uri, dim: clampDim(v.dim) } : { kind: "image", uri: v.uri };
    }
    default:
      return DEFAULT_WALLPAPER;
  }
};

/**
 * Render model for a wallpaper. `baseColor` is the theme's `colors.wallpaper` (host overrides),
 * used for `default` and as the fallback behind gradients / images.
 */
export const resolveWallpaper = (w: Wallpaper | null | undefined, scheme: ColorScheme, baseColor: string = colorTokens[scheme].wallpaper): WallpaperRender => {
  const s = sanitizeWallpaper(w);
  const set = wallpapers[scheme];
  switch (s.kind) {
    case "solid":
      return { kind: "color", color: set.solids[s.index], pattern: false };
    case "gradient": {
      const [a, b] = set.gradients[s.index];
      return { kind: "gradient", colors: [a, b], start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, fallbackColor: a };
    }
    case "image":
      return {
        kind: "image",
        uri: s.uri,
        fallbackColor: baseColor,
        overlayColor: scheme === "dark" ? "#000000" : "#FFFFFF",
        overlayOpacity: clampDim(s.dim, scheme),
      };
    default:
      return { kind: "color", color: baseColor, pattern: true };
  }
};

/** Effective wallpaper for a chat: its override, else the global one. */
export const wallpaperForPeer = (state: AppearanceState, peerId?: string | null): Wallpaper =>
  (peerId && Object.prototype.hasOwnProperty.call(state.perChat, peerId) && state.perChat[peerId]) || state.wallpaper;

/** Sets the global wallpaper, or a chat's override when `peerId` is given. */
export const applyWallpaper = (state: AppearanceState, w: Wallpaper, peerId?: string | null): AppearanceState => {
  const clean = sanitizeWallpaper(w);
  if (peerId) return { ...state, perChat: { ...state.perChat, [peerId]: clean } };
  return { ...state, wallpaper: clean };
};

/** Removes a chat's override (it follows the global wallpaper again). */
export const removeWallpaperOverride = (state: AppearanceState, peerId: string): AppearanceState => {
  if (!Object.prototype.hasOwnProperty.call(state.perChat, peerId)) return state;
  const perChat = { ...state.perChat };
  delete perChat[peerId];
  return { ...state, perChat };
};

const isMode = (v: unknown): v is AppearanceMode => v === "system" || v === "light" || v === "dark";

/** Validated state from untrusted input (partial input keeps the defaults for the rest). */
export const sanitizeAppearance = (input: unknown): AppearanceState => {
  if (!input || typeof input !== "object") return { ...DEFAULT_APPEARANCE, perChat: {} };
  const v = input as Record<string, unknown>;
  const perChat: Record<string, Wallpaper> = {};
  if (v.perChat && typeof v.perChat === "object" && !Array.isArray(v.perChat)) {
    for (const [peer, w] of Object.entries(v.perChat as Record<string, unknown>)) {
      if (!peer) continue;
      const clean = sanitizeWallpaper(w);
      perChat[peer] = clean;
    }
  }
  return {
    mode: isMode(v.mode) ? v.mode : DEFAULT_APPEARANCE.mode,
    preset: isPresetName(v.preset) ? v.preset : DEFAULT_APPEARANCE.preset,
    textSize: isTextSize(v.textSize) ? v.textSize : DEFAULT_TEXT_SIZE,
    density: isDensity(v.density) ? v.density : DEFAULT_DENSITY,
    wallpaper: v.wallpaper === undefined ? DEFAULT_WALLPAPER : sanitizeWallpaper(v.wallpaper),
    perChat,
  };
};

export const APPEARANCE_VERSION = 1;

/** JSON for storage. */
export const serializeAppearance = (state: AppearanceState): string => JSON.stringify({ v: APPEARANCE_VERSION, ...sanitizeAppearance(state) });

/** State from stored JSON; null, corrupted or foreign data -> safe defaults. */
export const parseAppearance = (raw: string | null | undefined): AppearanceState => {
  if (!raw) return sanitizeAppearance(null);
  try {
    return sanitizeAppearance(JSON.parse(raw));
  } catch {
    return sanitizeAppearance(null);
  }
};
