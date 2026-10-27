import type { WebSocketLike } from "../src/core/CommsClient";

export class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closed = false;
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test controls
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  static last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
  static reset() {
    MockWebSocket.instances = [];
  }
}

export class MockAppState {
  currentState: string = "active";
  private listeners = new Set<(s: string) => void>();
  addEventListener(_type: "change", listener: (s: string) => void) {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }
  set(state: string) {
    this.currentState = state;
    this.listeners.forEach((l) => l(state));
  }
}

/** Let pending promise chains run (getToken etc.). */
export const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Records frames sent through a `send(type, payload)` seam. */
export const makeSender = () => {
  const sent: Array<{ type: string } & Record<string, any>> = [];
  let ok = true;
  return {
    sent,
    send: (type: string, payload: Record<string, unknown>) => {
      if (!ok) return false;
      sent.push({ ...payload, type });
      return true;
    },
    setOk(v: boolean) {
      ok = v;
    },
    ofType: (type: string) => sent.filter((m) => m.type === type),
    last: (type?: string) => (type ? sent.filter((m) => m.type === type).pop() : sent[sent.length - 1]),
    clear: () => {
      sent.length = 0;
    },
  };
};
