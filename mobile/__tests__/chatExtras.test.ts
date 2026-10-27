/** PROTOCOL §9 chat extras in the ChatStore: delete / unsend, clear chat, system messages, rate limits. */
import { ChatStore, timestampMs } from "../src/chat/ChatStore";
import { isDeletedMessage, isSystemMessage, type ChatError } from "../src/chat/types";
import { makeSender } from "./helpers";

const ME = "U1";
const PEER = "U2";
const CHAT = 7;

const dto = (over: Record<string, any> = {}) => ({
  id: 1,
  chat_id: CHAT,
  sender_id: PEER,
  sender_type: "other",
  content: "hi",
  message_type: "text",
  timestamp: "2026-01-01T10:00:00",
  is_read: false,
  is_delivered: true,
  ...over,
});

const setup = () => {
  const s = makeSender();
  const errors: ChatError[] = [];
  const store = new ChatStore({ send: s.send, canSend: () => true, getUserId: () => ME, onError: (e) => errors.push(e) });
  store.handle({
    type: "res_users",
    users: [{ user_id: PEER, username: "Asha", status: "online", unread_count: 3, chat_id: CHAT, last_message: dto({ id: 3, content: "m3", timestamp: "2026-01-01T10:03:00" }) }],
  } as any);
  store.openConversation(PEER);
  store.handle({
    type: "res_messages",
    offset: 0,
    has_more: false,
    info: { user_id: PEER, username: "Asha" },
    messages: [
      dto({ id: 3, content: "m3", timestamp: "2026-01-01T10:03:00" }),
      dto({ id: 2, content: "m2", sender_id: ME, sender_type: "user", timestamp: "2026-01-01T10:02:00", file_url: "https://x/f.pdf", file_name: "f.pdf" }),
      dto({ id: 1, content: "m1", timestamp: "2026-01-01T10:01:00" }),
    ],
  } as any);
  s.clear();
  return { store, s, errors };
};

const ids = (store: ChatStore) => store.getThread(PEER)!.messages.map((m) => String(m.id));

describe("timestampMs", () => {
  it("treats naive ISO strings as UTC and trims microseconds", () => {
    expect(timestampMs("2026-01-01T10:00:00")).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
    expect(timestampMs("2026-01-01 10:00:00.123456")).toBe(Date.UTC(2026, 0, 1, 10, 0, 0, 123));
    expect(timestampMs("2026-01-01T10:00:00+02:00")).toBe(Date.UTC(2026, 0, 1, 8, 0, 0));
    expect(Number.isNaN(timestampMs(null))).toBe(true);
  });
});

describe("message_deleted", () => {
  it("for everyone: replaced by a deleted placeholder (thread + preview)", () => {
    const { store } = setup();
    store.handle({ type: "message_deleted", chat_id: CHAT, message_id: 3, for_everyone: true } as any);
    const m = store.getThread(PEER)!.messages[0];
    expect(isDeletedMessage(m)).toBe(true);
    expect(m).toMatchObject({ id: 3, content: "", file_url: null });
    expect(isDeletedMessage(store.getConversation(PEER)!.last_message!)).toBe(true);
    expect(ids(store)).toEqual(["3", "2", "1"]);
  });

  it("for me: removed; preview falls back to the next message", () => {
    const { store } = setup();
    store.handle({ type: "message_deleted", chat_id: CHAT, message_id: 3, for_everyone: false } as any);
    expect(ids(store)).toEqual(["2", "1"]);
    expect(store.getConversation(PEER)!.last_message!.id).toBe(2);
  });

  it("deleteMessage sends delete_message; for me hides at once, for everyone waits for the server", () => {
    const { store, s } = setup();
    expect(store.deleteMessage(PEER, 2, { forEveryone: true })).toBe(true);
    expect(s.last("delete_message")).toMatchObject({ message_id: 2, for_everyone: true });
    expect(ids(store)).toEqual(["3", "2", "1"]);
    store.deleteMessage(PEER, 1);
    expect(s.last("delete_message")).toMatchObject({ message_id: 1, for_everyone: false });
    expect(ids(store)).toEqual(["3", "2"]);
  });

  it("deleting an unconfirmed temp message drops it locally without a frame", () => {
    const { store, s } = setup();
    store.sendText(PEER, "oops");
    const temp = store.getThread(PEER)!.messages[0];
    s.clear();
    store.deleteMessage(PEER, temp.id);
    expect(s.sent).toEqual([]);
    expect(ids(store)).toEqual(["3", "2", "1"]);
  });

  it("window_expired / not_allowed surface as delete_failed", () => {
    const { store, errors } = setup();
    store.handle({ type: "error", error: "Too late", code: "window_expired" } as any);
    expect(errors.pop()).toMatchObject({ kind: "delete_failed", code: "window_expired" });
  });
});

describe("chat_cleared", () => {
  it("drops messages up to cleared_at (UTC without Z) and resets preview + unread", () => {
    const { store } = setup();
    store.handle({ type: "chat_cleared", chat_id: CHAT, cleared_at: "2026-01-01T10:02:00" } as any);
    expect(ids(store)).toEqual(["3"]);
    expect(store.getConversation(PEER)).toMatchObject({ unread_count: 0 });
    expect(store.getConversation(PEER)!.last_message!.id).toBe(3);
    store.handle({ type: "chat_cleared", chat_id: CHAT, cleared_at: "2026-01-01T11:00:00.000000" } as any);
    expect(ids(store)).toEqual([]);
    expect(store.getConversation(PEER)!.last_message).toBeNull();
    expect(store.getThread(PEER)!.hasMore).toBe(false);
    expect(store.getSnapshot().unreadTotal).toBe(0);
  });

  it("clearChat sends clear_chat with chat id + candidate", () => {
    const { store, s } = setup();
    store.clearChat(PEER);
    expect(s.last("clear_chat")).toMatchObject({ chat_id: CHAT, candidate_user_id: PEER });
  });

  it("clearChat without a chat id matches the confirmation by order", () => {
    const s = makeSender();
    const store = new ChatStore({ send: s.send, getUserId: () => ME });
    store.openConversation("U9");
    store.handle({ type: "res_messages", offset: 0, info: { user_id: "U9" }, messages: [] } as any);
    store.clearChat("U9");
    expect(s.last("clear_chat")).toEqual({ type: "clear_chat", candidate_user_id: "U9" });
    store.handle({ type: "chat_cleared", chat_id: 99, cleared_at: "2026-01-01T10:00:00" } as any);
    expect(store.getThread("U9")!.chatId).toBe(99);
  });
});

describe("system messages", () => {
  it("message_type system is never mine and lands in the chat by chat id", () => {
    const { store } = setup();
    store.setActiveChat(null);
    store.handle({ type: "new_message", message: dto({ id: 10, sender_id: ME, sender_type: "system", message_type: "system", content: "You matched with Asha", timestamp: "2026-01-01T10:05:00" }) } as any);
    const m = store.getThread(PEER)!.messages[0];
    expect(m).toMatchObject({ id: 10, isMine: false, message_type: "system" });
    expect(isSystemMessage(m)).toBe(true);
    expect(store.getConversation(PEER)!.last_message!.id).toBe(10);
  });

  it("sender_type system without message_type is still a system message", () => {
    expect(isSystemMessage({ message_type: "text", sender_type: "system", id: 4 })).toBe(true);
    expect(isSystemMessage({ message_type: "call", sender_type: "system", id: "call_1" })).toBe(false);
  });
});

describe("rate_limited / too_long", () => {
  it("rate_limited: optimistic message kept as failed, retry_after surfaced and stored", () => {
    const { store, s, errors } = setup();
    const before = Date.now();
    store.sendText(PEER, "spam");
    store.handle({ type: "error", error: "Slow down", code: "rate_limited", retry_after: 7 } as any);
    const m = store.getThread(PEER)!.messages[0];
    expect(m).toMatchObject({ content: "spam", failed: true, pending: false, failReason: "rate_limited" });
    expect(errors.pop()).toMatchObject({ kind: "rate_limited", retryAfter: 7, peerId: PEER });
    const until = store.getSnapshot().rateLimitedUntil!;
    expect(until).toBeGreaterThanOrEqual(before + 7000);

    s.clear();
    expect(store.retryMessage(PEER, m.id)).toBe(true);
    expect(s.last("send_message")).toMatchObject({ content: "spam" });
    expect(store.getThread(PEER)!.messages.filter((x) => x.content === "spam")).toHaveLength(1);
    expect(store.getThread(PEER)!.messages[0]).toMatchObject({ pending: true });
  });

  it("too_long: failed with max", () => {
    const { store, errors } = setup();
    store.sendText(PEER, "x".repeat(10));
    store.handle({ type: "error", error: "Too long", code: "too_long", max: 4000 } as any);
    expect(store.getThread(PEER)!.messages[0]).toMatchObject({ failed: true, failReason: "too_long" });
    expect(errors.pop()).toMatchObject({ kind: "too_long", max: 4000 });
  });

  it("failed messages survive a history refresh; retry of a non-failed message is refused", () => {
    const { store } = setup();
    store.sendText(PEER, "kept");
    store.handle({ type: "error", error: "Slow down", code: "rate_limited", retry_after: 1 } as any);
    store.handle({ type: "res_messages", offset: 0, info: { user_id: PEER }, messages: [dto({ id: 3, content: "m3" })] } as any);
    expect(store.getThread(PEER)!.messages[0]).toMatchObject({ content: "kept", failed: true });
    expect(store.retryMessage(PEER, 3)).toBe(false);
  });
});

describe("mark_read", () => {
  it("sends candidate_user_id with (or without) the chat id", () => {
    const s = makeSender();
    const store = new ChatStore({ send: s.send, getUserId: () => ME });
    store.markRead("U5");
    expect(s.last("mark_read")).toEqual({ type: "mark_read", chat_id: null, candidate_user_id: "U5" });
  });
});
