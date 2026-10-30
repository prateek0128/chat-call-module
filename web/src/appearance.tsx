/**
 * AppearanceProvider: colour mode (light / dark / system), the 7 chat themes and wallpapers (global +
 * per chat), persisted in localStorage. It renders the `.ck-root` element that carries the design
 * tokens as CSS variables, so wrap every commskit-web screen in it.
 */
import { slot } from "./components";
import React, { createContext, CSSProperties, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  applyDisplay,
  applyWallpaper,
  createTheme,
  DEFAULT_APPEARANCE,
  parseAppearance,
  removeWallpaperOverride,
  resolveScheme,
  resolveWallpaper,
  sanitizeAppearance,
  serializeAppearance,
  wallpaperForPeer,
  type AppearanceMode,
  type AppearanceState,
  type ColorScheme,
  type Density,
  type PresetName,
  type TextSize,
  type Theme,
  type ThemeOverrides,
  type Wallpaper,
} from "commskit/engine";
import { DENSITIES, isPresetName, TEXT_SIZES } from "commskit/engine";
import { ComponentsProvider, type CommsComponents } from "./components";
import { cx, kebab, safeLocalStorage } from "./util";

export const APPEARANCE_STORAGE_KEY = "commskit.appearance.v1";

/** Minimal synchronous storage (window.localStorage fits). */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface AppearanceController {
  mode: AppearanceMode;
  preset: PresetName;
  textSize: TextSize;
  density: Density;
  /** Global wallpaper ("All chats"). */
  wallpaper: Wallpaper;
  /** Per-chat overrides by peer id. */
  perChat: Record<string, Wallpaper>;
  /** Resolved scheme after applying "system". */
  scheme: ColorScheme;
  /** True after a storage write failed (quota / blocked): choices last for this session only. */
  storageFailed: boolean;
  available: boolean;
  wallpaperFor: (peerId?: string | null) => Wallpaper;
  hasOverride: (peerId: string) => boolean;
  setMode: (mode: AppearanceMode) => void;
  setPreset: (preset: PresetName) => void;
  setTextSize: (textSize: TextSize) => void;
  setDensity: (density: Density) => void;
  /** Global wallpaper, or a chat's override with `{ peerId }`. */
  setWallpaper: (wallpaper: Wallpaper, options?: { peerId?: string | null }) => void;
  resetWallpaper: (peerId: string) => void;
  theme: Theme;
}

const noop = () => undefined;
const FALLBACK_THEME = createTheme({}, "light");
const FALLBACK: AppearanceController = {
  ...DEFAULT_APPEARANCE,
  scheme: "light",
  storageFailed: false,
  available: false,
  wallpaperFor: () => DEFAULT_APPEARANCE.wallpaper,
  hasOverride: () => false,
  setMode: noop,
  setPreset: noop,
  setTextSize: noop,
  setDensity: noop,
  setWallpaper: noop,
  resetWallpaper: noop,
  theme: FALLBACK_THEME,
};

const AppearanceContext = createContext<AppearanceController>(FALLBACK);

/** Appearance state + setters (defaults and no-op setters without a provider). */
export const useAppearance = (): AppearanceController => useContext(AppearanceContext);
/** The resolved theme object (tokens + chat theme + scheme). */
export const useTheme = (): Theme => useContext(AppearanceContext).theme;

export const themeCssVars = (theme: Theme): Record<string, string> => {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(theme.colors)) v[`--ck-${kebab(k)}`] = val;
  for (const [k, val] of Object.entries(theme.radius)) v[`--ck-radius-${k}`] = `${val}px`;
  for (const [k, val] of Object.entries(theme.space)) v[`--ck-space-${k}`] = `${val}px`;
  for (const [k, val] of Object.entries(theme.font.size)) v[`--ck-font-${k}`] = `${val}px`;
  for (const [k, val] of Object.entries(theme.font.weight)) v[`--ck-weight-${k}`] = String(val);
  for (const [k, val] of Object.entries(theme.shadow)) v[`--ck-shadow-${k}`] = val.css;
  for (const [k, val] of Object.entries(theme.motion.duration)) v[`--ck-dur-${k}`] = `${val}ms`;
  v["--ck-ease"] = `cubic-bezier(${theme.motion.easing.standard.join(", ")})`;
  v["--ck-font-family"] = theme.font.family;
  v["--ck-line-height"] = String(theme.font.lineHeight);
  v["--ck-tap"] = `${theme.layout.tapTarget}px`;
  v["--ck-bubble-max"] = `${theme.layout.bubbleMaxWidthPct}%`;
  v["--ck-composer-max-lines"] = String(theme.layout.composerMaxLines);
  return v;
};

const useSystemScheme = (): "light" | "dark" => {
  const query = "(prefers-color-scheme: dark)";
  const get = () => {
    try {
      return typeof window !== "undefined" && window.matchMedia && window.matchMedia(query).matches ? "dark" : "light";
    } catch {
      return "light";
    }
  };
  const [scheme, setScheme] = useState<"light" | "dark">(get);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setScheme(mq.matches ? "dark" : "light");
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return scheme;
};

export interface AppearanceProviderProps {
  children?: ReactNode;
  /** Storage for the preferences. Default `window.localStorage` (guarded). `null` disables persistence. */
  storage?: SyncStorage | null;
  storageKey?: string;
  /** Starting preferences (saved ones win). */
  initial?: Partial<AppearanceState>;
  /** Controlled mode: the host owns the state (no storage is used). */
  value?: AppearanceState;
  onChange?: (next: AppearanceState) => void;
  /** A storage write failed (e.g. quota): the choice is kept for the session. Show a toast here. */
  onStorageError?: (error: unknown) => void;
  /** Host overrides applied on top of the tokens (the chat theme preset is set by the user). */
  theme?: Omit<ThemeOverrides, "preset">;
  /** Replace built-in components (Avatar, MessageBubble, Composer, ConversationRow). Replacements get the default's props. */
  components?: Partial<CommsComponents>;
  className?: string;
  style?: CSSProperties;
}

export const AppearanceProvider: React.FC<AppearanceProviderProps> = ({
  children,
  storage,
  storageKey = APPEARANCE_STORAGE_KEY,
  initial,
  value,
  onChange,
  onStorageError,
  theme: themeOverrides,
  components,
  className,
  style,
}) => {
  const controlled = value !== undefined;
  const store = useMemo<SyncStorage | null>(() => (storage === undefined ? safeLocalStorage() : storage), [storage]);
  const [own, setOwn] = useState<AppearanceState>(() => {
    const base = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...(initial || {}) });
    if (!store) return base;
    try {
      const raw = store.getItem(storageKey);
      return raw ? parseAppearance(raw) : base;
    } catch {
      return base;
    }
  });
  const [storageFailed, setStorageFailed] = useState(false);
  const state = controlled ? sanitizeAppearance(value) : own;
  const latest = useRef(state);
  latest.current = state;
  const cb = useRef({ onChange, onStorageError });
  cb.current = { onChange, onStorageError };
  const system = useSystemScheme();
  const scheme = resolveScheme(state.mode === "system" ? "system" : state.mode, system);

  const update = useCallback(
    (fn: (s: AppearanceState) => AppearanceState) => {
      const next = fn(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      if (!controlled) {
        setOwn(next);
        if (store) {
          try {
            store.setItem(storageKey, serializeAppearance(next));
            setStorageFailed(false);
          } catch (e) {
            setStorageFailed(true);
            cb.current.onStorageError?.(e);
          }
        }
      }
      cb.current.onChange?.(next);
    },
    [controlled, store, storageKey],
  );

  const theme = useMemo(
    () => applyDisplay(createTheme({ ...(themeOverrides || {}), preset: state.preset }, scheme), { textSize: state.textSize, density: state.density }),
    [themeOverrides, state.preset, state.textSize, state.density, scheme],
  );

  const controller = useMemo<AppearanceController>(
    () => ({
      ...state,
      scheme,
      storageFailed,
      available: true,
      theme,
      wallpaperFor: (peerId) => wallpaperForPeer(state, peerId),
      hasOverride: (peerId) => Object.prototype.hasOwnProperty.call(state.perChat, peerId),
      setMode: (mode) => update((s) => (s.mode === mode ? s : { ...s, mode })),
      setPreset: (preset) => update((s) => (s.preset === preset || !isPresetName(preset) ? s : { ...s, preset })),
      setTextSize: (textSize) => update((s) => (s.textSize === textSize || !TEXT_SIZES.includes(textSize) ? s : { ...s, textSize })),
      setDensity: (density) => update((s) => (s.density === density || !DENSITIES.includes(density) ? s : { ...s, density })),
      setWallpaper: (w, options) => update((s) => applyWallpaper(s, w, options && options.peerId)),
      resetWallpaper: (peerId) => update((s) => removeWallpaperOverride(s, peerId)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controlled ? JSON.stringify(state) : state, scheme, storageFailed, theme, update],
  );

  const vars = useMemo(() => themeCssVars(theme), [theme]);
  return (
    <AppearanceContext.Provider value={controller}>
      <div className={cx("ck-root", className)} data-ck-scheme={scheme} data-ck-preset={state.preset} style={{ ...(vars as CSSProperties), ...style }}>
        <ComponentsProvider components={components}>{children}</ComponentsProvider>
      </div>
    </AppearanceContext.Provider>
  );
};

// ---- wallpaper layer -----------------------------------------------------------------------------

/** Chat background: default dots, solid, gradient or picture + dim overlay. Fills its (relative) parent. */
export const DefaultChatWallpaper: React.FC<{ wallpaper: Wallpaper; scheme?: ColorScheme; className?: string }> = ({ wallpaper, scheme, className }) => {
  const app = useAppearance();
  const sch = scheme || app.scheme;
  const r = resolveWallpaper(wallpaper, sch, app.theme.colors.wallpaper);
  const style: CSSProperties = {};
  let dim: CSSProperties | null = null;
  let kind: string = r.kind;
  if (r.kind === "color") {
    style.backgroundColor = r.color;
    if (r.pattern) kind = "dots";
  } else if (r.kind === "gradient") {
    style.backgroundColor = r.fallbackColor;
    style.backgroundImage = `linear-gradient(135deg, ${r.colors[0]}, ${r.colors[1]})`;
  } else {
    style.backgroundColor = r.fallbackColor;
    style.backgroundImage = `url("${r.uri.replace(/"/g, "%22")}")`;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
    dim = { backgroundColor: r.overlayColor, opacity: r.overlayOpacity };
  }
  return (
    <div className={cx("ck-wallpaper", className)} data-kind={kind} style={style} aria-hidden="true">
      {dim ? <div className="ck-wallpaper-dim" style={dim} /> : null}
    </div>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const ChatWallpaper = slot("ChatWallpaper", DefaultChatWallpaper);
