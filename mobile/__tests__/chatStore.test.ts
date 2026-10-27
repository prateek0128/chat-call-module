import { ChatStore, mergeMessage } from "../src/chat/ChatStore";
import type { ChatError } from "../src/chat/types";
import { UserDirectory } from "../src/core/userDirectory";
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

const setup = (opts: Partial<ConstructorParameters<typeof ChatStore>[0]> = {}) => {
  const s = makeSender();
  const errors: ChatError[] = [];
  const users = new UserDirectory();
  const store = new ChatStore({
    send: s.send,
    canSend: () => true,
    getUserId: () => ME,
    users,
    onError: (e) => errors.push(e),
    ...opts,
  });
  return { store, s, errors, users };
};

const loadUsers = (store: ChatStore, extra: Record<string, any>[] = []) =>
  store.handle({
    type: "res_users",
    users: [
      { user_id: PEER, username: "Asha", avatar: "https://x/a.jpg", status: "online", unread_count: 2, chat_id: CHAT, last_message: null },
      { user_id: "U3", username: "Bina", status: "offline", unread_count: 0, chat_id: 8, last_message: null },
      ...extra,
    ],
  } as any);

const page = (n: number, startId: number, offset = 0, has_more = true) => ({
  type: "res_messages",
  offset,
  has_more,
  info: { user_id: PEER, username: "Asha", status: "online", is_blocked: false, blocked_by_other: false },
  messages: Array.from({ length: n }, (_, i) => dto({ id: startId - i, content: `m${startId - i}` })),
});

describe("ChatStore", () => {
  it("res_users -> conversations, unread total, shared user directory", () => {
    const { store, users } = setup();
    loadUsers(store);
    const s = store.getSnapshot();
    expect(s.conversations.map((c) => c.user_id)).toEqual([PEER, "U3"]);
    expect(s.unreadTotal).toBe(2);
    expect(s.conversationsLoaded).toBe(true);
    expect(users.getName(PEER)).toBe("Asha");
    expect(users.getAvatar(PEER)).toBe("https://x/a.jpg");
  });

  it("openConversation fetches page 1 (limit 10) and marks read", () => {
    const { store, s } = setup();
    loadUsers(store);
    store.openConversation(PEER);
    expect(s.last("get_messages")).toEqual({ type: "get_messages", chat_id: CHAT, candidate_user_id: PEER, offset: 0, limit: 10 });
    expect(s.last("mark_read")).toEqual({ type: "mark_read", chat_id: CHAT, candidate_user_id: PEER });
    expect(store.getConversation(PEER)?.unread_count).toBe(0);
    expect(store.getThread(PEER)?.loading).toBe(true);
  });

  it("res_messages: newest first, hasMore by page size, loadMore uses offset of loaded messages", () => {
    const { store, s } = setup();
    store.openConversation(PEER, { chatId: CHAT });
    store.handle(page(10, 20) as any);
    let t = store.getThread(PEER)!;
    expect(t.loaded).toBe(true);
    expect(t.loading).toBe(false);
    expect(t.messages.map((m) => m.id)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    expect(t.hasMore).toBe(true);
    expect(t.info?.username).toBe("Asha");

    expect(store.loadMore(PEER)).toBe(true);
    expect(s.last("get_messages")).toMatchObject({ offset: 10, limit: 10 });
    expect(store.getThread(PEER)!.loadingMore).toBe(true);
    expect(store.loadMore(PEER)).toBe(false); // already loading

    store.handle(page(3, 10, 10, false) as any);
    t = store.getThread(PEER)!;
    expect(t.messages.map((m) => m.id)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8]);
    expect(t.hasMore).toBe(false);
    expect(t.loadingMore).toBe(false);
    expect(store.loadMore(PEER)).toBe(false);
  });

  it("send: optimistic temp_ message replaced by message_sent", () => {
    const { store, s } = setup();
    loadUsers(store);
    store.openConversation(PEER);
    store.handle(page(2, 5, 0, false) as any);
    expect(store.sendText(PEER, "hello", store.getThread(PEER)!.messages[0])).toBe(true);
    expect(s.last("send_message")).toEqual({
      type: "send_message",
      candidate_user_id: PEER,
      chat_id: CHAT,
      message_type: "text",
      content: "hello",
      reply_to_id: 5,
    });
    let t = store.getThread(PEER)!;
    expect(String(t.messages[0].id)).toMatch(/^temp_/);
    expect(t.messages[0]).toMatchObject({ pending: true, isMine: true, is_delivered: false, content: "hello" });
    expect(t.messages[0].reply_to?.id).toBe(5);

    store.handle({ type: "message_sent", message: dto({ id: 6, sender_id: ME, sender_type: "user", content: "hello", is_delivered: false }) } as any);
    t = store.getThread(PEER)!;
    expect(t.messages.map((m) => m.id)).toEqual([6, 5, 4]);
    expect(t.messages[0].isMine).toBe(true);
    expect(store.getConversation(PEER)?.last_message?.id).toBe(6);
  });

  it("send returns false (no temp) when the socket drops the frame", () => {
    const { store, s, errors } = setup();
    s.setOk(false);
    expect(store.sendText(PEER, "x")).toBe(false);
    expect(store.getThread(PEER)!.messages).toHaveLength(0);
    expect(errors[0].kind).toBe("not_connected");
  });

  it("new_message: unread +1 and moves to top unless it's the active chat; flat DTO accepted", () => {
    const { store, s } = setup();
    loadUsers(store);
    store.handle({ type: "new_message", message: dto({ id: 50, chat_id: 8, sender_id: "U3" }) } as any);
    let st = store.getSnapshot();
    expect(st.conversations[0].user_id).toBe("U3");
    expect(st.conversations[0].unread_count).toBe(1);
    expect(st.unreadTotal).toBe(3);

    store.openConversation(PEER);
    store.setActiveChat(PEER);
    s.clear();
    // legacy flat frame
    store.handle({ type: "new_message", ...dto({ id: 51 }) } as any);
    st = store.getSnapshot();
    expect(st.conversations[0].user_id).toBe(PEER);
    expect(st.conversations[0].unread_count).toBe(0);
    expect(store.getThread(PEER)!.messages[0].id).toBe(51);
    // active + open -> auto mark_read
    expect(s.last("mark_read")).toMatchObject({ chat_id: CHAT });
  });

  it("unknown chat in new_message triggers one req_users", () => {
    const { store, s } = setup();
    loadUsers(store);
    s.clear();
    store.handle({ type: "new_message", message: dto({ id: 70, chat_id: 99, sender_id: "U9" }) } as any);
    store.handle({ type: "new_message", message: dto({ id: 71, chat_id: 99, sender_id: "U9" }) } as any);
    expect(s.ofType("req_users")).toHaveLength(1);
  });

  it("chat_read clears unread; messages_read turns my messages read; delivery_status delivers", () => {
    const { store } = setup();
    loadUsers(store);
    store.openConversation(PEER);
    store.handle({
      type: "res_messages",
      offset: 0,
      info: { user_id: PEER },
      messages: [
        dto({ id: 3, sender_id: ME, sender_type: "user", is_delivered: false }),
        dto({ id: 2, sender_id: ME, sender_type: "user", is_delivered: false }),
        dto({ id: 1 }),
      ],
    } as any);
    store.handle({ type: "delivery_status", chat_id: CHAT, message_ids: [2], status: "delivered" } as any);
    let msgs = store.getThread(PEER)!.messages;
    expect(msgs.find((m) => m.id === 2)!.is_delivered).toBe(true);
    expect(msgs.find((m) => m.id === 3)!.is_delivered).toBe(false);

    store.handle({ type: "messages_read", chat_id: CHAT, read_by: PEER } as any);
    msgs = store.getThread(PEER)!.messages;
    expect(msgs.filter((m) => m.isMine).every((m) => m.is_read && m.is_delivered)).toBe(true);
    expect(msgs.find((m) => m.id === 1)!.is_read).toBe(false);

    store.handle({ type: "new_message", message: dto({ id: 9, chat_id: 8, sender_id: "U3" }) } as any);
    expect(store.getConversation("U3")!.unread_count).toBe(1);
    store.handle({ type: "chat_read", chat_id: 8 } as any);
    expect(store.getConversation("U3")!.unread_count).toBe(0);
  });

  it("mergeMessage never moves ticks backwards", () => {
    const base: any = { id: 1, is_read: true, is_delivered: true, content: "a" };
    const stale: any = { id: 1, is_read: false, is_delivered: false, content: "b" };
    expect(mergeMessage(base, stale)).toMatchObject({ is_read: true, is_delivered: true, content: "b" });
    const { store } = setup();
    store.openConversation(PEER, { chatId: CHAT });
    store.handle({ type: "res_messages", info: { user_id: PEER }, messages: [dto({ id: 4, sender_type: "user", sender_id: ME, is_read: true })] } as any);
    store.handle({ type: "message_sent", message: dto({ id: 4, sender_type: "user", sender_id: ME, is_read: false, is_delivered: false }) } as any);
    expect(store.getThread(PEER)!.messages[0]).toMatchObject({ is_read: true, is_delivered: true });
    expect(store.getThread(PEER)!.messages).toHaveLength(1);
  });

  it("typing auto-clears after 4 s", () => {
    jest.useFakeTimers();
    try {
      const { store } = setup();
      store.handle({ type: "typing_status", user_id: PEER, chat_id: CHAT, is_typing: true } as any);
      expect(store.getSnapshot().typing[PEER]).toBe(true);
      jest.advanceTimersByTime(3999);
      expect(store.getSnapshot().typing[PEER]).toBe(true);
      jest.advanceTimersByTime(1);
      expect(store.getSnapshot().typing[PEER]).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("setTyping sends typing with the peer as target", () => {
    const { store, s } = setup();
    loadUsers(store);
    store.setTyping(PEER, true);
    expect(s.last("typing")).toEqual({ type: "typing", target_user_id: PEER, chat_id: CHAT, is_typing: true });
  });

  it("user_status updates presence and last_seen", () => {
    const { store } = setup();
    loadUsers(store);
    store.openConversation(PEER);
    store.handle(page(1, 1, 0, false) as any);
    store.handle({ type: "user_status", user_id: PEER, status: "offline", timestamp: "2026-01-01T12:00:00" } as any);
    expect(store.getConversation(PEER)).toMatchObject({ status: "offline", last_seen: "2026-01-01T12:00:00" });
    expect(store.getThread(PEER)!.info).toMatchObject({ status: "offline", last_seen: "2026-01-01T12:00:00" });
  });

  it("chat send error drops pending temps and reports; call errors are ignored", () => {
    const { store, errors } = setup();
    loadUsers(store);
    store.openConversation(PEER);
    store.sendText(PEER, "x");
    store.handle({ type: "error", context: "call", error: "Failed to send offer" } as any);
    expect(store.getThread(PEER)!.messages).toHaveLength(1);
    store.handle({ type: "error", error: "You are blocked; cannot send" } as any);
    expect(store.getThread(PEER)!.messages).toHaveLength(0);
    expect(errors.map((e) => e.kind)).toEqual(["send_failed"]);
    expect(store.getConversation(PEER)!.last_message).toBeNull();
  });

  it("blocked conversation refuses to send", () => {
    const { store, errors, s } = setup();
    store.openConversation(PEER, { chatId: CHAT });
    store.handle({ type: "res_messages", info: { user_id: PEER, is_blocked: true }, messages: [] } as any);
    s.clear();
    expect(store.sendText(PEER, "x")).toBe(false);
    expect(s.sent).toHaveLength(0);
    expect(errors[0].kind).toBe("blocked");
  });

  it("re-fetches open conversations and the list on (re)connect", () => {
    const { store, s } = setup();
    const close = store.openConversation(PEER, { chatId: CHAT });
    store.openConversation("U3", { chatId: 8 })();
    s.clear();
    store.onConnected();
    expect(s.sent.map((m) => [m.type, m.candidate_user_id])).toEqual([
      ["req_users", undefined],
      ["get_messages", PEER],
    ]);
    close();
  });

  it("fresh reload drops temps but keeps older pages", () => {
    const { store } = setup();
    store.openConversation(PEER, { chatId: CHAT });
    store.handle(page(10, 20) as any);
    store.loadMore(PEER);
    store.handle(page(2, 10, 10, false) as any);
    store.sendText(PEER, "pending");
    store.handle(page(10, 20) as any); // reconnect reload
    const ids = store.getThread(PEER)!.messages.map((m) => String(m.id));
    expect(ids.some((id) => id.startsWith("temp_"))).toBe(false);
    expect(ids).toHaveLength(12);
  });

  describe("call entries", () => {
    const open = () => {
      const ctx = setup();
      loadUsers(ctx.store);
      ctx.store.openConversation(PEER);
      ctx.store.handle(page(1, 1, 0, false) as any);
      return ctx;
    };

    it("call_initiated (legacy caller view) adds my call entry once; call_log rewrites it", () => {
      const { store } = open();
      const ev = { type: "call_initiated", call_id: "c1", chat_id: CHAT, caller_id: PEER, receiver_id: PEER, caller_name: PEER, call_type: "audio" };
      store.handle(ev as any);
      store.handle({ ...ev, type: "call_ringing" } as any);
      store.handle({ ...ev, type: "call_answered" } as any);
      let msgs = store.getThread(PEER)!.messages;
      expect(msgs[0]).toMatchObject({ id: "call_c1", message_type: "call", isMine: true, call_id: "c1" });
      expect(msgs.filter((m) => m.call_id === "c1")).toHaveLength(1);

      // local fallback first, then the server's version (with message id) wins
      store.handle({ type: "call_log", call_id: "c1", content: "Voice call · 00:10", local: true } as any);
      expect(store.getThread(PEER)!.messages[0].content).toBe("Voice call · 00:10");
      store.handle({ type: "call_log", call_id: "c1", chat_id: CHAT, message_id: 99, content: "Voice call · 00:11" } as any);
      msgs = store.getThread(PEER)!.messages;
      expect(msgs[0]).toMatchObject({ id: 99, content: "Voice call · 00:11", call_id: "c1" });
      // a late local log does not overwrite the server text
      store.handle({ type: "call_log", call_id: "c1", content: "Voice call · 00:10", local: true } as any);
      expect(store.getThread(PEER)!.messages[0].content).toBe("Voice call · 00:11");
    });

    it("incoming_call adds the caller's entry; busy (call_id null) adds nothing", () => {
      const { store } = open();
      store.handle({ type: "incoming_call", call_id: "c2", chat_id: null, caller_id: PEER, receiver_id: ME, caller_name: "Asha" } as any);
      expect(store.getThread(PEER)!.messages[0]).toMatchObject({ id: "call_c2", sender_id: PEER, isMine: false });
      const before = store.getThread(PEER)!.messages.length;
      store.handle({ type: "call_rejected", call_id: null, status: "busy", reason: "busy", caller_id: ME, receiver_id: PEER } as any);
      expect(store.getThread(PEER)!.messages.length).toBe(before);
    });

    it("stored audio_call messages are normalised to 'call'", () => {
      const { store } = setup();
      store.openConversation(PEER, { chatId: CHAT });
      store.handle({
        type: "res_messages",
        info: { user_id: PEER },
        messages: [dto({ id: 5, message_type: "video_call", content: "Missed video call", call_id: "c9" })],
      } as any);
      expect(store.getThread(PEER)!.messages[0]).toMatchObject({ message_type: "call", call_type: "video" });
    });
  });

  describe("sendMedia", () => {
    it("reads base64, sends media_upload, temp replaced by media_upload_success / message_sent", async () => {
      const read = jest.fn(async () => "QUJD"); // "ABC"
      const { store, s } = setup({ readFileAsBase64: read });
      loadUsers(store);
      store.openConversation(PEER);
      const p = store.sendMedia(PEER, { uri: "file:///a/photo.jpg", type: "image/jpeg", size: 3 });
      // temp shows immediately (uploading)
      expect(store.getThread(PEER)!.messages[0]).toMatchObject({ pending: true, message_type: "image", file_url: "file:///a/photo.jpg" });
      expect(await p).toBe(true);
      expect(s.last("media_upload")).toEqual({
        type: "media_upload",
        target_user_id: PEER,
        media_type: "photos",
        file_name: "photo.jpg",
        file_type: "image/jpeg",
        file_data: "QUJD",
      });
      const server = dto({ id: 40, sender_id: ME, sender_type: "user", content: null, message_type: "image", file_url: "https://s3/x.jpg" });
      store.handle({ type: "media_upload_success", message: server } as any);
      store.handle({ type: "message_sent", message: { ...server, content: "[IMAGE] photo.jpg" } } as any);
      const msgs = store.getThread(PEER)!.messages;
      expect(msgs.filter((m) => m.pending)).toHaveLength(0);
      expect(msgs.filter((m) => m.id === 40)).toHaveLength(1);
      expect(msgs[0].file_url).toBe("https://s3/x.jpg");
    });

    it("rejects files over 10 MB (by size or by base64 length)", async () => {
      const { store, s, errors } = setup({ readFileAsBase64: async () => "AAAA" });
      expect(await store.sendMedia(PEER, { uri: "file:///big.mp4", type: "video/mp4", size: 11 * 1024 * 1024 })).toBe(false);
      const big = "A".repeat(Math.ceil((10 * 1024 * 1024 + 10) * (4 / 3)));
      const store2 = setup({ readFileAsBase64: async () => big });
      expect(await store2.store.sendMedia(PEER, { uri: "file:///big.bin" })).toBe(false);
      expect(errors[0].kind).toBe("too_large");
      expect(s.ofType("media_upload")).toHaveLength(0);
      expect(store.getThread(PEER)!.messages).toHaveLength(0);
    });

    it("read failure drops the temp and reports", async () => {
      const { store, errors } = setup({ readFileAsBase64: async () => Promise.reject(new Error("nope")) });
      expect(await store.sendMedia(PEER, { uri: "file:///x.pdf", type: "application/pdf" })).toBe(false);
      expect(store.getThread(PEER)!.messages).toHaveLength(0);
      expect(errors[0].kind).toBe("read_failed");
    });
  });

  it("works with useSyncExternalStore semantics: snapshot identity changes only on updates", () => {
    const { store } = setup();
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    const listener = jest.fn();
    const unsub = store.subscribe(listener);
    loadUsers(store);
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(a);
    unsub();
  });
});
