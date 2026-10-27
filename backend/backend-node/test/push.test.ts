/** Push senders with fakes (no network): Expo, APNs VoIP (injected HTTP/2 session), DevicePushRouter. */
import { exportPKCS8, generateKeyPair, jwtVerify, decodeProtectedHeader, type KeyLike } from "jose";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeAllFeatureEnvs, makeFeatureEnv } from "./moderation-env.js";
import type { DeviceInfo, DeviceStore, TokenKind } from "../src/core/devices.js";
import {
  type ApnsResponse, type ApnsSession, ApnsVoipSender, DevicePushRouter, ExpoPushSender, type FetchLike, callkitUuid,
} from "../src/core/push.js";

afterEach(closeAllFeatureEnvs);

// ------------------------------------------------------------------ fakes

class FakeStore implements DeviceStore {
  removed: Array<[string, string]> = [];
  constructor(public devices: Record<string, DeviceInfo[]> = {}) {}
  async devicesFor(userId: string) {
    return [...(this.devices[userId] ?? [])];
  }
  async removeToken(token: string, kind: TokenKind = "expo") {
    this.removed.push([token, kind]);
    return 1;
  }
}

const dev = (id: string, platform: string, expo: string | null, voip: string | null = null, user = "B"): DeviceInfo => ({
  user_id: user, device_id: id, platform, expo_push_token: expo, voip_token: voip, app_version: null, os_version: null, model: null,
});

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Fake `fetch`: records requests, answers with `respond(body, url)`. */
function fakeFetch(respond: (body: any, url: string) => { status: number; json: any }): { fetch: FetchLike; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const r = respond(body, url);
    return { status: r.status, text: async () => JSON.stringify(r.json) };
  };
  return { fetch, requests };
}

const expoOk = (batch: any[]) => ({ status: 200, json: { data: batch.map((_, i) => ({ status: "ok", id: `t${i}` })) } });

class FakeApns implements ApnsSession {
  requests: Array<{ path: string; headers: Record<string, string>; body: any }> = [];
  closed = false;
  constructor(public respond: (n: number) => ApnsResponse = () => ({ status: 200, body: "" })) {}
  async request(p: string, headers: Record<string, string>, body: string) {
    this.requests.push({ path: p, headers, body: JSON.parse(body) });
    return this.respond(this.requests.length);
  }
  close() {
    this.closed = true;
  }
}

let privatePem = "";
let publicKey: KeyLike;
beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privatePem = await exportPKCS8(kp.privateKey);
  publicKey = kp.publicKey;
});

const makeApns = (session: FakeApns, extra: Partial<ConstructorParameters<typeof ApnsVoipSender>[0]> = {}) =>
  new ApnsVoipSender({ key: privatePem, keyId: "KEY123ABCD", teamId: "TEAM123456", bundleId: "com.example.app", sessionFactory: () => session, ...extra });

const INCOMING = { type: "incoming_call", call_id: "call-123", chat_id: null, caller_id: "A", caller_name: "Alice", caller_avatar: null, call_type: "audio" };
const CHAT = { type: "chat", cid: "messaging:A", chat_id: 1, sender_id: "A" };

// ------------------------------------------------------------------ callkit

describe("callkitUuid", () => {
  it("matches the shared vectors", () => {
    expect(callkitUuid("call-123")).toBe("e394bb1f-a663-5750-8664-4de655ce4bf3");
    expect(callkitUuid("3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c")).toBe("653579da-f398-55b8-9545-46885f1e073e");
  });
});

// --------------------------------------------------------------------- Expo

describe("ExpoPushSender", () => {
  it("batches of 100 and the access token", async () => {
    const f = fakeFetch(expoOk);
    const sender = new ExpoPushSender({ accessToken: "expo-secret", fetch: f.fetch });
    const messages = Array.from({ length: 250 }, (_, i) => sender.buildMessage(`ExponentPushToken[${i}]`, "t", "b", { i }));
    const tickets = await sender.sendMessages(messages);
    expect(f.requests.map((r) => r.body.length)).toEqual([100, 100, 50]);
    expect(tickets).toHaveLength(250);
    expect(tickets.every((t) => t.status === "ok")).toBe(true);
    expect(f.requests[0]!.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(f.requests[0]!.headers.Authorization).toBe("Bearer expo-secret");
    expect(f.requests[2]!.body.at(-1).to).toBe("ExponentPushToken[249]");

    const f2 = fakeFetch(expoOk);
    await new ExpoPushSender({ fetch: f2.fetch }).sendMessages(messages.slice(0, 1));
    expect(f2.requests[0]!.headers.Authorization).toBeUndefined();
    expect(() => new ExpoPushSender({ batchSize: 101 })).toThrow();
  });

  it("DeviceNotRegistered removes the token; message shape", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      json: { data: [
        { status: "ok", id: "1" },
        { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
        { status: "error", message: "too big", details: { error: "MessageTooBig" } },
      ] },
    }));
    const store = new FakeStore({ U: [0, 1, 2].map((i) => dev(`d${i}`, "android", `ExponentPushToken[${i}]`, null, "U")) });
    const sender = new ExpoPushSender({ registry: store, fetch: f.fetch });
    await sender.send("U", "Title", "Body", { k: 1 }, "messages", 30);
    expect(store.removed).toEqual([["ExponentPushToken[1]", "expo"]]);
    expect(f.requests[0]!.body[0]).toEqual({
      to: "ExponentPushToken[0]", data: { k: 1 }, priority: "high", title: "Title", body: "Body", sound: "default", channelId: "messages", ttl: 30,
    });
  });

  it("http errors and network failures do not throw", async () => {
    const f = fakeFetch(() => ({ status: 500, json: { errors: [{ code: "INTERNAL" }] } }));
    expect((await new ExpoPushSender({ fetch: f.fetch }).sendMessages([{ to: "x", data: {} }]))[0]!.status).toBe("error");
    const boom = new ExpoPushSender({ fetch: async () => { throw new Error("network down"); } });
    expect((await boom.sendMessages([{ to: "x", data: {} }]))[0]).toEqual({ status: "error", message: "network down" });
  });

  it("data-only message shape", () => {
    const msg = new ExpoPushSender().buildMessage("tok", "T", "B", { a: 1 }, { channel: "call_ringtone", ttl: 45, dataOnly: true });
    expect(msg.title).toBeUndefined();
    expect(msg.body).toBeUndefined();
    expect(msg.sound).toBeUndefined();
    expect([msg.priority, msg.ttl, msg.data]).toEqual(["high", 45, { a: 1 }]);
  });

  it("receipts: polls in batches, removes unregistered tokens, forgets answered tickets, caps and expires", async () => {
    const store = new FakeStore();
    let receiptsFor: Record<string, any> = {};
    const f = fakeFetch((body, url) => {
      if (url.endsWith("getReceipts")) return { status: 200, json: { data: Object.fromEntries(body.ids.filter((i: string) => receiptsFor[i]).map((i: string) => [i, receiptsFor[i]])) } };
      return { status: 200, json: { data: body.map((_: unknown, i: number) => ({ status: "ok", id: `${body[0].to}-${i}` })) } };
    });
    const sender = new ExpoPushSender({ registry: store, fetch: f.fetch });
    await sender.sendMessages([sender.buildMessage("T1", "t", "b", {}), sender.buildMessage("T2", "t", "b", {}), sender.buildMessage("T3", "t", "b", {})]);
    expect(Object.keys(sender.pendingTickets)).toHaveLength(3);
    receiptsFor = { "T1-0": { status: "ok" }, "T1-1": { status: "error", details: { error: "DeviceNotRegistered" } } };
    const summary = await sender.pollReceipts();
    expect(summary).toEqual({ checked: 3, ok: 1, errors: 1, unregistered: 1, pending: 1 });
    expect(store.removed).toEqual([["T2", "expo"]]);
    expect(Object.values(sender.pendingTickets)).toEqual(["T3"]);

    // getReceipts requests carry at most 1000 ids
    const many = new ExpoPushSender({ fetch: f.fetch, maxPendingTickets: 5000 });
    (many as any).tickets = new Map(Array.from({ length: 2500 }, (_, i) => [`id${i}`, ["tok", Date.now()]]));
    await many.pollReceipts();
    expect(f.requests.filter((r) => r.url.endsWith("getReceipts")).slice(-3).map((r) => r.body.ids.length)).toEqual([1000, 1000, 500]);

    // cap (oldest dropped) and TTL expiry
    const capped = new ExpoPushSender({ fetch: f.fetch, maxPendingTickets: 2 });
    await capped.sendMessages(["a", "b", "c"].map((t) => capped.buildMessage(t, null, null, {})));
    expect(Object.keys(capped.pendingTickets)).toHaveLength(2);
    const expiring = new ExpoPushSender({ fetch: f.fetch, receiptTtl: 0.001 });
    await expiring.sendMessages([expiring.buildMessage("x", null, null, {})]);
    await new Promise((r) => setTimeout(r, 20));
    expect((await expiring.pollReceipts()).checked).toBe(0);
  });

  it("receipt poller starts once and stops", async () => {
    const f = fakeFetch(expoOk);
    const sender = new ExpoPushSender({ fetch: f.fetch });
    const t = sender.startReceiptPoller(0.01);
    expect(sender.startReceiptPoller(0.01)).toBe(t);
    await sender.aclose();
    expect((sender as any).poller).toBeNull();
  });
});

// --------------------------------------------------------------------- APNs

describe("ApnsVoipSender", () => {
  it("headers, JWT and expiry; the JWT is cached then re-signed", async () => {
    const session = new FakeApns();
    const sender = makeApns(session);
    const before = Math.floor(Date.now() / 1000);
    expect(await sender.sendVoip("abc123", { type: "incoming_call", uuid: "u" })).toBe(true);
    const req = session.requests[0]!;
    expect(req.path).toBe("/3/device/abc123");
    expect(req.headers["apns-push-type"]).toBe("voip");
    expect(req.headers["apns-topic"]).toBe("com.example.app.voip");
    expect(req.headers["apns-priority"]).toBe("10");
    const exp = Number(req.headers["apns-expiration"]);
    expect(exp).toBeGreaterThanOrEqual(before + 45);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 45);
    expect(req.body).toEqual({ type: "incoming_call", uuid: "u" });

    const [scheme, token] = req.headers.authorization!.split(" ");
    expect(scheme).toBe("bearer");
    expect(decodeProtectedHeader(token!)).toEqual({ alg: "ES256", kid: "KEY123ABCD", typ: "JWT" });
    const { payload } = await jwtVerify(token!, publicKey, { algorithms: ["ES256"] });
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.iat).toBeGreaterThanOrEqual(before - 1);

    await sender.sendVoip("abc123", {});
    expect(session.requests[1]!.headers.authorization).toBe(req.headers.authorization);
    sender.jwtIssuedAt -= sender.tokenRefresh + 5;
    await sender.sendVoip("abc123", {});
    expect(session.requests[2]!.headers.authorization).not.toBe(req.headers.authorization);
  });

  it("sandbox host and option validation", () => {
    expect(makeApns(new FakeApns(), { useSandbox: true }).host).toBe("https://api.sandbox.push.apple.com");
    expect(makeApns(new FakeApns()).host).toBe("https://api.push.apple.com");
    expect(() => makeApns(new FakeApns(), { tokenRefresh: 3600 })).toThrow();
    expect(() => new ApnsVoipSender({ keyId: "k", teamId: "t", bundleId: "b" })).toThrow(/key/);
    expect(makeApns(new FakeApns(), { bundleId: "com.x.voip" }).topic).toBe("com.x.voip");
  });

  for (const [status, reason, removed] of [[410, "Unregistered", true], [400, "BadDeviceToken", true], [400, "PayloadTooLarge", false], [429, "TooManyRequests", false]] as const) {
    it(`invalid token cleanup: ${status} ${reason}`, async () => {
      const store = new FakeStore();
      const session = new FakeApns(() => ({ status, body: JSON.stringify({ reason }) }));
      expect(await makeApns(session, { registry: store }).sendVoip("dead", {})).toBe(false);
      expect(store.removed).toEqual(removed ? [["dead", "voip"]] : []);
    });
  }

  it("ExpiredProviderToken is re-signed once and retried; transport errors return false", async () => {
    const session = new FakeApns((n) => (n === 1 ? { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) } : { status: 200, body: "" }));
    expect(await makeApns(session).sendVoip("tok", {})).toBe(true);
    expect(session.requests).toHaveLength(2);
    const broken: ApnsSession = { request: async () => { throw new Error("socket hang up"); }, close() {} };
    expect(await new ApnsVoipSender({ key: privatePem, keyId: "k", teamId: "t", bundleId: "b", sessionFactory: () => broken }).sendVoip("tok", {})).toBe(false);
  });

  it("aclose closes the session", async () => {
    const session = new FakeApns();
    const sender = makeApns(session);
    await sender.sendVoip("t", {});
    await sender.aclose();
    expect(session.closed).toBe(true);
  });

  it("fromEnv: null when unset, reads key path and sandbox flag", () => {
    expect(ApnsVoipSender.fromEnv(null, {}, {})).toBeNull();
    const dir = mkdtempSync(path.join(tmpdir(), "apns-"));
    try {
      const keyFile = path.join(dir, "AuthKey.p8");
      writeFileSync(keyFile, privatePem);
      const sender = ApnsVoipSender.fromEnv(null, {}, { APNS_KEY_PATH: keyFile, APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_BUNDLE_ID: "com.example.app", APNS_USE_SANDBOX: "true" });
      expect(sender).not.toBeNull();
      expect(sender!.host.startsWith("https://api.sandbox")).toBe(true);
      expect(sender!.topic).toBe("com.example.app.voip");
      expect(ApnsVoipSender.fromEnv(null, {}, { APNS_KEY: privatePem.replace(/\n/g, "\\n"), APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_BUNDLE_ID: "b" })).not.toBeNull();
      expect(ApnsVoipSender.fromEnv(null, {}, { APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_BUNDLE_ID: "b" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------- router

function routerSetup(devices: DeviceInfo[], o: { style?: "data" | "notification"; voip?: boolean; apnsRespond?: (n: number) => ApnsResponse } = {}) {
  const store = new FakeStore({ B: devices });
  const expo = fakeFetch(expoOk);
  const apns = new FakeApns(o.apnsRespond);
  const router = new DevicePushRouter({
    registry: store,
    expo: new ExpoPushSender({ fetch: expo.fetch }),
    voip: o.voip === false ? null : makeApns(apns),
    androidCallStyle: o.style,
  });
  return { router, store, expo, apns };
}

const IOS_VOIP = dev("ios1", "ios", "ExponentPushToken[ios]", "voiptoken1");
const IOS_PLAIN = dev("ios2", "ios", "ExponentPushToken[ios2]");
const ANDROID = dev("and1", "android", "ExponentPushToken[and]");

describe("DevicePushRouter", () => {
  it("iOS incoming call goes VoIP with the CallKit uuid", async () => {
    const { router, expo, apns } = routerSetup([IOS_VOIP]);
    await router.send("B", "Alice", "Incoming audio call", INCOMING, "call_ringtone", 45);
    expect(expo.requests).toEqual([]);
    expect(apns.requests).toHaveLength(1);
    expect(apns.requests[0]!.path.endsWith("/3/device/voiptoken1")).toBe(true);
    expect(apns.requests[0]!.body).toEqual({ ...INCOMING, uuid: callkitUuid("call-123") });
  });

  it("iOS without VoIP token (or without a VoIP sender) falls back to Expo", async () => {
    let s = routerSetup([IOS_PLAIN]);
    await s.router.send("B", "Alice", "Incoming audio call", INCOMING, "call_ringtone", 45);
    expect(s.apns.requests).toEqual([]);
    const msg = s.expo.requests[0]!.body[0];
    expect([msg.to, msg.title, msg.priority, msg.channelId, msg.ttl]).toEqual(["ExponentPushToken[ios2]", "Alice", "high", "call_ringtone", 45]);
    expect(msg.data.uuid).toBeUndefined();

    s = routerSetup([IOS_VOIP], { voip: false });
    await s.router.send("B", "Alice", "Incoming audio call", INCOMING, "call_ringtone", 45);
    expect(s.expo.requests[0]!.body[0].to).toBe("ExponentPushToken[ios]");
  });

  it("VoIP failure removes the token and falls back to Expo", async () => {
    const { router, store, expo } = routerSetup([IOS_VOIP], { apnsRespond: () => ({ status: 410, body: JSON.stringify({ reason: "Unregistered" }) }) });
    await router.send("B", "Alice", "Incoming audio call", INCOMING, "call_ringtone", 45);
    expect(store.removed).toEqual([["voiptoken1", "voip"]]);
    expect(expo.requests[0]!.body[0].to).toBe("ExponentPushToken[ios]");
  });

  for (const style of ["data", "notification"] as const) {
    it(`Android call style ${style}`, async () => {
      const { router, expo, apns } = routerSetup([ANDROID], { style });
      await router.send("B", "Alice", "Incoming audio call", INCOMING, "call_ringtone", 45);
      expect(apns.requests).toEqual([]);
      const msg = expo.requests[0]!.body[0];
      expect([msg.priority, msg.ttl, msg.data]).toEqual(["high", 45, INCOMING]);
      if (style === "data") expect([msg.title, msg.body]).toEqual([undefined, undefined]);
      else expect([msg.title, msg.body, msg.channelId]).toEqual(["Alice", "Incoming audio call", "call_ringtone"]);
    });
  }

  it("chat and missed-call pushes are visible Expo for everyone", async () => {
    const { router, expo, apns } = routerSetup([IOS_VOIP, IOS_PLAIN, ANDROID], { style: "data" });
    await router.send("B", "Alice", "hi", CHAT, "messages");
    await router.send("B", "Alice", "Missed audio call", { type: "missed_call", call_id: "c", chat_id: null, caller_id: "A", call_type: "audio" }, "messages");
    expect(apns.requests).toEqual([]);
    for (const r of expo.requests) {
      expect(r.body).toHaveLength(3);
      expect(r.body.every((m: any) => m.title === "Alice" && m.channelId === "messages")).toBe(true);
    }
  });

  it("mixed devices and unknown users", async () => {
    const { router, expo, apns } = routerSetup([IOS_VOIP, ANDROID], { style: "data" });
    await router.send("B", "Alice", "Incoming audio call", INCOMING, "call_ringtone", 45);
    expect(apns.requests).toHaveLength(1);
    expect(expo.requests[0]!.body).toHaveLength(1);
    expect(expo.requests[0]!.body[0].to).toBe("ExponentPushToken[and]");
    expect(expo.requests[0]!.body[0].title).toBeUndefined();
    await router.send("nobody", "x", "y", CHAT);
    expect(expo.requests).toHaveLength(1);
    expect(apns.requests).toHaveLength(1);
  });

  it("router shares its registry with senders built without one, and validates the style", () => {
    const store = new FakeStore();
    const router = new DevicePushRouter({ registry: store, expo: new ExpoPushSender(), voip: makeApns(new FakeApns()) });
    expect(router.expo.registry).toBe(store);
    expect(router.voip!.registry).toBe(store);
    expect(() => new DevicePushRouter({ registry: store, androidCallStyle: "loud" as any })).toThrow();
  });

  it("works as the hub's PushSender (hub.push never throws)", async () => {
    const { router, expo } = routerSetup([ANDROID]);
    const env = await makeFeatureEnv(() => undefined, { push: router });
    await env.hub.push("B", "t", "b", CHAT, "messages");
    expect(expo.requests).toHaveLength(1);
  });
});
