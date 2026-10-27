/**
 * Optional Redis presence + cross-worker delivery (port of commskit.core.redis_bridge) and the shared
 * token-bucket limiter (port of commskit.core.ratelimit.RedisRateLimiter). Needs `ioredis` (optional peer
 * dependency, imported lazily) unless a client is injected.
 *
 * Key names match the Python kit and matrimonial-backend-v2, so Python and Node workers interoperate:
 * `presence:{uid}` (hash serverId -> heartbeat epoch seconds), `presence_away:{uid}`, pub/sub `user_channel:{uid}`
 * carrying `{"origin","data"}`, `room_channel:{room}` (same envelope) and `came_online:{uid}` (SET NX PX).
 *
 * Every Redis failure is logged and degrades to "not connected" (local-only); it never throws.
 */
import type { Deliver, PresenceBridge } from "./connections.js";
import { logger } from "./logger.js";
import { type Limiter, RateLimit, RateLimiter } from "./ratelimit.js";

export const USER_CHANNEL_PREFIX = "user_channel:";
export const USER_CHANNEL_PATTERN = "user_channel:*";
export const PRESENCE_KEY_PREFIX = "presence:";
export const AWAY_KEY_PREFIX = "presence_away:";
export const ROOM_CHANNEL_PREFIX = "room_channel:";
export const ROOM_CHANNEL_PATTERN = "room_channel:*";
export const CAME_ONLINE_KEY_PREFIX = "came_online:";

/** The slice of an `ioredis` client the bridge uses. */
export interface RedisClientLike {
  ping(): Promise<unknown>;
  hset(key: string, field: string, value: string | number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string | number, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
  exists(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** A second connection for the subscriber. */
  duplicate(): RedisSubscriberLike;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface RedisSubscriberLike {
  psubscribe(...patterns: string[]): Promise<unknown>;
  on(event: "pmessage", listener: (pattern: string, channel: string, message: string) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export type RoomDeliver = (room: string, envelope: any) => Promise<void>;

export interface RedisBridgeOptions {
  url?: string;
  /** An already-created ioredis-compatible client (tests, shared connections). */
  client?: RedisClientLike;
  heartbeatSeconds?: number;
  staleSeconds?: number;
  presenceTtlSeconds?: number;
  awayTtlSeconds?: number;
}

async function loadIoRedis(): Promise<any> {
  const name = "ioredis"; // variable specifier: no compile-time dependency
  try {
    const mod: any = await import(/* @vite-ignore */ name);
    return mod.default ?? mod.Redis ?? mod;
  } catch {
    throw new Error('RedisBridge needs ioredis: npm install ioredis');
  }
}

export class RedisBridge implements PresenceBridge {
  client: RedisClientLike | null;
  heartbeatSeconds: number;
  staleSeconds: number;
  presenceTtlSeconds: number;
  awayTtlSeconds: number;
  private url?: string;
  private sub: RedisSubscriberLike | null = null;
  private deliver: Deliver | null = null;
  private roomDeliver: RoomDeliver | null = null;

  constructor(opts: RedisBridgeOptions = {}) {
    if (!opts.url && !opts.client) throw new Error("RedisBridge needs a url or a client");
    this.url = opts.url;
    this.client = opts.client ?? null;
    this.heartbeatSeconds = opts.heartbeatSeconds ?? 30;
    this.staleSeconds = opts.staleSeconds ?? 90;
    this.presenceTtlSeconds = opts.presenceTtlSeconds ?? 120;
    this.awayTtlSeconds = opts.awayTtlSeconds ?? 12 * 3600;
  }

  setRoomDeliver(fn: RoomDeliver): void {
    this.roomDeliver = fn;
  }

  async start(deliver: Deliver, _serverId: string): Promise<void> {
    this.deliver = deliver;
    let ready = false; // fail fast on the first connect; reconnect with backoff once it worked
    try {
      if (!this.client) {
        const Redis = await loadIoRedis();
        const c = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000, retryStrategy: (n: number) => (ready ? Math.min(n * 200, 2000) : null) });
        c.on("error", () => undefined);
        this.client = c as RedisClientLike;
        await c.connect();
      }
      await this.client.ping();
      ready = true;
      const sub = this.client.duplicate();
      sub.on("error", () => undefined);
      if (sub.connect) {
        try {
          await sub.connect();
        } catch (err) {
          if (!/already/i.test(String((err as Error)?.message))) throw err;
        }
      }
      sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
        void this.consume(channel, message);
      });
      await sub.psubscribe(USER_CHANNEL_PATTERN, ROOM_CHANNEL_PATTERN);
      this.sub = sub;
    } catch (err) {
      logger.warn(`Redis unavailable (${(err as Error)?.message ?? err}); running single-worker`);
      const c = this.client;
      this.client = null;
      this.sub = null;
      try {
        c?.disconnect?.();
      } catch {
        /* ignore */
      }
    }
  }

  async stop(): Promise<void> {
    for (const obj of [this.sub, this.client]) {
      if (!obj) continue;
      try {
        if (obj.quit) await obj.quit();
        else obj.disconnect?.();
      } catch {
        try {
          obj.disconnect?.();
        } catch {
          /* ignore */
        }
      }
    }
    this.sub = null;
    this.client = null;
  }

  private async consume(channel: string, raw: string): Promise<void> {
    if (typeof channel !== "string" || !raw) return;
    if (channel.startsWith(ROOM_CHANNEL_PREFIX)) {
      const room = channel.slice(ROOM_CHANNEL_PREFIX.length);
      if (!this.roomDeliver) return;
      try {
        await this.roomDeliver(room, JSON.parse(raw));
      } catch (err) {
        logger.warn(`Cross-worker room delivery to ${room} failed: ${(err as Error)?.message ?? err}`);
      }
      return;
    }
    if (!this.deliver) return;
    const userId = channel.slice(channel.lastIndexOf(":") + 1);
    try {
      await this.deliver(userId, JSON.parse(raw));
    } catch (err) {
      logger.warn(`Cross-worker delivery to ${userId} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  // ------------------------------------------------------------ presence

  async setOnline(userId: string, serverId: string): Promise<void> {
    const c = this.client;
    if (!c) return;
    const key = PRESENCE_KEY_PREFIX + userId;
    try {
      await c.hset(key, serverId, Math.floor(Date.now() / 1000));
      await c.expire(key, this.presenceTtlSeconds);
    } catch (err) {
      logger.warn(`setOnline(${userId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  async setOffline(userId: string, serverId: string): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      await c.hdel(PRESENCE_KEY_PREFIX + userId, serverId);
    } catch (err) {
      logger.warn(`setOffline(${userId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  async setAway(userId: string, away: boolean): Promise<void> {
    const c = this.client;
    if (!c) return;
    const key = AWAY_KEY_PREFIX + userId;
    try {
      if (away) await c.set(key, 1, "EX", this.awayTtlSeconds);
      else await c.del(key);
    } catch (err) {
      logger.warn(`setAway(${userId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  async getUserServers(userId: string): Promise<string[]> {
    const c = this.client;
    if (!c) return [];
    let entries: Record<string, string>;
    try {
      entries = await c.hgetall(PRESENCE_KEY_PREFIX + userId);
    } catch (err) {
      logger.warn(`getUserServers(${userId}) failed: ${(err as Error)?.message ?? err}`);
      return [];
    }
    const cutoff = Date.now() / 1000 - this.staleSeconds;
    return Object.entries(entries ?? {}).filter(([, beat]) => Number(beat) >= cutoff).map(([server]) => server);
  }

  async isOnline(userId: string): Promise<boolean> {
    if (!(await this.getUserServers(userId)).length) return false;
    try {
      return !(await this.client!.exists(AWAY_KEY_PREFIX + userId));
    } catch {
      return true;
    }
  }

  async getOnlineUsers(userIds: string[]): Promise<Set<string>> {
    const c = this.client;
    if (!c || !userIds.length) return new Set();
    let results: Array<[Record<string, string>, number]>;
    try {
      results = await Promise.all(
        userIds.map(async (uid) => [await c.hgetall(PRESENCE_KEY_PREFIX + uid), await c.exists(AWAY_KEY_PREFIX + uid)] as [Record<string, string>, number]),
      );
    } catch (err) {
      logger.warn(`getOnlineUsers failed: ${(err as Error)?.message ?? err}`);
      return new Set();
    }
    const cutoff = Date.now() / 1000 - this.staleSeconds;
    const online = new Set<string>();
    userIds.forEach((uid, i) => {
      const [servers, away] = results[i]!;
      if (!away && Object.values(servers ?? {}).some((b) => Number(b) >= cutoff)) online.add(uid);
    });
    return online;
  }

  async publish(userId: string, payload: unknown, origin: string): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      await c.publish(USER_CHANNEL_PREFIX + userId, JSON.stringify({ origin, data: payload }));
    } catch (err) {
      logger.warn(`publish(${userId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  async publishRoom(room: string, payload: unknown, origin: string): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      await c.publish(ROOM_CHANNEL_PREFIX + room, JSON.stringify({ origin, data: payload }));
    } catch (err) {
      logger.warn(`publishRoom(${room}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  // ------------------------------------------------------- user.came_online

  /** True for exactly one caller until the key expires or is released (`SET NX PX`). Without Redis every caller wins. */
  async claimCameOnline(userId: string, ttlSeconds: number): Promise<boolean> {
    const c = this.client;
    if (!c) return true;
    try {
      return Boolean(await c.set(CAME_ONLINE_KEY_PREFIX + userId, 1, "PX", Math.max(1, Math.floor(ttlSeconds * 1000)), "NX"));
    } catch (err) {
      logger.warn(`claimCameOnline(${userId}) failed: ${(err as Error)?.message ?? err}`);
      return true;
    }
  }

  async releaseCameOnline(userId: string): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      await c.del(CAME_ONLINE_KEY_PREFIX + userId);
    } catch (err) {
      logger.warn(`releaseCameOnline(${userId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }
}

// ------------------------------------------------------------ rate limiter

// KEYS[1] bucket; ARGV: capacity, rate (tokens/s), now (s), cost, ttl (ms). Returns the wait as a string.
// Verbatim from commskit.core.ratelimit.
export const TOKEN_BUCKET_LUA = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local v = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(v[1])
local ts = tonumber(v[2])
if tokens == nil or ts == nil then tokens = cap; ts = now end
if now > ts then tokens = math.min(cap, tokens + (now - ts) * rate) end
local wait = 0
if tokens >= cost then tokens = tokens - cost else wait = (cost - tokens) / rate end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'ts', tostring(math.max(now, ts)))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return tostring(wait)
`;

/**
 * Token buckets in Redis, shared by all workers. `source` is a `RedisBridge` (its `client` is read on every call, so the
 * limiter can be built before `hub.connections.start()`) or an ioredis-compatible client. Any Redis error, or no
 * client yet, falls back to `fallback` (in-memory by default).
 */
export class RedisRateLimiter implements Limiter {
  fallback: Limiter;
  constructor(
    private source: { client?: RedisClientLike | null } | RedisClientLike,
    public prefix = "ratelimit:",
    fallback?: Limiter,
  ) {
    this.fallback = fallback ?? new RateLimiter();
  }

  private client(): RedisClientLike | null {
    const s: any = this.source;
    if (typeof s.eval === "function") return s;
    return s.client ?? null;
  }

  async hit(key: string, limit: RateLimit | null | undefined, cost = 1): Promise<number> {
    if (!limit) return 0;
    const client = this.client();
    if (!client) return this.fallback.hit(key, limit, cost);
    const ttlMs = Math.floor(limit.seconds * 1000 * 2) + 1000;
    try {
      const raw = await client.eval(TOKEN_BUCKET_LUA, 1, this.prefix + key, limit.count, String(limit.rate), String(Date.now() / 1000), String(cost), ttlMs);
      const wait = Number(Buffer.isBuffer(raw) ? raw.toString() : raw);
      if (Number.isNaN(wait)) throw new Error(`unexpected reply ${String(raw)}`);
      return Math.max(0, wait);
    } catch (err) {
      logger.warn(`Redis rate limit failed (${(err as Error)?.message ?? err}); using the in-memory limiter`);
      return this.fallback.hit(key, limit, cost);
    }
  }
}
