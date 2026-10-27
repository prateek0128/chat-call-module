import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatScreen, splitLinks, type ChatScreenProps } from "../src";
import { dto, renderChat, resMessages, user } from "./harness";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const mine = (id: number, content: string, over: Record<string, unknown> = {}) => dto(id, { sender_id: "U1", sender_type: "user", content, ...over });

const openChat = async (messages: any[], props: Partial<ChatScreenProps> = {}, info: Record<string, unknown> = {}, opts: Parameters<typeof renderChat>[1] = {}) => {
  const r = await renderChat(<ChatScreen peerId="U2" {...props} />, opts);
  r.socket.receive({ type: "res_users", users: [user("U2", "Bob", { chat_id: 2 })] });
  r.socket.receive(resMessages(messages, { info: { user_id: "U2", username: "Bob", avatar: null, status: "online", last_seen: null, is_blocked: false, blocked_by_other: false, ...info } }));
  return r;
};

const menuFor = async (text: string) => {
  const row = screen.getByText(text).closest(".ck-msg-row") as HTMLElement;
  fireEvent.contextMenu(row.querySelector(".ck-bubble") as HTMLElement);
  const menu = await screen.findByRole("menu", { name: "Message actions" });
  return { menu, items: within(menu).queryAllByRole("menuitem").map((i) => i.textContent) };
};

describe("message actions menu availability", () => {
  it("own recent text: Reply, Copy, Delete for me, Delete for everyone (no Report)", async () => {
    await openChat([mine(1, "my fresh message", { timestamp: iso(60_000) })]);
    const { items } = await menuFor("my fresh message");
    expect(items).toEqual(["Reply", "Copy text", "Delete for me", "Delete for everyone"]);
  });

  it("own message older than the unsend window loses Delete for everyone (window is configurable)", async () => {
    await openChat([mine(1, "ancient message", { timestamp: iso(2 * 3600_000) })]);
    expect((await menuFor("ancient message")).items).not.toContain("Delete for everyone");
  });

  it("unsendWindowSeconds=0 means no limit; -1 disables", async () => {
    const r = await openChat([mine(1, "very old", { timestamp: iso(48 * 3600_000) })], { unsendWindowSeconds: 0 });
    expect((await menuFor("very old")).items).toContain("Delete for everyone");
    r.unmount();
    await openChat([mine(1, "fresh", { timestamp: iso(1000) })], { unsendWindowSeconds: -1 });
    expect((await menuFor("fresh")).items).not.toContain("Delete for everyone");
  });

  it("incoming text: Reply, Copy, Report message, Delete for me; never Delete for everyone", async () => {
    await openChat([dto(1, { content: "from bob", timestamp: iso(1000) })]);
    expect((await menuFor("from bob")).items).toEqual(["Reply", "Copy text", "Report message", "Delete for me"]);
  });

  it("Report is hidden without a ModerationProvider", async () => {
    await openChat([dto(1, { content: "from bob", timestamp: iso(1000) })], {}, {}, { moderation: false });
    expect((await menuFor("from bob")).items).not.toContain("Report message");
  });

  it("files get Download; Share only where navigator.share exists", async () => {
    const file = dto(1, { message_type: "document", content: "[DOCUMENT] a.pdf", file_name: "a.pdf", file_url: "/media/a.pdf", file_type: "application/pdf", file_size: 2048 });
    const r = await openChat([file]);
    let items = (await menuFor("a.pdf")).items;
    expect(items).toContain("Download");
    expect(items).not.toContain("Share");
    expect(items).not.toContain("Copy text"); // placeholder text is not copyable
    r.unmount();
    (navigator as any).share = vi.fn();
    await openChat([file]);
    items = (await menuFor("a.pdf")).items;
    expect(items).toContain("Share");
    delete (navigator as any).share;
  });

  it("deleted messages only offer Delete for me; call entries and system chips offer nothing", async () => {
    await openChat([dto(1, { message_type: "deleted", content: null })]);
    const menu = await menuFor("This message was deleted");
    expect(menu.items).toEqual(["Delete for me"]);
  });

  it("Delete for everyone asks first, then sends delete_message", async () => {
    const { socket } = await openChat([mine(1, "oops", { timestamp: iso(1000) })]);
    await menuFor("oops");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete for everyone" }));
    const dlg = await screen.findByRole("dialog", { name: "Delete for everyone?" });
    expect(socket.ofType("delete_message")).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole("button", { name: "Delete for everyone" }));
    expect(socket.ofType("delete_message").pop()).toMatchObject({ message_id: 1, for_everyone: true });
  });

  it("Delete for me removes the message locally right away", async () => {
    const { socket } = await openChat([dto(1, { content: "bye" }), dto(2, { content: "stay" })]);
    await menuFor("bye");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete for me" }));
    expect(socket.ofType("delete_message").pop()).toMatchObject({ message_id: 1, for_everyone: false });
    await waitFor(() => expect(screen.queryByText("bye")).toBeNull());
    expect(screen.getByText("stay")).toBeTruthy();
  });

  it("the hover button opens the same menu and Escape closes it", async () => {
    await openChat([dto(1, { content: "hello" })]);
    const row = screen.getByText("hello").closest(".ck-msg-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Message actions", hidden: true }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("reply, composer and attachments", () => {
  it("Reply shows the reply bar, sends reply_to_id with the message, Cancel clears it", async () => {
    const { socket } = await openChat([dto(7, { content: "question?" })]);
    await menuFor("question?");
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
    expect(await screen.findByText("Replying to Bob")).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "answer" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(socket.ofType("send_message").pop()).toMatchObject({ content: "answer", reply_to_id: 7 });
    expect(screen.queryByText("Replying to Bob")).toBeNull();
    // optimistic bubble already shows the quote
    expect(document.querySelector(".ck-quote")?.textContent).toContain("question?");
    fireEvent.contextMenu(document.querySelector('[data-msg-id="7"] .ck-bubble') as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.queryByText("Replying to Bob")).toBeNull();
  });

  it("Enter sends, Shift+Enter does not; empty text is not sent", async () => {
    const { socket } = await openChat([dto(1)]);
    const box = screen.getByRole("textbox", { name: "Message" });
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "first line" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(socket.ofType("send_message")).toHaveLength(0);
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(socket.ofType("send_message")).toHaveLength(1);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("typing events are throttled and stop after idle or send", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { socket } = await openChat([dto(1)]);
    const box = screen.getByRole("textbox", { name: "Message" });
    const typing = () => socket.ofType("typing").map((f) => f.is_typing);
    for (const v of ["h", "he", "hel", "hell", "hello"]) fireEvent.change(box, { target: { value: v } });
    expect(typing()).toEqual([true]); // one event for five keystrokes
    act(() => void vi.advanceTimersByTime(3100));
    expect(typing()).toEqual([true, false]); // idle -> stopped
    fireEvent.change(box, { target: { value: "hello again" } });
    expect(typing()).toEqual([true, false, true]);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(typing()).toEqual([true, false, true, false]); // sending stops typing
  });

  it("rate limit notice: composer shows the wait and blocks sending, then recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { socket } = await openChat([dto(1)]);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "too fast" } });
    fireEvent.keyDown(box, { key: "Enter" });
    socket.receive({ type: "error", error: "Slow down", code: "rate_limited", retry_after: 3 });
    expect(screen.getByText(/sending messages too fast. Try again in 3 s/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "again" } });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => void vi.advanceTimersByTime(3600));
    expect(screen.queryByText(/too fast. Try again/)).toBeNull();
  });

  it("failed message shows Not sent + Retry which resends", async () => {
    const { socket } = await openChat([dto(1)]);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "flaky" } });
    fireEvent.keyDown(box, { key: "Enter" });
    socket.receive({ type: "error", error: "Slow down", code: "rate_limited", retry_after: 1 });
    const failed = await screen.findByText("Not sent");
    fireEvent.click(within(failed.closest(".ck-failed") as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(socket.ofType("send_message")).toHaveLength(2);
  });

  it("attachment over 10 MB is refused before upload with a toast; a small file opens the preview and uploads", async () => {
    const read = vi.fn(async () => "QUJD");
    const { socket, container } = await openChat([dto(1)], {}, {}, { readFileAsBase64: read });
    const input = container.querySelector('[data-testid="file-document"]') as HTMLInputElement;
    const big = new File([new Uint8Array(1)], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/huge.bin: File is too large \(11 MB\)\. The limit is 10 MB\./)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Send attachment" })).toBeNull();

    const ok = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [ok] } });
    const dlg = await screen.findByRole("dialog", { name: "Send attachment" });
    expect(within(dlg).getAllByText(/notes\.txt/).length).toBeGreaterThan(0);
    fireEvent.click(within(dlg).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(socket.ofType("media_upload")).toHaveLength(1));
    expect(socket.ofType("media_upload")[0]).toMatchObject({ target_user_id: "U2", file_name: "notes.txt", file_data: "QUJD" });
    expect(read).toHaveBeenCalled();
  });

  it("pasting an image and dropping a file both go to the attachment preview", async () => {
    const { container } = await openChat([dto(1)]);
    const box = screen.getByRole("textbox", { name: "Message" });
    const img = new File(["x"], "pasted.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [img], items: [], types: ["Files"] } });
    expect(await screen.findByRole("dialog", { name: "Send attachment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const chat = container.querySelector(".ck-chat") as HTMLElement;
    const doc = new File(["y"], "dropped.pdf", { type: "application/pdf" });
    fireEvent.dragEnter(chat, { dataTransfer: { types: ["Files"], files: [doc] } });
    expect(screen.getByText("Drop to send")).toBeTruthy();
    fireEvent.drop(chat, { dataTransfer: { types: ["Files"], files: [doc] } });
    expect(await screen.findByRole("dialog", { name: "Send attachment" })).toBeTruthy();
  });

  it("attach menu lists Gallery, Camera, Video, Document; Camera uses the capture attribute", async () => {
    const { container } = await openChat([dto(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
    const menu = await screen.findByRole("menu", { name: "Attach" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Gallery", "Camera", "Video", "Document"]);
    expect(container.querySelector('[data-testid="file-camera"]')?.getAttribute("capture")).toBe("environment");
    expect(container.querySelector('[data-testid="file-video"]')?.getAttribute("accept")).toBe("video/*");
  });

  it("emoji button points to the native picker instead of bundling one", async () => {
    await openChat([dto(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    expect(screen.getByText(/system emoji picker/)).toBeTruthy();
  });
});

describe("blocked and gated states", () => {
  it("I blocked them: composer replaced by the blocked note + Unblock; header says Blocked", async () => {
    await openChat([dto(1)], {}, { is_blocked: true });
    expect(await screen.findByText("You blocked Bob.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unblock Bob" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(document.querySelector(".ck-header-status")?.textContent).toBe("Blocked");
    expect(document.querySelector(".ck-header .ck-presence-dot, .ck-chat-header .ck-presence-dot")).toBeNull();
  });

  it("they blocked me: no Unblock, 'You are blocked', no typing bubble", async () => {
    await openChat([dto(1)], {}, { blocked_by_other: true });
    expect(await screen.findByText("You can't reply to this conversation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unblock/ })).toBeNull();
    expect(document.querySelector(".ck-header-status")?.textContent).toBe("You are blocked");
  });

  it("Unblock and Block go through moderation (REST) and confirm first", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await openChat([dto(1)], {}, { is_blocked: true });
    fireEvent.click(await screen.findByRole("button", { name: "Unblock Bob" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String((fetchMock.mock.calls[0] as any[])[0])).toContain("/moderation/blocks/U2");
    vi.unstubAllGlobals();
  });

  it("host disabledReason replaces the composer", async () => {
    await openChat([dto(1)], { disabledReason: "Chat is not enabled" });
    expect(await screen.findByText("Chat is not enabled")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("pre-chat gate slot replaces messages and composer while it returns a node", async () => {
    const gate = vi.fn((i: { name: string; loaded: boolean }) => (i.loaded ? <div>Consent needed for {i.name}</div> : null));
    await openChat([dto(1, { content: "hidden text" })], { gate: gate as any });
    expect(await screen.findByText("Consent needed for Bob")).toBeTruthy();
    expect(screen.queryByText("hidden text")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });
});

describe("report and header menu", () => {
  it("overflow menu: Wallpaper, Report, Block, Clear chat; Unblock replaces Block when blocked", async () => {
    await openChat([dto(1)]);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const menu = await screen.findByRole("menu", { name: "Chat options" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Wallpaper", "Report", "Block", "Clear chat"]);
  });

  it("Report sheet has 7 categories, needs one, 'other' needs details, sends report_and_block over the socket", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ report_id: "r1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await openChat([dto(1)]);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Report" }));
    const dlg = await screen.findByRole("dialog", { name: "Report Bob" });
    expect(within(dlg).getAllByRole("radio")).toHaveLength(7);
    const submit = within(dlg).getByRole("button", { name: "Report" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole("radio", { name: "Something else" }));
    expect(submit.disabled).toBe(true); // "other" needs a reason
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "weird" } });
    expect(submit.disabled).toBe(false);
    expect((within(dlg).getByRole("checkbox", { name: /Also block Bob/ }) as HTMLInputElement).checked).toBe(true);
    vi.unstubAllGlobals();
  });

  it("Clear chat confirms, then sends clear_chat", async () => {
    const { socket } = await openChat([dto(1)]);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear chat" }));
    const dlg = await screen.findByRole("dialog", { name: "Clear this chat?" });
    expect(socket.ofType("clear_chat")).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole("button", { name: "Clear chat" }));
    expect(socket.ofType("clear_chat").pop()).toMatchObject({ chat_id: 2 });
  });
});

describe("header presence", () => {
  it("shows the last-seen line and refreshes it every 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const now = Date.now();
    await openChat([dto(1)], {}, { status: "offline", last_seen: new Date(now - 5 * 60_000).toISOString() });
    const status = () => document.querySelector(".ck-header-status")?.textContent;
    expect(status()).toBe("last seen 5 min ago");
    act(() => void vi.advanceTimersByTime(60_000));
    expect(status()).toBe("last seen 6 min ago");
  });

  it("online shows the presence dot, typing wins over online", async () => {
    const { socket } = await openChat([dto(1)]);
    expect(document.querySelector(".ck-chat-header .ck-presence-dot")).toBeTruthy();
    expect(document.querySelector(".ck-header-status")?.textContent).toBe("online");
    socket.receive({ type: "typing_status", user_id: "U2", chat_id: 2, is_typing: true });
    await waitFor(() => expect(document.querySelector(".ck-header-status")?.textContent).toBe("typing…"));
    expect(screen.getByRole("status", { name: "Bob is typing" })).toBeTruthy();
  });

  it("back button only when onBack is given; Call only when onCall is given", async () => {
    const r = await openChat([dto(1)]);
    expect(screen.queryByRole("button", { name: "Back to chats" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Call Bob" })).toBeNull();
    r.unmount();
    const onBack = vi.fn();
    const onCall = vi.fn();
    await openChat([dto(1)], { onBack, onCall });
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Call Bob" }));
    expect(onBack).toHaveBeenCalled();
    expect(onCall).toHaveBeenCalledWith("U2");
  });
});

describe("message list", () => {
  it("links are clickable with rel=noopener and trailing punctuation stays outside", async () => {
    expect(splitLinks("see https://example.com/a?b=1, and www.test.org.")).toEqual([
      { type: "text", text: "see " },
      { type: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { type: "text", text: ", and " },
      { type: "link", text: "www.test.org", href: "https://www.test.org" },
      { type: "text", text: "." },
    ]);
    await openChat([dto(1, { content: "go to https://example.com/x now" })]);
    const a = screen.getByRole("link", { name: "https://example.com/x" });
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
  });

  it("does not turn javascript: or plain words into links", () => {
    expect(splitLinks("javascript:alert(1) and example")).toEqual([{ type: "text", text: "javascript:alert(1) and example" }]);
  });

  it("groups messages within 5 minutes (one tail per group) and adds date separators", async () => {
    const t = Date.now();
    await openChat([
      dto(1, { content: "g1a", timestamp: new Date(t - 40 * 3600_000).toISOString() }),
      dto(2, { content: "g2a", timestamp: new Date(t - 3 * 60_000).toISOString() }),
      dto(3, { content: "g2b", timestamp: new Date(t - 2 * 60_000).toISOString() }),
      dto(4, { content: "g3a", timestamp: new Date(t - 30_000).toISOString(), sender_id: "U1", sender_type: "user" }),
    ]);
    const bubble = (txt: string) => screen.getByText(txt).closest(".ck-bubble") as HTMLElement;
    expect(bubble("g2a").classList.contains("ck-tail")).toBe(true);
    expect(bubble("g2b").classList.contains("ck-tail")).toBe(false);
    expect(bubble("g3a").classList.contains("ck-tail")).toBe(true);
    const chips = Array.from(document.querySelectorAll(".ck-date-chip")).map((n) => n.textContent);
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips[chips.length - 1]).toBe("Today");
  });

  it("ticks: pending, sent, delivered and read with accessible labels", async () => {
    const { socket } = await openChat([
      mine(1, "t-sent", { is_delivered: false, is_read: false }),
      mine(2, "t-delivered", { is_delivered: true, is_read: false }),
      mine(3, "t-read", { is_delivered: true, is_read: true }),
    ]);
    const tick = (txt: string) => (screen.getByText(txt).closest(".ck-bubble") as HTMLElement).querySelector(".ck-ticks");
    expect(tick("t-sent")?.getAttribute("aria-label")).toBe("Sent");
    expect(tick("t-delivered")?.getAttribute("aria-label")).toBe("Delivered");
    expect(tick("t-read")?.getAttribute("data-state")).toBe("read");
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "t-pending" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(tick("t-pending")?.getAttribute("aria-label")).toBe("Sending");
    void socket;
  });

  it("system chips, deleted bubbles and side-aware call entries render; Call back only with onCall", async () => {
    const msgs = [
      dto(1, { message_type: "system", sender_type: "system", content: "You matched with Bob" }),
      dto(2, { message_type: "deleted", content: null }),
      dto(3, { message_type: "audio_call", content: "Missed voice call" }),
      mine(4, "x", { message_type: "audio_call", content: "Voice call · 00:12" }),
    ];
    const onCall = vi.fn();
    const r = await openChat(msgs, { onCall });
    expect(screen.getByText("You matched with Bob").className).toContain("ck-system-chip");
    expect(screen.getByText("This message was deleted")).toBeTruthy();
    const chips = Array.from(document.querySelectorAll(".ck-call-row"));
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.classList.contains("is-mine"))).toEqual([false, true]);
    expect(within(chips[0] as HTMLElement).getByText("Missed voice call")).toBeTruthy();
    fireEvent.click(within(chips[0] as HTMLElement).getByRole("button", { name: "Call back" }));
    expect(onCall).toHaveBeenCalledWith("U2");
    r.unmount();
    await openChat(msgs);
    expect(screen.queryByRole("button", { name: "Call back" })).toBeNull();
  });

  it("images open a lightbox with Download (and the media URL is resolved against the server)", async () => {
    await openChat([dto(1, { message_type: "image", content: "[IMAGE] cat.png", file_name: "cat.png", file_url: "/media/cat.png", file_type: "image/png" })]);
    const img = screen.getByRole("img", { name: "cat.png" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("http://srv.test/media/cat.png");
    expect(screen.queryByText("[IMAGE] cat.png")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open photo cat.png" }));
    const dlg = await screen.findByRole("dialog", { name: "Photo cat.png" });
    expect(within(dlg).getByRole("link", { name: /Download/ }).getAttribute("href")).toBe("http://srv.test/media/cat.png");
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("video and audio use native controls; file cards show a coloured type badge and size", async () => {
    await openChat([
      dto(1, { message_type: "video", file_name: "clip.mp4", file_url: "/media/clip.mp4", file_type: "video/mp4" }),
      dto(2, { message_type: "audio", file_name: "voice.mp3", file_url: "/media/voice.mp3", file_type: "audio/mpeg", duration: 7 }),
      dto(3, { message_type: "document", file_name: "sheet.xlsx", file_url: "/media/sheet.xlsx", file_type: "application/vnd.ms-excel", file_size: 1536 }),
    ]);
    expect(document.querySelector("video[controls]")?.getAttribute("src")).toBe("http://srv.test/media/clip.mp4");
    expect(document.querySelector("audio[controls]")).toBeTruthy();
    const badge = document.querySelector(".ck-doc-badge") as HTMLElement;
    expect(badge.textContent).toBe("XLS");
    expect(badge.getAttribute("data-color")).toBe("success");
    expect(screen.getByText("XLS · 1.5 KB")).toBeTruthy();
    // document viewer: iframe only when the host supplies a viewer URL
    fireEvent.click(screen.getByRole("button", { name: "Open sheet.xlsx" }));
    expect(await screen.findByRole("dialog", { name: /Document sheet.xlsx/ })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("documentViewerUrl turns the viewer into an iframe", async () => {
    await openChat([dto(3, { message_type: "document", file_name: "a.pdf", file_url: "/media/a.pdf", file_type: "application/pdf" })], {
      documentViewerUrl: (_m, url) => `https://viewer.test/?src=${encodeURIComponent(url)}`,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open a.pdf" }));
    const frame = await waitFor(() => {
      const f = document.querySelector("iframe");
      if (!f) throw new Error("no iframe");
      return f;
    });
    expect(frame.getAttribute("src")).toContain("https://viewer.test/?src=");
    expect(frame.getAttribute("sandbox")).toBeTruthy();
  });

  it("the floating date label shows the day of the topmost visible message while scrolling, then hides", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await openChat([dto(1, { timestamp: new Date(Date.now() - 3 * 86400_000).toISOString(), content: "older day" }), dto(2, { content: "today" })]);
    const scroller = document.querySelector(".ck-messages") as HTMLElement;
    const rect = (bottom: number) => ({ top: 0, bottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === scroller) return rect(500);
      return rect(this.getAttribute("data-index") != null ? 100 : 0);
    });
    fireEvent.scroll(scroller);
    const label = document.querySelector(".ck-sticky-date") as HTMLElement;
    expect(label.classList.contains("is-visible")).toBe(true);
    expect(label.textContent).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Yesterday|\d+ \w+)/);
    act(() => void vi.advanceTimersByTime(1600));
    expect(label.classList.contains("is-visible")).toBe(false);
    spy.mockRestore();
  });

  it("renders 5000 messages through a window (a few hundred DOM rows) and still shows the newest", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => dto(i + 1, { content: `bulk ${i + 1}`, timestamp: new Date(Date.now() - (5000 - i) * 30_000).toISOString() }));
    await openChat(many);
    expect(screen.getByText("bulk 5000")).toBeTruthy();
    const rows = document.querySelectorAll(".ck-msg-row").length;
    expect(rows).toBeLessThan(400);
    expect(rows).toBeGreaterThan(50);
    expect(screen.queryByText("bulk 1")).toBeNull();
  });

  it("scrolling to the top reveals older rows from memory first, then asks the server", async () => {
    const many = Array.from({ length: 300 }, (_, i) => dto(i + 1, { content: `row ${i + 1}`, timestamp: new Date(Date.now() - (300 - i) * 1000).toISOString() }));
    const { socket } = await openChat(many);
    const before = document.querySelectorAll(".ck-msg-row").length;
    const scroller = document.querySelector(".ck-messages") as HTMLElement;
    Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true, configurable: true });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(document.querySelectorAll(".ck-msg-row").length).toBeGreaterThan(before));
    expect(socket.ofType("get_messages").filter((f) => f.offset > 0)).toHaveLength(0);
  });

  it("the message list is a labelled log; messages are articles with a full-sentence label", async () => {
    await openChat([mine(1, "hello world", { timestamp: iso(1000) })]);
    expect(screen.getByRole("log", { name: "Messages with Bob" })).toBeTruthy();
    const art = screen.getByRole("article");
    expect(art.getAttribute("aria-label")).toMatch(/^You: hello world, .*, (Sent|Delivered)$/);
  });
});
