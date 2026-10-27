/**
 * Render smoke tests (react-native stand-in) for the rich chat features: reply bar, long-press
 * actions sheet, quote jump, video bubble, in-app message banner.
 */
import { act, type ReactElement } from "react";
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CommsProvider } from "../src/core/CommsProvider";
import { ChatProvider } from "../src/chat/ChatProvider";
import { ChatStore } from "../src/chat/ChatStore";
import type { ChatMessage } from "../src/chat/types";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { ChatScreen, Composer, InAppMessageBanner, MessageActionsSheet, MessageBubble, MessageList, setOptionalPeer } from "../src/chat-ui";

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
afterEach(() => {
  act(() => mounted.splice(0).forEach((r) => r.unmount()));
  setOptionalPeer("expo-clipboard", undefined);
});
const realError = console.error;
const realReduceMotion = RN.AccessibilityInfo.isReduceMotionEnabled;
beforeAll(() => {
  // Resolve synchronously so useReducedMotion's update lands inside act().
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
const byLabel = (r: ReactTestRenderer, label: string | RegExp): ReactTestInstance =>
  r.root.find((n) => typeof n.type === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel || "")));
const hasLabel = (r: ReactTestRenderer, label: string | RegExp) =>
  r.root.findAll((n) => typeof n.type === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel || ""))).length > 0;

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

const makeStore = () => {
  const sent: Array<[string, Record<string, unknown>]> = [];
  const store = new ChatStore({ send: (t, p) => (sent.push([t, p]), true), canSend: () => true, getUserId: () => "me" });
  return { store, sent };
};

const dto = (over: Record<string, unknown>) => ({
  id: 5,
  chat_id: 7,
  sender_id: "1",
  sender_type: "other",
  content: "hi there",
  message_type: "text",
  timestamp: new Date().toISOString(),
  ...over,
});

const newMessage = (over: Record<string, unknown>): any => ({ type: "new_message", message: dto(over) });

describe("reply UI", () => {
  it("Composer shows the reply bar; ✕ cancels", () => {
    let cancelled = 0;
    const r = render(<Composer onSend={() => true} replyTo={{ senderName: "Asha", snippet: "see you" }} onCancelReply={() => cancelled++} />);
    expect(textOf(r)).toContain("Asha");
    expect(textOf(r)).toContain("see you");
    expect(hasLabel(r, "Replying to Asha: see you")).toBe(true);
    act(() => byLabel(r, "Cancel reply").props.onPress());
    expect(cancelled).toBe(1);
    expect(hasLabel(render(<Composer onSend={() => true} />), /Replying to/)).toBe(false);
  });

  it("ChatScreen: long-press -> sheet -> Reply -> bar -> send passes reply_to_id, then clears", () => {
    const { store, sent } = makeStore();
    const r = render(
      <CommsProvider config={config} autoConnect={false}>
        <ChatProvider store={store}>
          <ChatScreen peerId="1" />
        </ChatProvider>
      </CommsProvider>,
    );
    act(() => store.handle({ type: "res_messages", messages: [dto({})], has_more: false, info: { user_id: "1", username: "Asha", status: "online" } } as any));
    const bubble = r.root.find((n) => typeof n.type === "string" && typeof n.props.onLongPress === "function" && /hi there/.test(n.props.accessibilityLabel || ""));
    expect(bubble.props.accessibilityActions.map((a: any) => a.name)).toEqual(["reply", "longpress"]);
    act(() => bubble.props.onLongPress());
    expect(hasLabel(r, "Message actions")).toBe(true);
    expect(hasLabel(r, "Reply")).toBe(true);
    expect(hasLabel(r, "Copy text")).toBe(false); // no expo-clipboard
    act(() => byLabel(r, "Reply").props.onPress());
    expect(hasLabel(r, "Message actions")).toBe(false);
    expect(hasLabel(r, "Replying to Asha: hi there")).toBe(true);

    const input = r.root.find((n) => (n.type as unknown) === "TextInput");
    act(() => input.props.onChangeText("answer"));
    act(() => byLabel(r, "Send message").props.onPress());
    const frame = sent.find(([t]) => t === "send_message");
    expect(frame?.[1]).toMatchObject({ content: "answer", reply_to_id: 5 });
    expect(hasLabel(r, /Replying to/)).toBe(false);

    // Cancel path via the screen-reader action
    act(() => bubble.props.onAccessibilityAction({ nativeEvent: { actionName: "reply" } }));
    expect(hasLabel(r, /Replying to/)).toBe(true);
    act(() => byLabel(r, "Cancel reply").props.onPress());
    expect(hasLabel(r, /Replying to/)).toBe(false);
  });

  it("onLongPressMessage overrides the built-in sheet; Copy text appears with expo-clipboard", () => {
    setOptionalPeer("expo-clipboard", { setStringAsync: async () => true });
    const { store } = makeStore();
    const pressed: string[] = [];
    const r = render(
      <CommsProvider config={config} autoConnect={false}>
        <ChatProvider store={store}>
          <ChatScreen peerId="1" onLongPressMessage={(m) => pressed.push(m.content)} />
        </ChatProvider>
      </CommsProvider>,
    );
    act(() => store.handle({ type: "res_messages", messages: [dto({})], has_more: false, info: { user_id: "1", username: "Asha" } } as any));
    const bubble = () => r.root.find((n) => typeof n.type === "string" && typeof n.props.onLongPress === "function" && /hi there/.test(n.props.accessibilityLabel || ""));
    act(() => bubble().props.onLongPress());
    expect(pressed).toEqual(["hi there"]);
    expect(hasLabel(r, "Message actions")).toBe(false);

    const extra = [{ key: "pin", label: "Pin message", onPress: (m: ChatMessage) => pressed.push(`pin:${m.id}`) }];
    const r2 = render(
      <CommsProvider config={config} autoConnect={false}>
        <ChatProvider store={store}>
          <ChatScreen peerId="1" messageActions={extra} />
        </ChatProvider>
      </CommsProvider>,
    );
    const b2 = r2.root.find((n) => typeof n.type === "string" && typeof n.props.onLongPress === "function" && /hi there/.test(n.props.accessibilityLabel || ""));
    act(() => b2.props.onLongPress());
    expect(hasLabel(r2, "Copy text")).toBe(true);
    act(() => byLabel(r2, "Pin message").props.onPress());
    expect(pressed).toContain("pin:5");
  });

  it("tapping a quote scrolls to the loaded original and highlights it; unknown originals announce", () => {
    const original = message({ id: 1, content: "original" });
    const replyMsg = message({ id: 2, content: "answer", isMine: true, sender_type: "user", sender_id: "me", reply_to: { id: 1, sender_id: "1", content: "original" } });
    const missing: unknown[] = [];
    const r = render(<MessageList messages={[replyMsg, original]} peerId="1" peerName="Asha" onQuoteNotLoaded={(id) => missing.push(id)} />);
    const quote = byLabel(r, /^Reply to Asha: original/);
    act(() => quote.props.onPress());
    expect(RN.FlatList.lastScrollIndex).toMatchObject({ viewPosition: 0.5 });
    const rows = r.root.findAll((n) => typeof n.type === "string" && Array.isArray(n.props.style) && n.props.style.some((s: any) => s && typeof s.backgroundColor === "string" && s.backgroundColor.startsWith("rgba")));
    expect(rows.length).toBeGreaterThan(0);

    const r2 = render(<MessageList messages={[replyMsg]} peerId="1" peerName="Asha" onQuoteNotLoaded={(id) => missing.push(id)} />);
    act(() => byLabel(r2, /^Reply to Asha/).props.onPress());
    expect(missing).toEqual([1]);
  });
});

describe("MessageActionsSheet + video bubble", () => {
  it("lists the given actions and Cancel; closed when message is null", () => {
    const picked: string[] = [];
    const m = message({});
    const r = render(
      <MessageActionsSheet
        message={m}
        actions={[{ key: "reply", label: "Reply" }, { key: "report", label: "Report message", destructive: true }]}
        onSelect={(a) => picked.push(String(a.key))}
        onClose={() => picked.push("close")}
      />,
    );
    expect(textOf(r)).toContain("Report message");
    act(() => byLabel(r, "Report message").props.onPress());
    act(() => byLabel(r, "Cancel").props.onPress());
    expect(picked).toEqual(["report", "close"]);
    expect(render(<MessageActionsSheet message={null} actions={[]} onSelect={() => {}} onClose={() => {}} />).toJSON()).toBeNull();
  });

  it("video bubble: neutral tile with play + duration; tap opens", () => {
    const opened: unknown[] = [];
    const r = render(<MessageBubble message={message({ message_type: "video", content: "[Video]", file_url: "https://x/v.mp4", duration: 7 })} onOpenVideo={(m) => opened.push(m.id)} />);
    expect(textOf(r)).toContain("0:07");
    expect(textOf(r)).toContain("▶");
    act(() => byLabel(r, "Video, 0:07. Plays full screen").props.onPress());
    expect(opened).toEqual([1]);
  });
});

describe("InAppMessageBanner", () => {
  it("shows new messages from other chats, dedupes, dismisses, auto-hides, suppressed for the open chat", () => {
    jest.useFakeTimers();
    try {
      const { store } = makeStore();
      const opened: string[] = [];
      const r = render(
        <CommsProvider config={config} autoConnect={false}>
          <ChatProvider store={store}>
            <InAppMessageBanner onOpenChat={(peerId) => opened.push(peerId)} />
          </ChatProvider>
        </CommsProvider>,
      );
      expect(hasLabel(r, /New message from/)).toBe(false);
      act(() => store.handle(newMessage({ id: 10, sender_id: "2", chat_id: 8, content: "ping" })));
      expect(textOf(r)).toContain("ping");
      act(() => byLabel(r, "Dismiss notification").props.onPress());
      expect(hasLabel(r, /New message from/)).toBe(false);

      // same message again (e.g. echoed): deduped
      act(() => store.handle(newMessage({ id: 10, sender_id: "2", chat_id: 8, content: "ping" })));
      expect(hasLabel(r, /New message from/)).toBe(false);

      act(() => store.handle(newMessage({ id: 11, sender_id: "2", chat_id: 8, content: "pong" })));
      expect(textOf(r)).toContain("pong");
      act(() => jest.advanceTimersByTime(4100));
      expect(hasLabel(r, /New message from/)).toBe(false);

      act(() => store.handle(newMessage({ id: 12, sender_id: "2", chat_id: 8, content: "tap me" })));
      act(() => byLabel(r, /New message from .*tap me/).props.onPress());
      expect(opened).toEqual(["2"]);

      // the chat on screen gets no banner
      act(() => store.setActiveChat("3"));
      act(() => store.handle(newMessage({ id: 13, sender_id: "3", chat_id: 9, content: "quiet" })));
      expect(textOf(r)).not.toContain("quiet");
    } finally {
      jest.useRealTimers();
    }
  });
});
