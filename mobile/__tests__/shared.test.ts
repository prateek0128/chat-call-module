import { startChat, registerPushToken, removePushToken } from "../src/chat/api";
import { turnCredentialsIceServers, PUBLIC_STUN, resolveIceServers } from "../src/call/iceServers";
import { callLogText, formatCallDuration, friendlyDuration, parseCallEntry } from "../src/core/callLog";
import { CommsHttpError } from "../src/core/config";
import { UserDirectory } from "../src/core/userDirectory";

describe("callLog", () => {
  it("formats like the backend", () => {
    expect(formatCallDuration(65)).toBe("01:05");
    expect(formatCallDuration(3725)).toBe("1:02:05");
    expect(callLogText("connected", 342)).toBe("Voice call · 05:42");
    expect(callLogText("connected", 3725, "video")).toBe("Video call · 1:02:05");
    expect(callLogText("missed", null)).toBe("Missed voice call");
    expect(callLogText("declined", null)).toBe("Declined voice call");
    expect(callLogText("cancelled", null)).toBe("Cancelled voice call");
    expect(friendlyDuration(342)).toBe("5 min 42 sec");
  });
  it("parses call entries", () => {
    expect(parseCallEntry("Voice call · 05:42")).toEqual({ outcome: "connected", seconds: 342, callType: "audio" });
    expect(parseCallEntry("Video call · 1:02:05")).toEqual({ outcome: "connected", seconds: 3725, callType: "video" });
    expect(parseCallEntry("Missed voice call").outcome).toBe("missed");
    expect(parseCallEntry("Declined voice call").outcome).toBe("declined");
    expect(parseCallEntry("Cancelled voice call").outcome).toBe("cancelled");
    expect(parseCallEntry("[Call Initiated]").outcome).toBe("unknown");
  });
});

describe("UserDirectory", () => {
  it("ignores names that are just the id, notifies on change", () => {
    const d = new UserDirectory();
    const l = jest.fn();
    d.subscribe(l);
    d.remember([{ user_id: "U2", username: "U2" }]);
    expect(d.getName("U2")).toBeUndefined();
    d.remember([{ user_id: "U2", username: "Asha", avatar: "https://a" }]);
    d.remember([{ user_id: "U2", username: "Asha", avatar: "https://a" }]);
    expect(d.getName("U2")).toBe("Asha");
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("REST helpers (fetch + getToken)", () => {
  const realFetch = (globalThis as any).fetch;
  let calls: any[];
  const respond = (status: number, body: unknown) => {
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
    });
  };
  const cfg = { baseUrl: "https://api.example.com/", getToken: async () => "TOK" };
  beforeEach(() => {
    calls = [];
  });
  afterAll(() => {
    (globalThis as any).fetch = realFetch;
  });

  it("startChat POSTs /chats/start?candidate_id= with Bearer", async () => {
    respond(200, { chat_id: 7, user1_id: "U1", user2_id: "U2" });
    await expect(startChat(cfg, "U2")).resolves.toMatchObject({ chat_id: 7 });
    expect(calls[0].url).toBe("https://api.example.com/chats/start?candidate_id=U2");
    expect(calls[0].init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer TOK" } });
  });

  it("push token register / remove send JSON", async () => {
    respond(200, { ok: true });
    await registerPushToken(cfg, { token: "ExponentPushToken[x]" });
    await removePushToken(cfg, { token: "ExponentPushToken[x]" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.com/chats/expo/push/token",
      "https://api.example.com/chats/expo/push/token/remove",
    ]);
    expect(JSON.parse(calls[0].init.body)).toEqual({ token: "ExponentPushToken[x]" });
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
  });

  it("non-2xx throws CommsHttpError with detail", async () => {
    respond(403, { detail: "Not allowed" });
    await expect(startChat(cfg, "U2")).rejects.toBeInstanceOf(CommsHttpError);
    await expect(startChat(cfg, "U2")).rejects.toMatchObject({ status: 403, message: "Not allowed" });
  });

  it("TURN credentials -> ICE servers, cached until ttl, STUN fallback on failure", async () => {
    respond(200, { username: "123:u", password: "pw", ttl: 3600, uris: ["turn:t:3478?transport=udp", "turn:t:3478?transport=tcp"] });
    const provider = turnCredentialsIceServers(cfg);
    const servers = await provider();
    expect(servers).toEqual([...PUBLIC_STUN, { urls: ["turn:t:3478?transport=udp", "turn:t:3478?transport=tcp"], username: "123:u", credential: "pw" }]);
    await provider();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/call/turn-credentials");
    respond(500, {});
    expect(await turnCredentialsIceServers(cfg)()).toEqual(PUBLIC_STUN);
    expect(await resolveIceServers([{ urls: "stun:x" }])).toEqual([{ urls: "stun:x" }]);
  });
});
