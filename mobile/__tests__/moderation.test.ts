/** ModerationStore: WS events, res_users / res_messages flags, REST commands (optimistic + rollback). */
import { CommsClient } from "../src/core/CommsClient";
import { ModerationStore, REPORT_CATEGORIES } from "../src/moderation";
import { ChatStore } from "../src/chat/ChatStore";

const config = { baseUrl: "https://api.example.com", getToken: () => "jwt" };

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown } = () => ({ status: 200, body: { status: true } });
beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: { status: true } });
  (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = respond(call);
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
  });
});

const makeClient = () => new CommsClient({ config: { ...config, getUserId: () => "me" }, createWebSocket: () => ({}) as any });

describe("ModerationStore", () => {
  it("tracks WS block events in both directions", () => {
    const client = makeClient();
    const store = new ModerationStore({ config, client });
    store.attach();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().version));
    client.dispatchLocal({ type: "user_blocked", candidate_user_id: 5, message: "Blocked" });
    client.dispatchLocal({ type: "blocked_by_user", candidate_user_id: "7", message: "x" });
    expect(store.isBlocked("5")).toBe(true);
    expect(store.blockedByOther("7")).toBe(true);
    expect(store.isBlockedPair("7")).toBe(true);
    expect(store.getSnapshot().blockedIds).toEqual(["5"]);
    client.dispatchLocal({ type: "user_unblocked", candidate_user_id: "5" });
    client.dispatchLocal({ type: "unblocked_by_user", candidate_user_id: "7" });
    expect(store.isBlockedPair("5") || store.isBlockedPair("7")).toBe(false);
    expect(seen).toHaveLength(4);
  });

  it("reads is_blocked / blocked_by_other from res_users and res_messages.info", () => {
    const client = makeClient();
    const store = new ModerationStore({ config, client });
    store.attach();
    client.dispatchLocal({ type: "res_users", users: [{ user_id: "1", is_blocked: true }, { user_id: "2", blocked_by_other: true }, { user_id: "3" }] });
    client.dispatchLocal({ type: "res_messages", messages: [], info: { user_id: "1", is_blocked: false } });
    expect(store.isBlocked("1")).toBe(false);
    expect(store.blockedByOther("2")).toBe(true);
    expect(store.isBlockedPair("3")).toBe(false);
  });

  it("block / unblock call REST optimistically and tell ChatStore via a local event", async () => {
    const client = makeClient();
    const chat = new ChatStore({ send: () => true, isConnected: () => true, getUserId: () => "me" } as any);
    client.on("user_blocked", (m) => chat.handle(m));
    client.on("user_unblocked", (m) => chat.handle(m));
    chat.handle({ type: "res_users", users: [{ user_id: "9", username: "Nia" }] } as any);
    const store = new ModerationStore({ config, client });
    store.attach();

    const pending = store.block("9");
    expect(store.isBlocked("9")).toBe(true); // optimistic
    expect(chat.getConversation("9")?.is_blocked).toBe(true);
    await pending;
    expect(calls[0]).toEqual({ url: "https://api.example.com/moderation/blocks", method: "POST", body: { user_id: "9" } });

    await store.unblock("9");
    expect(calls[1]).toMatchObject({ url: "https://api.example.com/moderation/blocks/9", method: "DELETE" });
    expect(store.isBlocked("9")).toBe(false);
    expect(chat.getConversation("9")?.is_blocked).toBe(false);
  });

  it("rolls back and reports errors when REST fails", async () => {
    const store = new ModerationStore({ config });
    const errors: string[] = [];
    store.onError((e) => errors.push(e.message));
    respond = () => ({ status: 500, body: { detail: "boom" } });
    await expect(store.block("4")).rejects.toThrow("boom");
    expect(store.isBlocked("4")).toBe(false);
    expect(errors).toEqual(["boom"]);
  });

  it("report posts §7 body, blocks by default, and can skip the block", async () => {
    const store = new ModerationStore({ config });
    respond = () => ({ status: 200, body: { report_id: 77 } });
    const res = await store.report({ peerId: "3", reason: "  rude ", category: "harassment", messageId: 12 });
    expect(res).toEqual({ reportId: "77" });
    expect(calls[0]).toEqual({
      url: "https://api.example.com/moderation/reports",
      method: "POST",
      body: { user_id: "3", reason: "rude", category: "harassment", message_id: 12, block: true },
    });
    expect(store.isBlocked("3")).toBe(true);
    await store.report({ peerId: "8", category: "spam", block: false });
    expect(calls[1].body).toEqual({ user_id: "8", reason: "", category: "spam", block: false });
    expect(store.isBlocked("8")).toBe(false);
  });

  it("listBlocked replaces the list with names from the server", async () => {
    const store = new ModerationStore({ config });
    store.handle({ type: "user_blocked", candidate_user_id: "stale" });
    respond = () => ({ status: 200, body: [{ user_id: 2, username: "Ravi", avatar: null, blocked_at: "2026-01-01T00:00:00Z" }] });
    const list = await store.listBlocked();
    expect(calls[0]).toMatchObject({ url: "https://api.example.com/moderation/blocks", method: "GET" });
    expect(list).toEqual([{ userId: "2", username: "Ravi", avatar: null, blockedAt: "2026-01-01T00:00:00Z" }]);
    expect(store.getSnapshot().blockedIds).toEqual(["2"]);
    expect(store.getSnapshot().blockedUsers[0].username).toBe("Ravi");
  });

  it("surfaces moderation errors from the socket only", () => {
    const store = new ModerationStore({ config });
    const errors: string[] = [];
    store.onError((e) => errors.push(e.message));
    store.handle({ type: "error", error: "Cannot block yourself", context: "moderation" });
    store.handle({ type: "error", error: "other", context: "call" });
    expect(errors).toEqual(["Cannot block yourself"]);
    expect(REPORT_CATEGORIES).toEqual(["spam", "harassment", "inappropriate", "fake_profile", "scam", "underage", "other"]);
  });
});
