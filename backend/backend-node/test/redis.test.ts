/** RedisBridge + RedisRateLimiter against a hand-written FakeRedis (shared state + pub/sub between "workers"); optional real redis-server test. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { ConnectionManager, type SocketLike } from "../src/core/connections.js";
import { RateLimit, RateLimiter } from "../src/core/ratelimit.js";
import { RedisBridge, type RedisClientLike, type RedisSubscriberLike, RedisRateLimiter, TOKEN_BUCKET_LUA } from "../src/core/redis.js";
import { sleep } from "./helpers.js";

/** Shared "server" state; each FakeRedis is one connection to it. */
class FakeServer {
  hashes = new Map<string, Map<string, string>>();
  strings = new Map<string, { value: string; expiresAt: number | null }>();
  ttl = new Map<string, number>();
  subs = new Set<FakeRedis>();
  evalCalls: Array<{ script: string; args: Array<string | number> }> = [];
}

class FakeRedis implements RedisClientLike, RedisSubscriberLike {
  patterns: string[] = [];
  listeners: Array<(p: string, c: string, m: string) => void> = [];
  failing = false;
  quit_ = false;
  constructor(public server: FakeServer = new FakeServer()) {}
  private check() {
    if (this.failing) throw new Error("ECONNREFUSED");
  }
  async ping() {
    this.check();
    return "PONG";
  }
  async hset(key: string, field: string, value: string | number) {
    this.check();
    if (!this.server.hashes.has(key)) this.server.hashes.set(key, new Map());
    this.server.hashes.get(key)!.set(field, String(value));
  }
  async expire(key: string, seconds: number) {
    this.check();
    this.server.ttl.set(key, seconds);
  }
  async hdel(key: string, field: string) {
    this.check();
    this.server.hashes.get(key)?.delete(field);
  }
  async hgetall(key: string) {
    this.check();
    return Object.fromEntries(this.server.hashes.get(key) ?? []);
  }
  async set(key: string, value: string | number, ...args: Array<string | number>) {
    this.check();
    const nx = args.includes("NX");
    const px = args.includes("PX") ? Number(args[args.indexOf("PX") + 1]) : null;
    const ex = args.includes("EX") ? Number(args[args.indexOf("EX") + 1]) : null;
    const cur = this.server.strings.get(key);
    const live = cur && (cur.expiresAt === null || cur.expiresAt > Date.now());
    if (nx && live) return null;
    const ms = px ?? (ex !== null ? ex * 1000 : null);
    this.server.strings.set(key, { value: String(value), expiresAt: ms === null ? null : Date.now() + ms });
    if (ms !== null) this.server.ttl.set(key, ms);
    return "OK";
  }
  async del(key: string) {
    this.check();
    this.server.strings.delete(key);
    this.server.hashes.delete(key);
  }
  async exists(key: string) {
    this.check();
    const cur = this.server.strings.get(key);
    return cur && (cur.expiresAt === null || cur.expiresAt > Date.now()) ? 1 : 0;
  }
  async publish(channel: string, message: string) {
    this.check();
    for (const sub of this.server.subs) {
      for (const p of sub.patterns) {
        if (channel.startsWith(p.slice(0, -1))) for (const l of sub.listeners) l(p, channel, message);
      }
    }
  }
  async eval(script: string, numKeys: number, ...args: Array<string | number>) {
    this.check();
    this.server.evalCalls.push({ script, args: [numKeys, ...args] });
    return luaTokenBucket(this.server, String(args[0]), Number(args[1]), Number(args[2]), Number(args[3]), Number(args[4]));
  }
  duplicate() {
    return new FakeRedis(this.server);
  }
  async psubscribe(...patterns: string[]) {
    this.patterns.push(...patterns);
    this.server.subs.add(this);
  }
  on(event: string, listener: (...a: any[]) => void) {
    if (event === "pmessage") this.listeners.push(listener);
    return this;
  }
  async quit() {
    this.quit_ = true;
    this.server.subs.delete(this);
  }
}

/** JS equivalent of TOKEN_BUCKET_LUA (the script itself needs a real Redis; the optional test below runs it for real). */
function luaTokenBucket(server: FakeServer, key: string, cap: number, rate: number, now: number, cost: number): string {
  const h = server.hashes.get(key) ?? new Map<string, string>();
  let tokens = h.has("t") ? Number(h.get("t")) : cap;
  let ts = h.has("ts") ? Number(h.get("ts")) : now;
  if (now > ts) tokens = Math.min(cap, tokens + (now - ts) * rate);
  let wait = 0;
  if (tokens >= cost) tokens -= cost;
  else wait = (cost - tokens) / rate;
  h.set("t", String(tokens));
  h.set("ts", String(Math.max(now, ts)));
  server.hashes.set(key, h);
  return String(wait);
}

const wait = async (pred: () => boolean, ms = 2000) => {
  for (let t = 0; t < ms && !pred(); t += 10) await sleep(10);
  expect(pred()).toBe(true);
};

describe("RedisBridge presence", () => {
  it("uses the Python key names, TTLs and staleness rules", async () => {
    const client = new FakeRedis();
    const bridge = new RedisBridge({ client });
    await bridge.start(async () => undefined, "w1");
    await bridge.setOnline("U1", "w1");
    expect(client.server.hashes.get("presence:U1")!.has("w1")).toBe(true);
    expect(client.server.ttl.get("presence:U1")).toBe(120);
    expect(bridge.heartbeatSeconds).toBe(30);
    expect(await bridge.getUserServers("U1")).toEqual(["w1"]);
    expect(await bridge.isOnline("U1")).toBe(true);
    expect([...(await bridge.getOnlineUsers(["U1", "U2"]))]).toEqual(["U1"]);

    await bridge.setAway("U1", true);
    expect(client.server.ttl.get("presence_away:U1")).toBe(12 * 3600 * 1000);
    expect(await bridge.isOnline("U1")).toBe(false);
    expect((await bridge.getOnlineUsers(["U1"])).size).toBe(0);
    expect(await bridge.getUserServers("U1")).toEqual(["w1"]); // still connected, just away
    await bridge.setAway("U1", false);
    expect(await bridge.isOnline("U1")).toBe(true);

    // heartbeat older than 90 s is stale
    client.server.hashes.get("presence:U1")!.set("w2", String(Math.floor(Date.now() / 1000) - 91));
    client.server.hashes.get("presence:U1")!.set("w3", String(Math.floor(Date.now() / 1000) - 80));
    expect((await bridge.getUserServers("U1")).sort()).toEqual(["w1", "w3"]);

    await bridge.setOffline("U1", "w1");
    expect(client.server.hashes.get("presence:U1")!.has("w1")).toBe(false);
    await bridge.stop();
    expect(client.quit_).toBe(true);
  });

  it("came_online claim is SET NX PX and releasable", async () => {
    const client = new FakeRedis();
    const bridge = new RedisBridge({ client });
    expect(await bridge.claimCameOnline("U1", 10)).toBe(true);
    expect(client.server.ttl.get("came_online:U1")).toBe(10000);
    expect(await bridge.claimCameOnline("U1", 10)).toBe(false);
    await bridge.releaseCameOnline("U1");
    expect(await bridge.claimCameOnline("U1", 0.5)).toBe(true);
    expect(client.server.ttl.get("came_online:U1")).toBe(500);
  });

  it("pub/sub: user and room envelopes reach the other worker, in the {origin, data} shape", async () => {
    const server = new FakeServer();
    const c1 = new FakeRedis(server);
    const c2 = new FakeRedis(server);
    const w1 = new RedisBridge({ client: c1 });
    const w2 = new RedisBridge({ client: c2 });
    const got1: any[] = [];
    const got2: any[] = [];
    w1.setRoomDeliver(async (room, env) => void got1.push(["room", room, env]));
    w2.setRoomDeliver(async (room, env) => void got2.push(["room", room, env]));
    await w1.start(async (uid, env) => void got1.push(["user", uid, env]), "w1");
    await w2.start(async (uid, env) => void got2.push(["user", uid, env]), "w2");

    await w1.publish("U7", { type: "x" }, "w1");
    await w1.publishRoom("ops:eu", { event: "y" }, "w1");
    await wait(() => got2.length === 2);
    expect(got2).toEqual([["user", "U7", { origin: "w1", data: { type: "x" } }], ["room", "ops:eu", { origin: "w1", data: { event: "y" } }]]);
    // the publisher's own subscription also sees it (consumers filter by origin)
    await wait(() => got1.length === 2);
    await w1.stop();
    await w2.stop();
  });

  it("two ConnectionManagers deliver across workers and share came_online", async () => {
    const server = new FakeServer();
    const mk = (id: string) => {
      const bridge = new RedisBridge({ client: new FakeRedis(server) });
      return { cm: new ConnectionManager({ bridge, serverId: id }), id };
    };
    const w1 = mk("w1");
    const w2 = mk("w2");
    await w1.cm.start();
    await w2.cm.start();
    const sent: string[] = [];
    const ws: SocketLike = { readyState: 1, send: (d, cb) => { sent.push(d); cb?.(); }, close() {} };
    expect(await w2.cm.register("U9", ws)).toBe(true);
    expect(await w1.cm.send("U9", { type: "hello" })).toBe(true);
    await wait(() => sent.length === 1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: "hello" });
    expect(await w1.cm.isOnline("U9")).toBe(true);
    // second worker's socket for the same user does not fire came_online again
    expect(await w1.cm.register("U9", { ...ws, send: (_d, cb) => cb?.() })).toBe(false);
    await w1.cm.stop();
    await w2.cm.stop();
  });

  it("rooms across workers via the bridge", async () => {
    const server = new FakeServer();
    const b1 = new RedisBridge({ client: new FakeRedis(server) });
    const b2 = new RedisBridge({ client: new FakeRedis(server) });
    const cm1 = new ConnectionManager({ bridge: b1, serverId: "w1" });
    const cm2 = new ConnectionManager({ bridge: b2, serverId: "w2" });
    await cm1.start();
    await cm2.start();
    const got: string[] = [];
    await cm2.register("U5", { readyState: 1, send: (d, cb) => { got.push(d); cb?.(); }, close() {} });
    expect(cm2.joinRoom("U5", "ops")).toBe(true);
    expect(await cm1.broadcastRoom("ops", { type: "room_msg" })).toBeGreaterThanOrEqual(0);
    await wait(() => got.length === 1);
    expect(JSON.parse(got[0]!)).toEqual({ type: "room_msg" });
    await cm1.stop();
    await cm2.stop();
  });
});

describe("RedisBridge failure modes", () => {
  it("unreachable Redis at start: warns and runs local-only", async () => {
    const client = new FakeRedis();
    client.failing = true;
    const bridge = new RedisBridge({ client });
    await bridge.start(async () => undefined, "w1");
    expect(bridge.client).toBeNull();
    await bridge.setOnline("U1", "w1");
    await bridge.setOffline("U1", "w1");
    await bridge.setAway("U1", true);
    await bridge.publish("U1", {}, "w1");
    await bridge.publishRoom("r", {}, "w1");
    expect(await bridge.getUserServers("U1")).toEqual([]);
    expect(await bridge.isOnline("U1")).toBe(false);
    expect((await bridge.getOnlineUsers(["U1"])).size).toBe(0);
    expect(await bridge.claimCameOnline("U1", 5)).toBe(true); // every caller wins without Redis
    await bridge.releaseCameOnline("U1");
    await bridge.stop();
  });

  it("errors after start never throw", async () => {
    const client = new FakeRedis();
    const bridge = new RedisBridge({ client });
    await bridge.start(async () => undefined, "w1");
    client.failing = true;
    await bridge.setOnline("U1", "w1");
    await bridge.setAway("U1", false);
    expect(await bridge.getUserServers("U1")).toEqual([]);
    expect(await bridge.isOnline("U1")).toBe(false);
    expect((await bridge.getOnlineUsers(["U1"])).size).toBe(0);
    expect(await bridge.claimCameOnline("U1", 5)).toBe(true);
    await bridge.stop();
  });

  it("needs a url or a client; a missing ioredis degrades to local-only", async () => {
    expect(() => new RedisBridge()).toThrow();
    const bridge = new RedisBridge({ url: "redis://127.0.0.1:1" });
    await bridge.start(async () => undefined, "w1"); // ioredis absent or connection refused: warning only
    expect(bridge.client).toBeNull();
    await bridge.stop();
  });
});

describe("RedisRateLimiter", () => {
  const limit = new RateLimit(2, 10);

  it("calls the verbatim Lua script and parses the wait", async () => {
    const client = new FakeRedis();
    const limiter = new RedisRateLimiter(client, "rl:");
    expect(await limiter.hit("k", limit)).toBe(0);
    expect(await limiter.hit("k", limit)).toBe(0);
    const w = await limiter.hit("k", limit);
    expect(w).toBeGreaterThan(4);
    expect(w).toBeLessThanOrEqual(5);
    const call = client.server.evalCalls[0]!;
    expect(call.script).toBe(TOKEN_BUCKET_LUA);
    expect(call.args[0]).toBe(1);
    expect(call.args[1]).toBe("rl:k");
    expect(call.args[2]).toBe(2);
    expect(Number(call.args[3])).toBeCloseTo(0.2);
    expect(call.args[6]).toBe(21000); // ttl ms = 2 * window + 1 s
    expect(await limiter.hit("other", limit)).toBe(0);
    expect(await limiter.hit("k", null)).toBe(0);
  });

  it("buckets are shared between workers", async () => {
    const server = new FakeServer();
    const a = new RedisRateLimiter(new FakeRedis(server));
    const b = new RedisRateLimiter(new FakeRedis(server));
    expect(await a.hit("u", limit)).toBe(0);
    expect(await b.hit("u", limit)).toBe(0);
    expect(await a.hit("u", limit)).toBeGreaterThan(0);
  });

  it("falls back to the in-memory limiter on errors and before the bridge has a client", async () => {
    const client = new FakeRedis();
    client.failing = true;
    const fallback = new RateLimiter();
    const limiter = new RedisRateLimiter(client, "rl:", fallback);
    expect(await limiter.hit("x", limit)).toBe(0);
    expect(await limiter.hit("x", limit)).toBe(0);
    expect(await limiter.hit("x", limit)).toBeGreaterThan(0);

    const bridge = new RedisBridge({ client: new FakeRedis() });
    const viaBridge = new RedisRateLimiter(bridge); // bridge.client is set only after start()
    (bridge as any).client = null;
    expect(await viaBridge.hit("y", limit)).toBe(0);
    expect(await viaBridge.hit("y", limit)).toBe(0);
    expect(await viaBridge.hit("y", limit)).toBeGreaterThan(0);
    (bridge as any).client = new FakeRedis();
    expect(await viaBridge.hit("fresh", limit)).toBe(0);
  });

  it("an unparsable reply falls back", async () => {
    const client = new FakeRedis();
    client.eval = async () => "not-a-number";
    expect(await new RedisRateLimiter(client).hit("z", limit)).toBe(0);
  });
});

// ------------------------------------------------- optional real redis-server

function haveRedisServer(): boolean {
  try {
    execFileSync("redis-server", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function haveIoredis(): Promise<boolean> {
  try {
    const name = "ioredis";
    await import(/* @vite-ignore */ name);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!haveRedisServer())("real redis-server (optional)", () => {
  it("bridge + limiter against a real Redis", async () => {
    if (!(await haveIoredis())) return; // needs ioredis installed too
    const port = 36379;
    const proc: ChildProcess = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 100; i++) {
        const ok = await new Promise<boolean>((r) => {
          const s = createConnection(port, "127.0.0.1");
          s.once("connect", () => (s.destroy(), r(true)));
          s.once("error", () => r(false));
        });
        if (ok) break;
        await sleep(50);
      }
      const bridge = new RedisBridge({ url: `redis://127.0.0.1:${port}` });
      const got: any[] = [];
      await bridge.start(async (uid, env) => void got.push([uid, env]), "w1");
      expect(bridge.client).not.toBeNull();
      await bridge.setOnline("U1", "w1");
      expect(await bridge.isOnline("U1")).toBe(true);
      await bridge.publish("U1", { a: 1 }, "w2");
      await wait(() => got.length === 1);
      expect(got[0]).toEqual(["U1", { origin: "w2", data: { a: 1 } }]);
      const limiter = new RedisRateLimiter(bridge);
      expect(await limiter.hit("u", new RateLimit(1, 60))).toBe(0);
      expect(await limiter.hit("u", new RateLimit(1, 60))).toBeGreaterThan(50);
      await bridge.stop();
    } finally {
      proc.kill();
    }
  });
});
