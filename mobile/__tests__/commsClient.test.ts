import { backoffDelay, CommsClient } from "../src/core/CommsClient";
import { deriveWsUrl, socketUrl } from "../src/core/config";
import { flush, MockAppState, MockWebSocket } from "./helpers";

const make = (opts: Partial<ConstructorParameters<typeof CommsClient>[0]> = {}, token: string | null = "tok") => {
  const appState = new MockAppState();
  const getToken = jest.fn(async () => token);
  const client = new CommsClient({
    config: { baseUrl: "https://api.example.com/", getToken, getUserId: async () => "U1" },
    appState,
    createWebSocket: (url) => new MockWebSocket(url),
    ...opts,
  });
  return { client, appState, getToken };
};

beforeEach(() => {
  MockWebSocket.reset();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe("config", () => {
  it("derives the ws url", () => {
    expect(deriveWsUrl("https://a.b/")).toBe("wss://a.b");
    expect(deriveWsUrl("http://localhost:8000")).toBe("ws://localhost:8000");
    expect(socketUrl({ baseUrl: "https://a.b", getToken: () => "", getUserId: () => "" }, "T")).toBe("wss://a.b/ws/T");
    expect(socketUrl({ baseUrl: "https://a.b", wsUrl: "wss://ws.a.b/", getToken: () => "", getUserId: () => "" }, "T")).toBe(
      "wss://ws.a.b/ws/T",
    );
  });
  it("backoff is min(1000*2^n, 30000)", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("CommsClient", () => {
  it("connects to ${wsUrl}/ws/${token} and resolves the user id", async () => {
    const { client, getToken } = make();
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s.status));
    await client.connect();
    expect(MockWebSocket.last().url).toBe("wss://api.example.com/ws/tok");
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(client.userId).toBe("U1");
    MockWebSocket.last().open();
    expect(client.isOpen).toBe(true);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("dispatches by type, '*' gets everything, PONG becomes pong, bad JSON ignored", async () => {
    const { client } = make();
    await client.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const typed = jest.fn();
    const all = jest.fn();
    const pong = jest.fn();
    const off = client.on("res_users", typed);
    client.on("*", all);
    client.on("pong", pong);
    ws.receive({ type: "res_users", users: [] });
    ws.receive({ type: "PONG", timestamp: "x" });
    ws.receive("{not json");
    ws.receive({ nope: 1 });
    expect(typed).toHaveBeenCalledWith({ type: "res_users", users: [] });
    expect(pong).toHaveBeenCalledWith({ type: "pong", timestamp: "x" });
    expect(all).toHaveBeenCalledTimes(2);
    off();
    ws.receive({ type: "res_users", users: [] });
    expect(typed).toHaveBeenCalledTimes(1);
  });

  it("drops sends while disconnected by default (returns false)", async () => {
    const { client } = make();
    expect(client.send("req_users", {})).toBe(false);
    await client.connect();
    expect(client.send("req_users", {})).toBe(false);
    MockWebSocket.last().open();
    expect(client.send("req_users", {})).toBe(true);
    expect(MockWebSocket.last().sent).toEqual([{ type: "req_users" }]);
  });

  it("queue policy flushes in order on open", async () => {
    const { client } = make({ offlineSendPolicy: "queue" });
    await client.connect();
    expect(client.send("typing", { target_user_id: "U2", is_typing: true })).toBe(true);
    expect(client.send("req_users", {})).toBe(true);
    MockWebSocket.last().open();
    expect(MockWebSocket.last().sent.map((m) => m.type)).toEqual(["typing", "req_users"]);
  });

  it("reconnects with exponential backoff and a fresh token each time", async () => {
    const { client, getToken } = make();
    await client.connect();
    MockWebSocket.last().drop();
    expect(client.status.status).toBe("reconnecting");
    await jest.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.last().drop();
    await jest.advanceTimersByTimeAsync(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(getToken).toHaveBeenCalledTimes(3);
    // A successful open resets the attempt counter.
    MockWebSocket.last().open();
    MockWebSocket.last().drop();
    await jest.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("does not schedule reconnects in the background; reconnects at once on foreground", async () => {
    const { client, appState } = make();
    await client.connect();
    MockWebSocket.last().open();
    appState.set("background");
    MockWebSocket.last().drop();
    await jest.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
    appState.set("active");
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("reports user_status away / online on AppState changes", async () => {
    const { client, appState } = make();
    await client.connect();
    const ws = MockWebSocket.last();
    ws.open();
    appState.set("background");
    appState.set("active");
    expect(ws.sent).toEqual([
      { type: "user_status", status: "away" },
      { type: "user_status", status: "online" },
    ]);
  });

  it("no token -> unauthenticated, no socket, no reconnect", async () => {
    const { client } = make({}, null);
    await client.connect();
    expect(client.status.status).toBe("unauthenticated");
    expect(MockWebSocket.instances).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("disconnect stops for good", async () => {
    const { client } = make();
    await client.connect();
    const ws = MockWebSocket.last();
    ws.open();
    client.disconnect();
    expect(ws.closed).toBe(true);
    expect(client.status.status).toBe("idle");
    await jest.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("dispatchLocal delivers to subscribers without touching the socket", async () => {
    const { client } = make();
    const h = jest.fn();
    client.on("call_log", h);
    client.dispatchLocal({ type: "call_log", call_id: "c1", content: "x", local: true });
    expect(h).toHaveBeenCalledWith({ type: "call_log", call_id: "c1", content: "x", local: true });
  });
});
