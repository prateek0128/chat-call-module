/**
 * ICE servers: a static list, or fetched TURN credentials (PROTOCOL §4 REST:
 * `POST /call/turn-credentials` -> {username, password, ttl, uris}). No credentials
 * are hard-coded in the kit.
 */
import { authFetch, CommsConfig, Logger } from "../core/config";
import type { IceServer, IceServersOption } from "./types";

/** Public STUN, used only as a fallback when nothing else is available. */
export const PUBLIC_STUN: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export interface TurnCredentials {
  username: string;
  password: string;
  ttl?: number;
  uris: string[];
}

export interface TurnIceServersOptions {
  /** Endpoint path (default `/call/turn-credentials`). */
  path?: string;
  /** Extra servers put before the TURN entry (default: PUBLIC_STUN). */
  stun?: IceServer[];
  /** Used when the fetch fails (default: `stun`). */
  fallback?: IceServer[];
  logger?: Logger;
}

export const turnCredentialsToIceServers = (creds: TurnCredentials): IceServer[] =>
  creds?.uris?.length ? [{ urls: creds.uris, username: creds.username, credential: creds.password }] : [];

/**
 * Async ICE-server provider that fetches TURN REST credentials and caches them
 * until shortly before they expire. Pass it as `<CallProvider iceServers={...}>`.
 */
export const turnCredentialsIceServers = (
  config: Pick<CommsConfig, "baseUrl" | "getToken">,
  options: TurnIceServersOptions = {},
): (() => Promise<IceServer[]>) => {
  const { path = "/call/turn-credentials", stun = PUBLIC_STUN, logger } = options;
  const fallback = options.fallback ?? stun;
  let cached: { servers: IceServer[]; expiresAt: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.servers;
    try {
      const creds = await authFetch<TurnCredentials>(config, path, { method: "POST" });
      const servers = [...stun, ...turnCredentialsToIceServers(creds)];
      const ttlMs = Math.max(0, (Number(creds?.ttl) || 0) * 1000 - 60_000);
      cached = ttlMs > 0 ? { servers, expiresAt: Date.now() + ttlMs } : null;
      return servers;
    } catch (e) {
      logger?.warn("TURN credentials fetch failed; using fallback ICE servers", e);
      return fallback;
    }
  };
};

export const resolveIceServers = async (option: IceServersOption | undefined, logger?: Logger): Promise<IceServer[]> => {
  if (!option) return PUBLIC_STUN;
  if (Array.isArray(option)) return option;
  try {
    const servers = await option();
    return Array.isArray(servers) && servers.length ? servers : PUBLIC_STUN;
  } catch (e) {
    logger?.warn("iceServers provider failed; using public STUN", e);
    return PUBLIC_STUN;
  }
};
