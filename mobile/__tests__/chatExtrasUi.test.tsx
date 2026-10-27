/**
 * Render smoke tests (react-native stand-in) for the chat extras: filter chips, blocked rows and
 * header, attach menu, deleted / system / failed / sending bubbles, gate slot, clear chat, image
 * viewer buttons, side-aware call entry.
 */
import { act, type ReactElement } from "react";
import { Text } from "react-native";
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CommsProvider } from "../src/core/CommsProvider";
import { ChatProvider } from "../src/chat/ChatProvider";
import { ChatStore } from "../src/chat/ChatStore";
import type { ChatMessage, Conversation } from "../src/chat/types";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { AttachMenu, CallEntry, ChatHeader, ChatScreen, ConversationList, ConversationRow, ImageViewer, MessageBubble } from "../src/chat-ui";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const RN = require("react-native");

const config = { baseUrl: "https://api.example.com", getToken: () => null, getUserId: () => "me" };

const mounted: ReactTestRenderer[] = [];
const render = (el: ReactElement): ReactTestRenderer => {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<ThemeProvider colorScheme="light">{el}</ThemeProvider>);
  });
  mounted.push(r);
  return r;
};
afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));
const realError = console.error;
const realReduceMotion = RN.AccessibilityInfo.isReduceMotionEnabled;
beforeAll(() => {
  RN.AccessibilityInfo.isReduceMotionEnabled = () => ({ then: (cb: (v: boolean) => void) => (cb(false), { catch: () => undefined }) });
  console.error = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
    realError(...args);
  };
});
afterAll(() => {
  RN.AccessibilityInfo.isReduceMotionEnabled = realReduceMotion;
  console.error = realError;
});

const textOf = (r: ReactTestRenderer): string => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n == null) return;
    if (typeof n === "string") return void out.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    (n.children || []).forEach(walk);
  };
  walk(r.toJSON());
  return out.join(" ");
};
const matches = (n: ReactTestInstance, label: string | RegExp) =>
  typeof n.type === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel || ""));
const byLabel = (r: ReactTestRenderer, label: string | RegExp): ReactTestInstance => r.root.findAll((n) => matches(n, label))[0];
const hasLabel = (r: ReactTestRenderer, label: string | RegExp) => r.root.findAll((n) => matches(n, label)).length > 0;

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 1,
  chat_id: 7,
  sender_id: "1",
  sender_type: "other",
  content: "hello",
  message_type: "text",
  timestamp: new Date().toISOString(),
  is_read: false,
  is_delivered: true,
  isMine: false,
  ...over,
});

const conv = (over: Partial<Conversation>): Conversation => ({
  user_id: "1",
  username: "Asha",
  unread_count: 0,
  last_message: null,
  chat_id: 1,
  ...over,
});

describe("conversation list filter chips", () => {
  it("All / Unread N; Unread filters rows; filter-aware empty state", () => {
    const list = [conv({ user_id: "1", username: "Asha", unread_count: 2 }), conv({ user_id: "2", username: "Bina" })];
    const r = render(<ConversationList conversations={list} loaded onOpenConversation={() => {}} />);
    expect(hasLabel(r, "All")).toBe(true);
    expect(textOf(r)).toContain("Unread 1");
    act(() => byLabel(r, /^Unread, 1 chat/).props.onPress());
    expect(textOf(r)).toContain("Asha");
    expect(textOf(r)).not.toContain("Bina");

    const r2 = render(<ConversationList conversations={[conv({ unread_count: 0 })]} loaded onOpenConversation={() => {}} initialFilter="unread" />);
    expect(textOf(r2)).toContain("No unread chats");
    expect(textOf(r2)).toContain("You're all caught up");

    const r3 = render(
      <ConversationList
        conversations={list}
        loaded
        onOpenConversation={() => {}}
        filters={[{ key: "b", label: "Starts with B", predicate: (c) => (c.username || "").startsWith("B") }]}
      />,
    );
    act(() => byLabel(r3, "Starts with B").props.onPress());
    expect(textOf(r3)).toContain("Bina");
    expect(textOf(r3)).not.toContain("Asha");
    expect(hasLabel(render(<ConversationList conversations={list} loaded onOpenConversation={() => {}} showFilters={false} />), "All")).toBe(false);
  });
});

describe("blocked state", () => {
  it("rows show the blocked label instead of the preview and hide the online dot", () => {
    const last = message({ content: "secret preview" });
    const r = render(<ConversationRow conversation={conv({ is_blocked: true, status: "online", last_message: last })} onPress={() => {}} />);
    expect(textOf(r)).toContain("You blocked this contact");
    expect(textOf(r)).not.toContain("secret preview");
    const row = r.root.find((n) => typeof n.type === "string" && n.props.accessibilityHint === "Opens the conversation");
    expect(row.props.accessibilityLabel).not.toMatch(/online/);
    const r2 = render(<ConversationRow conversation={conv({ blocked_by_other: true })} onPress={() => {}} />);
    expect(textOf(r2)).toContain("Blocked by Asha");
  });

  it("header: status text, no call action when blocked; last seen otherwise", () => {
    const r = render(<ChatHeader peerId="1" name="Asha" status="online" onCall={() => {}} blockedByOther />);
    expect(textOf(r)).toContain("You are blocked");
    expect(hasLabel(r, "Call Asha")).toBe(false);
    const r2 = render(<ChatHeader peerId="1" name="Asha" status="offline" onCall={() => {}} lastSeen={new Date(Date.now() - 5 * 60000).toISOString()} />);
    expect(textOf(r2)).toContain("last seen 5 min ago");
    expect(hasLabel(r2, "Call Asha")).toBe(true);
  });
});

describe("attach menu", () => {
  it("one tile per picker; a picked file is handed over", async () => {
    const picked: string[] = [];
    let closed = 0;
    const pickers = [
      { key: "gallery", label: "Photo", icon: "image" as const, pick: async () => null },
      { key: "document", label: "Document", pick: async () => ({ uri: "file:///r.pdf", name: "r.pdf", type: "application/pdf", size: 3 }) },
    ];
    const r = render(<AttachMenu visible pickers={pickers} onPicked={(f) => picked.push(f.name)} onClose={() => closed++} />);
    expect(hasLabel(r, "Photo")).toBe(true);
    await act(async () => {
      byLabel(r, "Document").props.onPress();
    });
    expect(closed).toBe(1);
    expect(picked).toEqual(["r.pdf"]);
    expect(render(<AttachMenu visible={false} pickers={pickers} onPicked={() => {}} onClose={() => {}} />).toJSON()).toBeNull();
  });
});

describe("bubbles", () => {
  it("deleted placeholder, system chip", () => {
    const r = render(<MessageBubble message={message({ message_type: "deleted", content: "" })} />);
    expect(textOf(r)).toContain("This message was deleted");
    const r2 = render(<MessageBubble message={message({ message_type: "system", sender_type: "system", content: "You matched with Asha" })} />);
    expect(hasLabel(r2, "You matched with Asha")).toBe(true);
  });

  it("sending overlay on media; failed shows retry", () => {
    const r = render(<MessageBubble message={message({ id: "temp_1", isMine: true, pending: true, message_type: "image", file_url: "file:///a.jpg" })} />);
    expect(hasLabel(r, "Sending")).toBe(true);
    expect(textOf(r)).toContain("Sending…");
    const retried: unknown[] = [];
    const r2 = render(<MessageBubble message={message({ id: "temp_2", isMine: true, failed: true, content: "spam" })} onRetry={(m) => retried.push(m.id)} />);
    act(() => byLabel(r2, "Not sent. Tap to retry").props.onPress());
    expect(retried).toEqual(["temp_2"]);
  });

  it("document badge on file cards", () => {
    const r = render(<MessageBubble message={message({ message_type: "document", file_name: "cv.pdf", file_size: 1.2 * 1024 * 1024, content: "cv.pdf" })} />);
    expect(textOf(r)).toContain("PDF · 1.2 MB");
  });

  it("call entry: callee taps the missed call to call back", () => {
    const calls: unknown[] = [];
    const r = render(<CallEntry message={message({ message_type: "call", content: "Missed voice call" })} onCallBack={(m) => calls.push(m.id)} />);
    act(() => byLabel(r, /^Missed voice call, Tap to call back/).props.onPress());
    expect(calls).toEqual([1]);
    const r2 = render(<CallEntry message={message({ message_type: "call", content: "Missed voice call", isMine: true })} />);
    expect(textOf(r2)).toContain("No answer");
  });
});

describe("image viewer", () => {
  it("Save + Share buttons when wired", () => {
    const done: string[] = [];
    const r = render(<ImageViewer uri="https://x/a.jpg" onClose={() => {}} onDownload={() => done.push("save")} onShare={() => done.push("share")} />);
    act(() => byLabel(r, "Save photo").props.onPress());
    act(() => byLabel(r, "Share photo").props.onPress());
    expect(done).toEqual(["save", "share"]);
    expect(hasLabel(render(<ImageViewer uri="https://x/a.jpg" onClose={() => {}} />), "Share photo")).toBe(false);
  });
});

describe("ChatScreen extras", () => {
  const makeStore = () => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const store = new ChatStore({ send: (t, p) => (sent.push([t, p]), true), canSend: () => true, getUserId: () => "me" });
    return { store, sent };
  };
  const screen = (store: ChatStore, extra: object = {}) => (
    <CommsProvider config={config} autoConnect={false}>
      <ChatProvider store={store}>
        <ChatScreen peerId="1" {...extra} />
      </ChatProvider>
    </CommsProvider>
  );

  it("gate slot covers the chat until it returns null", () => {
    const { store } = makeStore();
    let consent = false;
    const gate = () => (consent ? null : <Text>Accept to chat</Text>);
    const r = render(screen(store, { gate }));
    expect(textOf(r)).toContain("Accept to chat");
    consent = true;
    act(() => store.handle({ type: "res_messages", messages: [], has_more: false, info: { user_id: "1", username: "Asha" } } as any));
    expect(textOf(r)).not.toContain("Accept to chat");
  });

  it("composerDisabledReason disables the composer", () => {
    const { store } = makeStore();
    const r = render(screen(store, { composerDisabledReason: "Waiting for consent" }));
    expect(textOf(r)).toContain("Waiting for consent");
  });

  it("Clear chat (header menu) asks first, then sends clear_chat", () => {
    const { store, sent } = makeStore();
    const r = render(screen(store));
    act(() => byLabel(r, "More options").props.onPress());
    act(() => byLabel(r, "Clear chat").props.onPress());
    expect(textOf(r)).toContain("Clear this chat?");
    expect(sent.some(([t]) => t === "clear_chat")).toBe(false);
    const confirm = r.root.findAll((n) => matches(n, "Clear chat")).pop()!;
    act(() => confirm.props.onPress());
    expect(sent.find(([t]) => t === "clear_chat")?.[1]).toMatchObject({ candidate_user_id: "1" });
  });

  it("long-press own message offers Delete for everyone; rate limit shows a toast", () => {
    const { store, sent } = makeStore();
    const r = render(screen(store));
    act(() =>
      store.handle({
        type: "res_messages",
        messages: [{ id: 9, chat_id: 7, sender_id: "me", sender_type: "user", content: "mine", message_type: "text", timestamp: new Date().toISOString() }],
        has_more: false,
        info: { user_id: "1", username: "Asha" },
      } as any),
    );
    const bubble = r.root.find((n) => typeof n.type === "string" && typeof n.props.onLongPress === "function" && /mine/.test(n.props.accessibilityLabel || ""));
    act(() => bubble.props.onLongPress());
    expect(hasLabel(r, "Delete for me")).toBe(true);
    act(() => byLabel(r, "Delete for everyone").props.onPress());
    expect(sent.find(([t]) => t === "delete_message")?.[1]).toEqual({ message_id: 9, for_everyone: true });

    act(() => store.handle({ type: "error", error: "Slow down", code: "rate_limited", retry_after: 5 } as any));
    expect(textOf(r)).toContain("You're sending messages too fast. Try again in 5 s");
  });

  it("pickers prop: attach button opens the AttachMenu", () => {
    const { store } = makeStore();
    const r = render(screen(store, { pickers: [{ key: "document", label: "Document", pick: async () => null }] }));
    act(() => byLabel(r, /^Attach/).props.onPress());
    expect(hasLabel(r, "Document")).toBe(true);
  });
});
