/** Demo login state: server URL, the picked demo user, its token and the feature mode. Persisted. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

export type Feature = "chat" | "call";
export type Mode = "chat" | "calls" | "both";

export interface DemoUser {
  id: string;
  name: string;
}

export interface Session {
  baseUrl: string;
  userId: string;
  userName: string;
  token: string;
  mode: Mode;
  /** Features the server runs (GET /dev/users). */
  features: Feature[];
  /** Demo users (for the call-only people list and the standalone report sheet). */
  users: DemoUser[];
}

const SESSION_KEY = "demo.session";
const SERVER_KEY = "demo.serverUrl";

/** app.json -> expo.extra.apiUrl ("http://<PC LAN IP>:8000"). Editable on the login screen. */
export const DEFAULT_API_URL: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "http://192.168.1.10:8000";

export const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "");

export const modeHasChat = (mode: Mode) => mode !== "calls";
export const modeHasCalls = (mode: Mode) => mode !== "chat";

/** Modes the server allows (a chat-only server can't do Calls / Both, ...). */
export const allowedModes = (features: Feature[]): Mode[] => {
  const chat = features.includes("chat");
  const call = features.includes("call");
  return [chat && "chat", call && "calls", chat && call && "both"].filter(Boolean) as Mode[];
};

export const loadServerUrl = async (): Promise<string> => {
  try {
    return (await AsyncStorage.getItem(SERVER_KEY)) || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
};

export const saveServerUrl = (url: string) => AsyncStorage.setItem(SERVER_KEY, url).catch(() => undefined);

export const loadSession = async (): Promise<Session | null> => {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
};

export const saveSession = (s: Session) => AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s)).catch(() => undefined);
export const clearSession = () => AsyncStorage.removeItem(SESSION_KEY).catch(() => undefined);

const getJson = async <T,>(url: string, timeoutMs = 8000): Promise<T> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || ""}`.trim());
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

/** Demo server only: `GET /dev/users` -> {features, users}. */
export const fetchDemoUsers = (baseUrl: string) => getJson<{ features: Feature[]; users: DemoUser[] }>(`${baseUrl}/dev/users`);

/** Demo server only: `GET /dev/token/{id}` -> {token}. A real app gets its JWT from its own login. */
export const fetchDemoToken = async (baseUrl: string, userId: string) =>
  (await getJson<{ token: string }>(`${baseUrl}/dev/token/${encodeURIComponent(userId)}`)).token;
