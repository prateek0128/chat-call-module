/**
 * Persistence for appearance preferences through an injectable async key-value adapter.
 * Default: `@react-native-async-storage/async-storage` (OPTIONAL peer, lazily required once),
 * falling back to memory (preferences then last for the session only). Pure: no React / RN.
 */
import { parseAppearance, serializeAppearance, type AppearanceState } from "./appearance";

export interface AppearanceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const APPEARANCE_STORAGE_KEY = "commskit.appearance.v1";

/** In-memory adapter (tests, or when no persistent storage is installed). */
export const createMemoryStorage = (initial: Record<string, string> = {}): AppearanceStorage & { data: Record<string, string> } => {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: async (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: async (key, value) => {
      data[key] = value;
    },
    removeItem: async (key) => {
      delete data[key];
    },
  };
};

let defaultStorage: AppearanceStorage | null = null;

/** The optional async-storage module if installed, else a shared in-memory adapter. */
export const defaultAppearanceStorage = (): AppearanceStorage => {
  if (defaultStorage) return defaultStorage;
  try {
    // Optional peer; enable metro `transformer.allowOptionalDependencies` if it is not installed.
    const mod = require("@react-native-async-storage/async-storage");
    const store = mod && (mod.default || mod);
    defaultStorage = store && typeof store.getItem === "function" ? (store as AppearanceStorage) : createMemoryStorage();
  } catch {
    defaultStorage = createMemoryStorage();
  }
  return defaultStorage as AppearanceStorage;
};

/** Reads saved preferences; read errors or corrupted data -> defaults. */
export const loadAppearance = async (storage: AppearanceStorage, key: string = APPEARANCE_STORAGE_KEY): Promise<AppearanceState> => {
  try {
    return parseAppearance(await storage.getItem(key));
  } catch {
    return parseAppearance(null);
  }
};

/** Writes preferences. Rejects when the storage write fails (e.g. full): the caller keeps the state for the session. */
export const saveAppearance = (storage: AppearanceStorage, state: AppearanceState, key: string = APPEARANCE_STORAGE_KEY): Promise<void> =>
  storage.setItem(key, serializeAppearance(state));
