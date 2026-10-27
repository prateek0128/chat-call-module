/**
 * Stored session for headless work while the app is killed (decline from the call notification
 * -> `POST /call/{call_id}/reject`, PROTOCOL §4). Pure; the default storage is
 * @react-native-async-storage/async-storage (optional peer, lazily required only here in call-native).
 */
import { authFetch } from "../core/config";

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface StoredCallSession {
  baseUrl: string;
  token: string;
}

export const CALL_SESSION_KEY = "commskit.callSession";

const memory = new Map<string, string>();
const memoryStorage: KeyValueStorage = {
  getItem: async (k) => memory.get(k) ?? null,
  setItem: async (k, v) => void memory.set(k, v),
  removeItem: async (k) => void memory.delete(k),
};

/** async-storage when installed, else an in-memory map (which does NOT survive the app being killed). */
export const defaultSessionStorage = (): KeyValueStorage => {
  try {
    const mod = require("@react-native-async-storage/async-storage");
    const store = mod?.default ?? mod;
    if (store?.getItem) return store as KeyValueStorage;
  } catch {
    /* optional */
  }
  return memoryStorage;
};

/**
 * Save `{baseUrl, token}` after login and whenever the token refreshes, so a killed app can
 * still decline a call. Use secure storage (e.g. expo-secure-store wrapped as KeyValueStorage)
 * if your threat model requires it.
 */
export const saveCallSession = async (session: StoredCallSession, storage: KeyValueStorage = defaultSessionStorage()): Promise<void> => {
  await storage.setItem(CALL_SESSION_KEY, JSON.stringify(session));
};

/** Forget the session (logout). */
export const clearCallSession = async (storage: KeyValueStorage = defaultSessionStorage()): Promise<void> => {
  await storage.removeItem(CALL_SESSION_KEY);
};

export const loadCallSession = async (storage: KeyValueStorage = defaultSessionStorage()): Promise<StoredCallSession | null> => {
  try {
    const raw = await storage.getItem(CALL_SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.baseUrl === "string" && typeof parsed.token === "string" ? parsed : null;
  } catch {
    return null;
  }
};

/** `POST /call/{call_id}/reject` with the stored session. Resolves false when there is no session or it fails. */
export const rejectCallWithStoredSession = async (callId: string, storage: KeyValueStorage = defaultSessionStorage()): Promise<boolean> => {
  const session = await loadCallSession(storage);
  if (!session) return false;
  try {
    await authFetch({ baseUrl: session.baseUrl, getToken: () => session.token }, `/call/${encodeURIComponent(callId)}/reject`, { method: "POST" });
    return true;
  } catch {
    return false;
  }
};
