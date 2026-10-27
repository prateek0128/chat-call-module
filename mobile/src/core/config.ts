/** Kit configuration supplied by the host app, plus URL / auth helpers. */

export type MaybePromise<T> = T | Promise<T>;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface CommsConfig {
  /** REST base URL, e.g. `https://api.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** WebSocket base, e.g. `wss://api.example.com`. Derived from `baseUrl` when omitted. */
  wsUrl?: string;
  /** Current auth token (JWT). Called on every (re)connect and REST call. null = logged out. */
  getToken: () => MaybePromise<string | null | undefined>;
  /** Current user's id. Called on every (re)connect. */
  getUserId: () => MaybePromise<string | null | undefined>;
  logger?: Logger;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Prefixed console logger, handy while integrating: `logger: consoleLogger("[comms]")`. */
export const consoleLogger = (prefix = "[comms]"): Logger => ({
  debug: (...a) => console.debug(prefix, ...a),
  info: (...a) => console.info(prefix, ...a),
  warn: (...a) => console.warn(prefix, ...a),
  error: (...a) => console.error(prefix, ...a),
});

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** `https://x` -> `wss://x`, `http://x` -> `ws://x`; ws(s) URLs are kept. */
export const deriveWsUrl = (baseUrl: string): string => {
  const base = trimSlash(baseUrl.trim());
  if (/^wss?:\/\//i.test(base)) return base;
  if (/^https:\/\//i.test(base)) return "wss://" + base.slice("https://".length);
  if (/^http:\/\//i.test(base)) return "ws://" + base.slice("http://".length);
  throw new Error(`[comms] baseUrl must start with http(s):// or ws(s)://, got "${baseUrl}"`);
};

export const resolveWsUrl = (config: CommsConfig): string =>
  trimSlash(config.wsUrl ? config.wsUrl : deriveWsUrl(config.baseUrl));

/** Socket URL: `${wsUrl}/ws/${token}` (token in the path, PROTOCOL §1). */
export const socketUrl = (config: CommsConfig, token: string): string =>
  `${resolveWsUrl(config)}/ws/${encodeURIComponent(token)}`;

export const restUrl = (config: Pick<CommsConfig, "baseUrl">, path: string): string =>
  `${trimSlash(config.baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;

export class CommsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message || `HTTP ${status}`);
    this.name = "CommsHttpError";
  }
}

/**
 * Authenticated JSON request with `fetch` + `getToken()` (no axios dependency).
 * Throws `CommsHttpError` on non-2xx.
 */
export const authFetch = async <T = unknown>(
  config: Pick<CommsConfig, "baseUrl" | "getToken">,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const token = await config.getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(restUrl(config, path), { method: init.method || "GET", headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "detail" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).detail)
        : undefined;
    throw new CommsHttpError(res.status, parsed, detail);
  }
  return parsed as T;
};
