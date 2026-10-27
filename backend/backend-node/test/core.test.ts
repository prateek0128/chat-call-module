import { afterEach, describe, expect, it } from "vitest";
import { ConnectionManager, RateLimit, RateLimiter } from "../src/index.js";
import { closeAll, makeEnv, sleep } from "./helpers.js";

afterEach(closeAll);

describe("transport", () => {
  it("invalid token closes 1008", async () => {
    const env = await makeEnv({ chat: false });
    const ws = await env.rawWs("/ws/not-a-jwt");
    expect(await ws.waitClosed()).toBe(1008);
  });

  it("ping, bad json and unknown types", async () => {
    const env = await makeEnv({ chat: false });
    const ws = await env.ws("A");
    ws.send("ping");
    const pong = await ws.recv();
    expect(pong.type).toBe("PONG");
    expect(pong.timestamp).toBeTruthy();
    expect(pong.timestamp).not.toMatch(/Z$|\+/);

    ws.sendRaw("{not json");
    expect(await ws.recv()).toEqual({ type: "error", error: "Invalid JSON" });
    ws.sendRaw("[1, 2]");
    expect(await ws.recv()).toEqual({ type: "error", error: "Message must be a JSON object" });
    ws.sendRaw("null");
    expect(await ws.recv()).toEqual({ type: "error", error: "Message must be a JSON object" });

    ws.send("no_such_event"); // ignored, no reply
    ws.send("ping");
    expect((await ws.recv()).type).toBe("PONG");
  });

  it("host event and handler crash", async () => {
    const env = await makeEnv({ chat: false });
    env.hub.on("report_and_block", async (userId, message) => {
      await env.hub.send(userId, { type: "user_blocked", candidate_user_id: message.candidate_user_id });
    });
    env.hub.on("boom", async () => {
      throw new Error("kaput");
    });
    const ws = await env.ws("A");
    ws.send("report_and_block", { candidate_user_id: "B" });
    expect((await ws.expect("user_blocked")).candidate_user_id).toBe("B");
    ws.send("boom");
    expect((await ws.expect("error")).error).toBe("Message processing failed: kaput");
  });

  it("REST requires bearer", async () => {
    const env = await makeEnv();
    expect((await env.post("/chats/start?candidate_id=B")).status).toBe(401);
    const bad = await env.rest("GET", "/chats/A/unread-count", null, undefined, { authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
    expect(bad.json).toEqual({ detail: "Invalid token" });
    expect((await env.post("/call/turn-credentials", "A")).status).toBe(404); // call is phase 2
  });
});

describe("core extras", () => {
  it("token bucket", async () => {
    let now = 0;
    const limiter = new RateLimiter(100, () => now);
    const limit = new RateLimit(2, 10); // 1 token / 5 s
    expect(await limiter.hit("k", limit)).toBe(0);
    expect(await limiter.hit("k", limit)).toBe(0);
    expect(await limiter.hit("k", limit)).toBeCloseTo(5.0);
    expect(await limiter.hit("other", limit)).toBe(0);
    now = 5;
    expect(await limiter.hit("k", limit)).toBe(0);
    expect(await limiter.hit("k", limit)).toBeGreaterThan(0);
    now = 100; // refills up to capacity only
    expect([await limiter.hit("k", limit), await limiter.hit("k", limit)]).toEqual([0, 0]);
    expect(await limiter.hit("k", limit)).toBeGreaterThan(0);
    expect(await limiter.hit("k", null)).toBe(0);
    expect(() => new RateLimit(0, 1)).toThrow();
  });

  it("rooms are local, left on disconnect, need a socket", async () => {
    const env = await makeEnv({ chat: false });
    expect(env.hub.joinRoom("nobody", "r")).toBe(false);
    const a = await env.ws("ADM1");
    expect(env.hub.joinRoom("ADM1", "admins")).toBe(true);
    const frame = { event: "x" }; // frames are sent as given (no "type" needed)
    expect(await env.hub.broadcastRoom("admins", frame)).toBe(1);
    expect(await a.recv()).toEqual(frame);
    env.hub.leaveRoom("ADM1", "admins");
    expect(await env.hub.broadcastRoom("admins", frame)).toBe(0);
    env.hub.joinRoom("ADM1", "admins");
    await a.close();
    await sleep(100);
    expect(env.hub.connections.roomMembers("admins").size).toBe(0);
  });

  it("admin role skips presence, user hooks and delivery flush; allRoles hooks run", async () => {
    const env = await makeEnv({ hubOptions: { roleResolver: (uid) => (uid === "ADM" ? "admin" : "user") } });
    const seen: Record<string, string[]> = { user_hook: [], any_hook: [], connected: [], came_online: [], disconnected: [] };
    env.hub.onConnect(async (uid) => void seen.user_hook!.push(uid));
    env.hub.onConnect(async (uid) => {
      seen.any_hook!.push(uid);
      env.hub.joinRoom(uid, `role:${await env.hub.roleOf(uid)}`);
    }, true);
    env.hub.events.on("user.connected", (u) => seen.connected!.push(u));
    env.hub.events.on("user.came_online", (u) => seen.came_online!.push(u));
    env.hub.events.on("user.disconnected", (u) => seen.disconnected!.push(u));

    const a = await env.ws("A");
    a.send("send_message", { candidate_user_id: "ADM", content: "to the admin while offline" });
    await a.expect("message_sent");
    const adm = await env.ws("ADM");
    await adm.sync();
    adm.send("user_status", { status: "online" });
    await adm.sync();
    expect(await env.hub.broadcastRoom("role:admin", { event: "hello" })).toBe(1);
    expect(await adm.recv()).toEqual({ event: "hello" });
    await adm.close();
    await a.expectNone("delivery_status"); // no delivery flush for an admin socket
    await a.expectNone("user_status"); // no presence for an admin socket
    await a.close();
    await sleep(100);
    expect(seen.user_hook).not.toContain("ADM");
    expect(seen.any_hook).toContain("ADM");
    expect(seen.connected).not.toContain("ADM");
    expect(seen.came_online).toEqual(["A"]);
    expect(seen.disconnected).toEqual(["A"]);
  });

  it("user.came_online dedupes sockets and honours the cooldown", async () => {
    const env = await makeEnv();
    const events: string[] = [];
    env.hub.events.on("user.came_online", (u) => events.push(u));
    const a1 = await env.ws("A");
    const a2 = await env.ws("A");
    await a1.sync();
    await a2.sync();
    expect(events).toEqual(["A"]);
    await a1.close();
    await a2.close();
    await sleep(150);
    const a3 = await env.ws("A");
    await a3.sync();
    expect(events).toEqual(["A", "A"]);

    const cooled = await makeEnv({ chat: false, hubOptions: { cameOnlineCooldown: 60 } });
    const cooledEvents: string[] = [];
    cooled.hub.events.on("user.came_online", (u) => cooledEvents.push(u));
    for (let i = 0; i < 2; i++) {
      const b = await cooled.ws("B");
      await b.sync();
      await b.close();
      await sleep(150);
    }
    expect(cooledEvents).toEqual(["B"]);
  });

  it("onHandlerError hook receives bad JSON, non-objects and crashes; its failures are swallowed", async () => {
    const calls: Array<[string, any, string]> = [];
    const env = await makeEnv({
      hubOptions: {
        onHandlerError: async (uid, frame, err) => {
          calls.push([uid, frame, (err as Error).constructor.name]);
          throw new Error("hook failures are swallowed");
        },
      },
    });
    env.hub.on("boom", async () => {
      throw new RangeError("kaput");
    });
    const ws = await env.ws("A");
    ws.sendRaw("{oops");
    expect((await ws.expect("error")).error).toBe("Invalid JSON");
    ws.sendRaw("[]");
    await ws.expect("error");
    ws.send("boom");
    expect((await ws.expect("error")).error).toMatch(/^Message processing failed/);
    // a DB failure inside a chat handler is reported too
    const proto = Object.getPrototypeOf(env.chat.handlers.service(env.db));
    const original = proto.getReplyPreviews;
    proto.getReplyPreviews = async () => {
      throw new Error("db down");
    };
    try {
      ws.send("get_messages", { candidate_user_id: "B" });
      expect((await ws.expect("error")).error).toMatch(/^Failed to retrieve messages/);
    } finally {
      proto.getReplyPreviews = original;
    }
    expect(calls[0]).toEqual(["A", "{oops", "SyntaxError"]);
    expect(calls[1]).toEqual(["A", [], "TypeError"]);
    expect(calls[2]![1].type).toBe("boom");
    expect(calls[2]![2]).toBe("RangeError");
    expect(calls[3]![1].type).toBe("get_messages");
  });

  it("ConnectionManager: multi-socket delivery and online state", async () => {
    const cm = new ConnectionManager();
    const sent: string[] = [];
    const sock = () => ({ readyState: 1, send: (d: string, cb?: (e?: Error) => void) => (sent.push(d), cb?.()), close() {} });
    const s1 = sock();
    const s2 = sock();
    await cm.register("U", s1);
    await cm.register("U", s2);
    expect(await cm.send("U", { a: 1 })).toBe(true);
    expect(sent.length).toBe(2);
    expect(await cm.send("nobody", { a: 1 })).toBe(false);
    cm.disconnect("U", s1);
    expect(cm.isUserOnline("U")).toBe(true);
    cm.disconnect("U", s2);
    expect(cm.isUserOnline("U")).toBe(false);
  });
});
