import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { AppearanceProvider, ChatProvider, CommsWebProvider, ModerationProvider, type AppearanceProviderProps, type ChatError } from "../src";

/** A WebSocket you drive by hand. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.({}));
  }
  receive(msg: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
  drop(code = 1006) {
    this.readyState = 3;
    act(() => this.onclose?.({ code, reason: "" }));
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
  static reset() {
    FakeWebSocket.instances = [];
  }
}

export interface HarnessOptions {
  appearance?: AppearanceProviderProps;
  onError?: (e: ChatError) => void;
  moderation?: boolean;
  readFileAsBase64?: (uri: string) => Promise<string>;
  /** don't open the socket automatically */
  manualOpen?: boolean;
}

export const ME = "U1";

/** Renders `ui` inside the full provider stack with a fake socket; resolves once the socket is open. */
export const renderChat = async (ui: ReactNode, opts: HarnessOptions = {}) => {
  FakeWebSocket.reset();
  const config = { baseUrl: "http://srv.test", getToken: () => "tok", getUserId: () => ME };
  const inner = <ChatProvider onError={opts.onError} readFileAsBase64={opts.readFileAsBase64}>{ui}</ChatProvider>;
  const result = render(
    <AppearanceProvider storage={null} {...opts.appearance}>
      <CommsWebProvider config={config} createWebSocket={(url) => new FakeWebSocket(url) as any}>
        {opts.moderation === false ? inner : <ModerationProvider>{inner}</ModerationProvider>}
      </CommsWebProvider>
    </AppearanceProvider>,
  );
  // connect() awaits getToken(): flush microtasks (no timers, so this also works under fake timers)
  for (let i = 0; i < 50 && !FakeWebSocket.instances.length; i++) await act(async () => void (await Promise.resolve()));
  if (!FakeWebSocket.instances.length) throw new Error("socket was never created");
  const socket = FakeWebSocket.last;
  if (!opts.manualOpen) socket.open();
  return { ...result, socket };
};

export const user = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  user_id: id,
  username: name,
  avatar: null,
  status: "offline",
  updated_at: "2026-01-01T10:00:00",
  unread_count: 0,
  last_message: null,
  chat_id: Number(id.replace(/\D/g, "")) || 1,
  is_blocked: false,
  blocked_by_other: false,
  ...extra,
});

export const dto = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  chat_id: 2,
  sender_id: "U2",
  sender_type: "other",
  content: `message ${id}`,
  message_type: "text",
  timestamp: new Date(Date.now() - (1000 - id) * 1000).toISOString(),
  file_url: null,
  file_name: null,
  file_size: null,
  file_type: null,
  is_read: false,
  is_delivered: true,
  reply_to: null,
  ...over,
});

/** `res_messages` (newest first) for the opened conversation. */
export const resMessages = (messages: any[], over: Record<string, unknown> = {}) => ({
  type: "res_messages",
  messages: messages.slice().reverse(),
  offset: 0,
  has_more: false,
  info: { user_id: "U2", username: "Bob", avatar: null, status: "online", last_seen: null, is_blocked: false, blocked_by_other: false },
  ...over,
});
