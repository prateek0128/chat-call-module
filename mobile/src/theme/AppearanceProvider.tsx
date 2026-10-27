/**
 * AppearanceProvider / useAppearance: the user's colour mode, chat theme and wallpapers, persisted
 * through an injectable storage adapter, driving <ThemeProvider> so the whole kit re-themes live.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  applyWallpaper,
  DEFAULT_APPEARANCE,
  removeWallpaperOverride,
  sanitizeAppearance,
  wallpaperForPeer,
  type AppearanceMode,
  type AppearanceState,
  type Wallpaper,
} from "./appearance";
import { APPEARANCE_STORAGE_KEY, defaultAppearanceStorage, loadAppearance, saveAppearance, type AppearanceStorage } from "./appearanceStorage";
import { isPresetName, type Theme, type ThemeOverrides } from "./createTheme";
import { ThemeProvider, type IconRenderer } from "./ThemeProvider";
import type { ColorScheme, PresetName } from "./tokens";

export interface AppearanceController {
  mode: AppearanceMode;
  preset: PresetName;
  /** Global wallpaper ("All chats"). */
  wallpaper: Wallpaper;
  /** Per-chat overrides by peer id. */
  perChat: Record<string, Wallpaper>;
  /** False until saved preferences have been read (or there is no provider). */
  ready: boolean;
  /** False without an <AppearanceProvider> (setters are no-ops). */
  available: boolean;
  /** Effective wallpaper for a chat (its override, else the global one). */
  wallpaperFor: (peerId?: string | null) => Wallpaper;
  /** True when the chat has its own wallpaper. */
  hasOverride: (peerId: string) => boolean;
  setMode: (mode: AppearanceMode) => void;
  setPreset: (preset: PresetName) => void;
  /** Global wallpaper, or a chat's override with `{ peerId }`. */
  setWallpaper: (wallpaper: Wallpaper, options?: { peerId?: string | null }) => void;
  /** Removes a chat's override. */
  resetWallpaper: (peerId: string) => void;
}

const noop = () => undefined;
const FALLBACK: AppearanceController = {
  ...DEFAULT_APPEARANCE,
  ready: true,
  available: false,
  wallpaperFor: () => DEFAULT_APPEARANCE.wallpaper,
  hasOverride: () => false,
  setMode: noop,
  setPreset: noop,
  setWallpaper: noop,
  resetWallpaper: noop,
};

const AppearanceContext = createContext<AppearanceController>(FALLBACK);

export interface AppearanceProviderProps {
  children?: ReactNode;
  /**
   * Async key-value storage. Default: @react-native-async-storage/async-storage if installed
   * (optional peer), else memory. `null` disables persistence.
   */
  storage?: AppearanceStorage | null;
  storageKey?: string;
  /** Starting preferences (used until / unless saved ones are found). */
  initial?: Partial<AppearanceState>;
  /** Controlled mode: the host owns the state (no storage is used). */
  value?: AppearanceState;
  /** Called with every change (controlled and uncontrolled). */
  onChange?: (next: AppearanceState) => void;
  /** Storage write failed (e.g. full): the choice is kept for this session. Show a toast here. */
  onStorageError?: (error: unknown) => void;
  /** Forwarded to the wrapped <ThemeProvider>. */
  theme?: ThemeOverrides | Theme | ((scheme: ColorScheme, preset: PresetName) => Theme);
  renderIcon?: IconRenderer;
  /** Set false if you render your own <ThemeProvider> (read `useAppearance()` for mode/preset). */
  wrapThemeProvider?: boolean;
}

export const AppearanceProvider: React.FC<AppearanceProviderProps> = ({
  children,
  storage,
  storageKey = APPEARANCE_STORAGE_KEY,
  initial,
  value,
  onChange,
  onStorageError,
  theme,
  renderIcon,
  wrapThemeProvider = true,
}) => {
  const controlled = value !== undefined;
  const store = useMemo(() => (storage === undefined ? defaultAppearanceStorage() : storage), [storage]);
  const [own, setOwn] = useState<AppearanceState>(() => sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...(initial || {}) }));
  const [ready, setReady] = useState(controlled || !store);
  const state = controlled ? sanitizeAppearance(value) : own;
  const latest = useRef(state);
  latest.current = state;
  const dirty = useRef(false);
  const cb = useRef({ onChange, onStorageError });
  cb.current = { onChange, onStorageError };

  // Hydrate once from storage (a change made before it finishes wins).
  useEffect(() => {
    if (controlled || !store) return;
    let alive = true;
    loadAppearance(store, storageKey).then((saved) => {
      if (!alive) return;
      if (!dirty.current) setOwn(saved);
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, storageKey]);

  // Persist after user changes.
  useEffect(() => {
    if (controlled || !store || !dirty.current) return;
    saveAppearance(store, own, storageKey).catch((e) => cb.current.onStorageError?.(e));
  }, [own, controlled, store, storageKey]);

  const update = useCallback(
    (fn: (s: AppearanceState) => AppearanceState) => {
      const next = fn(latest.current);
      if (next === latest.current) return;
      dirty.current = true;
      latest.current = next;
      if (!controlled) setOwn(next);
      cb.current.onChange?.(next);
    },
    [controlled],
  );

  const controller = useMemo<AppearanceController>(
    () => ({
      ...state,
      ready,
      available: true,
      wallpaperFor: (peerId) => wallpaperForPeer(state, peerId),
      hasOverride: (peerId) => Object.prototype.hasOwnProperty.call(state.perChat, peerId),
      setMode: (mode) => update((s) => (s.mode === mode ? s : { ...s, mode })),
      setPreset: (preset) => update((s) => (s.preset === preset || !isPresetName(preset) ? s : { ...s, preset })),
      setWallpaper: (w, options) => update((s) => applyWallpaper(s, w, options && options.peerId)),
      resetWallpaper: (peerId) => update((s) => removeWallpaperOverride(s, peerId)),
    }),
    // `state` is rebuilt each render in controlled mode; key on its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controlled ? JSON.stringify(state) : state, ready, update],
  );

  const content = wrapThemeProvider ? (
    <ThemeProvider theme={theme} colorScheme={state.mode} preset={state.preset} renderIcon={renderIcon}>
      {children}
    </ThemeProvider>
  ) : (
    children
  );
  return <AppearanceContext.Provider value={controller}>{content}</AppearanceContext.Provider>;
};

/** Appearance state + setters (defaults and no-op setters without a provider). */
export const useAppearance = (): AppearanceController => useContext(AppearanceContext);
