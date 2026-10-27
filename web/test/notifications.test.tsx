import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatScreen, ConversationListScreen, Dialog, InAppMessageBanners, useWebNotifications, type UseWebNotificationsOptions } from "../src";
import { dto, renderChat, resMessages, user } from "./harness";

const fresh = () => new Date().toISOString();
const setVisibility = (v: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { get: () => v, configurable: true });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
};

const Notifier = (props: UseWebNotificationsOptions) => {
  useWebNotifications(props);
  return null;
};

const setPermission = (p: string) => {
  (globalThis as any).Notification = Object.assign(function () {}, { permission: p, requestPermission: vi.fn(async () => p) });
};

describe("useWebNotifications", () => {
  it("notifies for a message from a non-open chat while the tab is hidden; click opens the chat", async () => {
    setPermission("granted");
    const created: Array<{ title: string; body?: string; onClick: () => void }> = [];
    const onOpenChat = vi.fn();
    const { socket } = await renderChat(
      <>
        <ConversationListScreen onSelect={() => {}} />
        <Notifier onOpenChat={onOpenChat} createNotification={(title, o) => created.push({ title, body: o.body, onClick: o.onClick })} />
      </>,
    );
    socket.receive({ type: "res_users", users: [user("U3", "Carol", { chat_id: 3 })] });
    setVisibility("hidden");
    socket.receive({ type: "new_message", message: dto(10, { chat_id: 3, sender_id: "U3", content: "are you there?", timestamp: fresh() }) });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Carol", body: "are you there?" });
    created[0].onClick();
    expect(onOpenChat).toHaveBeenCalledWith("U3");
    setVisibility("visible");
  });

  it("stays quiet while the tab is visible, without permission, when disabled, and for the same message twice", async () => {
    const created: string[] = [];
    const make = () => ({ createNotification: (t: string) => void created.push(t) });
    setPermission("granted");
    let r = await renderChat(
      <>
        <ConversationListScreen onSelect={() => {}} />
        <Notifier {...make()} />
      </>,
    );
    r.socket.receive({ type: "res_users", users: [user("U3", "Carol", { chat_id: 3 })] });
    setVisibility("visible");
    r.socket.receive({ type: "new_message", message: dto(10, { chat_id: 3, sender_id: "U3", content: "visible tab", timestamp: fresh() }) });
    expect(created).toHaveLength(0);
    r.unmount();

    setPermission("denied");
    r = await renderChat(
      <>
        <ConversationListScreen onSelect={() => {}} />
        <Notifier {...make()} />
      </>,
    );
    r.socket.receive({ type: "res_users", users: [user("U3", "Carol", { chat_id: 3 })] });
    setVisibility("hidden");
    r.socket.receive({ type: "new_message", message: dto(11, { chat_id: 3, sender_id: "U3", content: "denied", timestamp: fresh() }) });
    expect(created).toHaveLength(0);
    r.unmount();

    setPermission("granted");
    r = await renderChat(
      <>
        <ConversationListScreen onSelect={() => {}} />
        <Notifier {...make()} enabled={false} />
      </>,
    );
    r.socket.receive({ type: "res_users", users: [user("U3", "Carol", { chat_id: 3 })] });
    r.socket.receive({ type: "new_message", message: dto(12, { chat_id: 3, sender_id: "U3", content: "disabled", timestamp: fresh() }) });
    expect(created).toHaveLength(0);
    r.unmount();

    r = await renderChat(
      <>
        <ConversationListScreen onSelect={() => {}} />
        <Notifier {...make()} />
      </>,
    );
    r.socket.receive({ type: "res_users", users: [user("U3", "Carol", { chat_id: 3 })] });
    const m = dto(13, { chat_id: 3, sender_id: "U3", content: "once", timestamp: fresh() });
    r.socket.receive({ type: "new_message", message: m });
    r.socket.receive({ type: "new_message", message: m });
    expect(created).toHaveLength(1);
    setVisibility("visible");
  });

  it("does not notify for the open chat; a hidden tab stops counting the chat as open", async () => {
    setPermission("granted");
    setVisibility("visible");
    const created: string[] = [];
    const { socket } = await renderChat(
      <>
        <ChatScreen peerId="U2" />
        <Notifier createNotification={(t, o) => void created.push(`${t}:${o.body}`)} />
      </>,
    );
    socket.receive({ type: "res_users", users: [user("U2", "Bob", { chat_id: 2 })] });
    socket.receive(resMessages([dto(1)]));
    socket.receive({ type: "new_message", message: dto(5, { content: "while open", timestamp: fresh() }) });
    expect(created).toHaveLength(0);
    setVisibility("hidden"); // ChatScreen stops being the active chat while the tab is hidden
    socket.receive({ type: "new_message", message: dto(6, { content: "while hidden", timestamp: fresh() }) });
    expect(created).toEqual(["Bob:while hidden"]);
    setVisibility("visible");
  });

  it("requestPermission asks the browser and reports the result", async () => {
    setPermission("default");
    let api: ReturnType<typeof useWebNotifications> | undefined;
    const Grab = () => ((api = useWebNotifications({})), null);
    await renderChat(<Grab />);
    expect(api?.permission).toBe("default");
    (globalThis as any).Notification.requestPermission = vi.fn(async () => "granted");
    let result: string | undefined;
    await act(async () => void (result = await api?.requestPermission()));
    expect(result).toBe("granted");
  });
});

describe("InAppMessageBanners", () => {
  it("shows a banner for a message in another chat while the tab is visible; click opens it", async () => {
    setVisibility("visible");
    const onOpenChat = vi.fn();
    const { socket } = await renderChat(<InAppMessageBanners onOpenChat={onOpenChat} />);
    socket.receive({ type: "res_users", users: [user("U3", "Carol", { chat_id: 3 })] });
    socket.receive({ type: "new_message", message: dto(10, { chat_id: 3, sender_id: "U3", content: "ping", timestamp: fresh() }) });
    const banner = await screen.findByRole("button", { name: /New message from Carol: ping/ });
    fireEvent.click(banner);
    expect(onOpenChat).toHaveBeenCalledWith("U3");
  });
});

describe("Dialog accessibility", () => {
  it("is a labelled modal, traps Tab, closes on Escape and returns focus to the trigger", () => {
    const Host = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open it</button>
          {open ? (
            <Dialog label="Demo dialog" onClose={() => setOpen(false)}>
              <button>First</button>
              <button>Last</button>
            </Dialog>
          ) : null}
        </>
      );
    };
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Open it" });
    trigger.focus();
    fireEvent.click(trigger);
    const dlg = screen.getByRole("dialog", { name: "Demo dialog" });
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    screen.getByRole("button", { name: "Last" }).focus();
    fireEvent.keyDown(dlg, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    fireEvent.keyDown(dlg, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
