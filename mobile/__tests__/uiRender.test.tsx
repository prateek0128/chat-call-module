/**
 * Render smoke tests for the UI kit against the react-native stand-in in __tests__/rn-mock
 * (react-native is not installed in this package). They check that components render,
 * wire props, and follow provider state — not native layout or animation.
 */
import { act, type ReactElement } from "react";
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CommsProvider } from "../src/core/CommsProvider";
import type { CommsClient } from "../src/core/CommsClient";
import { useComms } from "../src/core/CommsProvider";
import { ChatProvider } from "../src/chat/ChatProvider";
import { CallProvider } from "../src/call/CallProvider";
import { useCall } from "../src/call/hooks";
import type { ChatMessage, Conversation } from "../src/chat/types";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import {
  ChatScreen,
  Composer,
  ConversationList,
  ConversationListScreen,
  MessageList,
} from "../src/chat-ui";
import { CallOverlay, CallScreen, mapLiveCall } from "../src/call-ui";
import { IDLE_CALL } from "../src/call/VoiceCallEngine";

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

// Unmount everything so timers (list clock, call timer) don't keep Jest alive.
afterEach(() => {
  act(() => mounted.splice(0).forEach((r) => r.unmount()));
});

// react-test-renderer 19 logs a deprecation notice on every create(); keep the output readable.
const realError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
    realError(...args);
  };
});
afterAll(() => {
  console.error = realError;
});

/** All text in the tree, flattened. */
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

/** Host element of the react-native stand-in (rendered with the RN component name). */
const isHost = (n: ReactTestInstance, name: string) => (n.type as unknown) === name;
const byLabel = (r: ReactTestRenderer, label: string): ReactTestInstance =>
  r.root.find((n) => typeof n.type === "string" && n.props.accessibilityLabel === label);
const hasLabel = (r: ReactTestRenderer, label: string | RegExp) =>
  r.root.findAll((n) => typeof n.type === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel || ""))).length > 0;

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 1,
  chat_id: 1,
  sender_id: "bob",
  sender_type: "other",
  content: "hello",
  message_type: "text",
  timestamp: new Date().toISOString(),
  is_read: false,
  is_delivered: true,
  isMine: false,
  ...over,
});

describe("chat-ui render smoke", () => {
  it("ConversationList: skeletons, rows, 99+ badge, typing, empty search", () => {
    const conversations: Conversation[] = [
      { user_id: "1", username: "Asha", unread_count: 120, last_message: message({ content: "see you" }), chat_id: 1, status: "online" },
      { user_id: "2", username: "Bob", unread_count: 0, last_message: message({ content: "ok", isMine: true, sender_type: "user" }), chat_id: 2 },
    ];
    const loading = render(<ConversationList conversations={[]} loaded={false} onOpenConversation={() => {}} />);
    expect(hasLabel(loading, "Loading chats")).toBe(true);

    const opened: string[] = [];
    const r = render(<ConversationList conversations={conversations} loaded onOpenConversation={(id) => opened.push(id)} typing={{ "2": true }} />);
    const text = textOf(r);
    expect(text).toContain("Asha");
    expect(text).toContain("99+");
    expect(text).toContain("see you");
    expect(text).toContain("typing…");
    act(() => byLabel(r, "Asha, online, 99+ unread messages, see you, " + text.match(/\d{1,2}:\d{2} [AP]M/)![0]).props.onPress());
    expect(opened).toEqual(["1"]);

    const search = r.root.find((n) => isHost(n, "TextInput"));
    act(() => search.props.onChangeText("zzz"));
    expect(textOf(r)).toContain("No chats match");
  });

  it("MessageList: date chip, bubbles, empty state", () => {
    const r = render(<MessageList messages={[message({ id: 2, content: "second", isMine: true, sender_type: "user" }), message({ id: 1, content: "first" })]} />);
    const text = textOf(r);
    expect(text).toContain("Today");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(r.root.find((n) => isHost(n, "FlatList")).props.inverted).toBe(true);
    expect(textOf(render(<MessageList messages={[]} />))).toContain("Say hi 👋");
  });

  it("Composer: sends trimmed text, keeps the draft when send fails, disabled reason", () => {
    const sent: string[] = [];
    let accept = true;
    const r = render(<Composer onSend={(t) => (sent.push(t), accept)} onAttach={() => {}} />);
    const input = () => r.root.find((n) => isHost(n, "TextInput"));
    act(() => input().props.onChangeText("  hello  "));
    act(() => byLabel(r, "Send message").props.onPress());
    expect(sent).toEqual(["hello"]);
    expect(input().props.value).toBe("");
    accept = false;
    act(() => input().props.onChangeText("draft"));
    act(() => byLabel(r, "Send message").props.onPress());
    expect(input().props.value).toBe("draft");
    expect(hasLabel(r, "Attach file")).toBe(true);
    expect(textOf(render(<Composer onSend={() => true} disabledReason="Chat is not enabled" />))).toContain("Chat is not enabled");
  });

  it("ConversationListScreen + ChatScreen wired to the chat hooks", () => {
    let client!: CommsClient;
    const Grab = () => {
      client = useComms().client;
      return null;
    };
    const calls: string[] = [];
    const r = render(
      <CommsProvider config={config} autoConnect={false}>
        <ChatProvider>
          <Grab />
          <ConversationListScreen onOpenConversation={() => {}} />
          <ChatScreen peerId="1" onBack={() => {}} onCall={(id) => calls.push(id)} />
        </ChatProvider>
      </CommsProvider>,
    );
    expect(hasLabel(r, "Loading chats")).toBe(true);
    expect(hasLabel(r, "Loading messages")).toBe(true);
    act(() =>
      client.dispatchLocal({
        type: "res_users",
        users: [{ user_id: "1", username: "Asha", status: "online", unread_count: 2, chat_id: 7, last_message: null }],
      }),
    );
    act(() =>
      client.dispatchLocal({
        type: "res_messages",
        messages: [{ id: 5, chat_id: 7, sender_id: "1", sender_type: "other", content: "hi there", message_type: "text", timestamp: new Date().toISOString() }],
        has_more: false,
        info: { user_id: "1", username: "Asha", status: "online" },
      }),
    );
    const text = textOf(r);
    expect(text).toContain("Asha");
    expect(text).toContain("hi there");
    expect(text).toContain("online");
    act(() => byLabel(r, "Call Asha").props.onPress());
    expect(calls).toEqual(["1"]);
    expect(hasLabel(r, "Back")).toBe(true);
  });
});

describe("call-ui render smoke", () => {
  it("CallScreen renders each live phase", () => {
    const outgoing = mapLiveCall({
      call: { ...IDLE_CALL, isActive: true, status: "ringing", direction: "outgoing", peerName: "Bob", peerId: "bob" },
      accepted: false,
      ringingReceived: true,
      speakerAvailable: true,
    })!;
    const r = render(<CallScreen model={outgoing} onHangup={() => {}} onToggleMute={() => {}} onToggleSpeaker={() => {}} onMinimise={() => {}} />);
    expect(textOf(r)).toContain("Ringing…");
    expect(hasLabel(r, "Hang up")).toBe(true);
    expect(hasLabel(r, "Mute microphone")).toBe(true);
    expect(hasLabel(r, "Minimise call")).toBe(true);
  });

  it("CallOverlay: incoming -> decline closes; startCall failure shows the reason", async () => {
    let client!: CommsClient;
    let call!: ReturnType<typeof useCall>;
    const Grab = () => {
      client = useComms().client;
      call = useCall();
      return null;
    };
    RN.AccessibilityInfo.__announcements.length = 0;
    const r = render(
      <CommsProvider config={config} autoConnect={false}>
        <CallProvider webrtc={() => null}>
          <Grab />
          <CallOverlay onOpenChat={() => {}} />
        </CallProvider>
      </CommsProvider>,
    );
    expect(r.toJSON()).toBeNull();

    await act(async () => {
      client.dispatchLocal({ type: "incoming_call", call_id: "c1", caller_id: "bob", receiver_id: "me", caller_name: "Bob" });
    });
    expect(textOf(r)).toContain("Incoming voice call");
    expect(textOf(r)).toContain("Bob");
    expect(hasLabel(r, "Accept call")).toBe(true);
    expect(RN.AccessibilityInfo.__announcements).toContain("Incoming voice call from Bob");

    await act(async () => byLabel(r, "Decline call").props.onPress());
    expect(r.toJSON()).toBeNull();

    await act(async () => {
      await call.startCall("bob", { peerName: "Bob" });
    });
    expect(textOf(r)).toContain("Calling isn't available on this device");
    expect(hasLabel(r, "Close")).toBe(true);
    expect(hasLabel(r, /Message/)).toBe(true);
    await act(async () => byLabel(r, "Close").props.onPress());
    expect(r.toJSON()).toBeNull();
  });
});
