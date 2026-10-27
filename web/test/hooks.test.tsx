import React from "react";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBlocking, useChat, useConnectionStatus, useConversation, useConversations, useUnreadCount } from "../src";
import { dto, FakeWebSocket, renderChat, resMessages, user } from "./harness";

let api: ReturnType<typeof useConversation>;
let list: ReturnType<typeof useConversations>;
let unread = 0;
let status = "";
let chat: ReturnType<typeof useChat>;
let blocking: ReturnType<typeof useBlocking>;

const Probe: React.FC<{ peer?: string }> = ({ peer = "U2" }) => {
  api = useConversation(peer);
  list = useConversations();
  unread = useUnreadCount();
  status = useConnectionStatus().status;
  chat = useChat();
  blocking = useBlocking();
  return (
    <ul>
      {api.messages
        .slice()
        .reverse()
        .map((m) => (
          <li key={String(m.id)} data-testid="m" data-pending={String(!!m.pending)} data-failed={String(!!m.failed)} data-read={String(m.is_read)} data-type={m.message_type}>
            {m.content}
          </li>
        ))}
      <li data-testid="typing">{String(api.typing)}</li>
    </ul>
  );
};

const open = async () => {
  const r = await renderChat(<Probe />);
  r.socket.receive({ type: "res_users", users: [user("U2", "Bob", { chat_id: 2 })] });
  r.socket.receive(resMessages([dto(1, { content: "hi" }), dto(2, { content: "yo" })]));
  return r;
};

describe("socket + store integration (fake WebSocket)", () => {
  it("connects with the token in the path, requests users and opens the conversation", async () => {
    const { socket } = await renderChat(<Probe />);
    expect(socket.url).toBe("ws://srv.test/ws/tok");
    expect(status).toBe("open");
    expect(socket.ofType("req_users").length).toBeGreaterThan(0);
    await waitFor(() => expect(socket.ofType("get_messages").length).toBeGreaterThan(0));
    expect(socket.ofType("get_messages")[0]).toMatchObject({ candidate_user_id: "U2" });
  });

  it("renders history oldest-first and keeps the conversation list live", async () => {
    await open();
    expect(screen.getAllByTestId("m").map((n) => n.textContent)).toEqual(["hi", "yo"]);
    expect(list.loaded).toBe(true);
    expect(list.conversations.map((c) => c.username)).toEqual(["Bob"]);
  });

  it("optimistic send: pending bubble, then message_sent replaces it", async () => {
    const { socket } = await open();
    act(() => void api.send("hello there"));
    const sent = socket.ofType("send_message").pop();
    expect(sent).toMatchObject({ candidate_user_id: "U2", content: "hello there" });
    expect(screen.getByText("hello there").getAttribute("data-pending")).toBe("true");
    socket.receive({ type: "message_sent", message: dto(3, { sender_id: "U1", sender_type: "user", content: "hello there", is_delivered: true }) });
    await waitFor(() => expect(screen.getByText("hello there").getAttribute("data-pending")).toBe("false"));
    expect(screen.getAllByText("hello there")).toHaveLength(1);
  });

  it("read receipts: messages_read turns my messages read", async () => {
    const { socket } = await open();
    act(() => void api.send("read me"));
    socket.receive({ type: "message_sent", message: dto(3, { sender_id: "U1", sender_type: "user", content: "read me", is_delivered: true }) });
    expect(screen.getByText("read me").getAttribute("data-read")).toBe("false");
    socket.receive({ type: "messages_read", chat_id: 2, read_by: "U2" });
    await waitFor(() => expect(screen.getByText("read me").getAttribute("data-read")).toBe("true"));
  });

  it("incoming message in the open chat is marked read; typing_status toggles typing", async () => {
    const { socket } = await open();
    socket.receive({ type: "new_message", message: dto(5, { content: "live one" }) });
    await screen.findByText("live one");
    expect(socket.ofType("mark_read").length).toBeGreaterThan(0);
    socket.receive({ type: "typing_status", user_id: "U2", chat_id: 2, is_typing: true });
    expect(screen.getByTestId("typing").textContent).toBe("true");
    socket.receive({ type: "typing_status", user_id: "U2", chat_id: 2, is_typing: false });
    expect(screen.getByTestId("typing").textContent).toBe("false");
  });

  it("messages for another chat raise the unread count", async () => {
    const { socket } = await open();
    socket.receive({ type: "res_users", users: [user("U2", "Bob", { chat_id: 2 }), user("U3", "Carol", { chat_id: 3 })] });
    socket.receive({ type: "new_message", message: dto(9, { chat_id: 3, sender_id: "U3", content: "psst" }) });
    await waitFor(() => expect(unread).toBe(1));
    expect(list.conversations.find((c) => c.user_id === "U3")?.unread_count).toBe(1);
  });

  it("unsend for everyone and chat_cleared events", async () => {
    const { socket } = await open();
    socket.receive({ type: "message_deleted", chat_id: 2, message_id: 2, for_everyone: true });
    await waitFor(() => expect(screen.getAllByTestId("m")[1].getAttribute("data-type")).toBe("deleted"));
    socket.receive({ type: "chat_cleared", chat_id: 2, cleared_at: new Date(Date.now() + 1000).toISOString() });
    await waitFor(() => expect(screen.queryAllByTestId("m")).toHaveLength(0));
  });

  it("sends delete_message / clear_chat frames", async () => {
    const { socket } = await open();
    act(() => void api.deleteMessage(2, { forEveryone: true }));
    expect(socket.ofType("delete_message").pop()).toMatchObject({ message_id: 2, for_everyone: true });
    act(() => void api.clearChat());
    expect(socket.ofType("clear_chat").pop()).toMatchObject({ chat_id: 2 });
  });

  it("rate limit error: message fails with retry info and onError fires", async () => {
    const onError = vi.fn();
    const r = await renderChat(<Probe />, { onError });
    r.socket.receive({ type: "res_users", users: [user("U2", "Bob")] });
    r.socket.receive(resMessages([dto(1)]));
    act(() => void api.send("spam"));
    r.socket.receive({ type: "error", error: "Slow down", code: "rate_limited", retry_after: 7 });
    await waitFor(() => expect(screen.getByText("spam").getAttribute("data-failed")).toBe("true"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "rate_limited", retryAfter: 7 }));
    expect(api.rateLimitedUntil).toBeGreaterThan(Date.now());
  });

  it("blocking: user_blocked / user_unblocked events update useBlocking", async () => {
    const { socket } = await open();
    socket.receive({ type: "user_blocked", candidate_user_id: "U2", message: "ok" });
    await waitFor(() => expect(blocking.isBlocked("U2")).toBe(true));
    socket.receive({ type: "user_unblocked", candidate_user_id: "U2", message: "ok" });
    await waitFor(() => expect(blocking.isBlocked("U2")).toBe(false));
  });

  it("tab visibility sends user_status away / online", async () => {
    const { socket } = await open();
    const set = (v: string) => {
      Object.defineProperty(document, "visibilityState", { get: () => v, configurable: true });
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
    };
    set("hidden");
    expect(socket.ofType("user_status").pop()).toMatchObject({ status: "away" });
    set("visible");
    expect(socket.ofType("user_status").pop()).toMatchObject({ status: "online" });
  });

  it("socket close: status becomes reconnecting; window online event reconnects at once", async () => {
    const { socket } = await open();
    const before = FakeWebSocket.instances.length;
    socket.drop();
    expect(status).toBe("reconnecting");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(before));
    expect(chat.store).toBeTruthy();
  });
});
