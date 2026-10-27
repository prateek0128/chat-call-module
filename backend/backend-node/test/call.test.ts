/** Call-only app (no chat feature): chat_id null, no call_log. Port of backend/backend-python/tests/test_call.py. */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type CallPolicy, CallFeature, allow, callLogText, callkitUuid, deny, turnCredentials } from "../src/call/index.js";
import { RateLimit } from "../src/index.js";
import { closeAllCall, makeCallEnv } from "./call.helpers.js";
import { type WsClient, sleep } from "./helpers.js";

afterEach(closeAllCall);

const OFFER = { type: "offer", sdp: "v=0 offer" };
const ANSWER = { type: "answer", sdp: "v=0 answer" };
const BASE_KEYS = ["type", "call_id", "chat_id", "caller_id", "receiver_id", "call_type", "webrtc_session_id", "timestamp"];

async function startCall(a: WsClient, b: WsClient, callType = "audio") {
  a.send("call_initiate", { receiver_id: "B", call_type: callType });
  const initiated = await a.expect("call_initiated");
  const incoming = await b.expect("incoming_call");
  const ringing = await a.expect("call_ringing");
  return { initiated, incoming, ringing };
}

describe("call-only app", () => {
  it("has no chat feature", async () => {
    const env = await makeCallEnv();
    expect(env.hub.handles("call_initiate")).toBe(true);
    expect(env.hub.handles("send_message")).toBe(false);
    expect((await env.post("/chats/start?candidate_id=B", "A")).status).toBe(404);
  });

  it("happy path", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const { initiated, incoming, ringing } = await startCall(a, b);
    const callId = initiated.call_id;

    for (const k of BASE_KEYS) expect(initiated).toHaveProperty(k);
    expect(initiated.status).toBe("calling");
    expect(initiated.chat_id).toBeNull();
    // Legacy caller view: the peer sits in caller_id / caller_name.
    expect(initiated.caller_id).toBe("B");
    expect(initiated.caller_name).toBe("B");
    expect(initiated.receiver_id).toBe("B");
    expect(initiated.webrtc_session_id).toBe(callId);
    expect(initiated.call_type).toBe("audio");

    expect(incoming).toMatchObject({
      call_id: callId, caller_id: "A", receiver_id: "B", caller_name: "Alice", caller_avatar: "https://img/a.png",
    });
    expect(ringing.status).toBe("ringing");
    expect(ringing.caller_id).toBe("B");

    a.send("sdp_offer", { call_id: callId, sdp: OFFER });
    const offer = await b.expect("sdp_offer");
    expect(offer).toMatchObject({ from_user_id: "A", sdp: OFFER, call_id: callId });

    b.send("ice_candidate", { call_id: callId, candidate: { candidate: "c-b" } });
    expect((await a.expect("ice_candidate")).candidate).toEqual({ candidate: "c-b" });
    a.send("ice_candidate", { call_id: callId, candidate: { candidate: "c-a" } });
    expect((await b.expect("ice_candidate")).from_user_id).toBe("A");

    b.send("sdp_answer", { call_id: callId, sdp: ANSWER });
    expect((await a.expect("sdp_answer")).sdp).toEqual(ANSWER);
    b.send("answer_call", { call_id: callId });
    const answered = await a.expect("call_answered");
    expect(answered.status).toBe("answered");
    expect(answered.answerer_id).toBe("B");
    expect((await b.expect("call_answered")).call_id).toBe(callId);

    b.send("answer_call", { call_id: callId }); // duplicate: ignored
    a.send("start_recording", { call_id: callId }); // accepted, ignored

    a.send("end_call", { call_id: callId });
    const endedB = await b.expect("call_ended");
    const endedA = await a.expect("call_ended");
    for (const ended of [endedA, endedB]) {
      expect(ended).toMatchObject({ status: "call_ended", end_reason: "hangup", ended_by: "A", caller_name: "A", chat_id: null });
      expect(Number.isInteger(ended.duration_seconds)).toBe(true);
      expect(ended.duration_seconds).toBeGreaterThanOrEqual(0);
    }
    await a.expectNone("call_log");

    a.send("sdp_offer", { call_id: callId, sdp: OFFER });
    const err = await a.expect("error");
    expect(err.context).toBe("call");
    expect(err.error).toBe("No active call found.");
    expect(env.push.sent).toEqual([]);
  });

  it("validation errors", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    a.send("call_initiate", {});
    expect(await a.expect("error")).toEqual({ type: "error", error: "Missing required fields: receiver_id", context: "call" });
    a.send("answer_call", {});
    expect((await a.expect("error")).error).toBe("Missing required fields: call_id");
    a.send("sdp_offer", { call_id: "x" });
    expect((await a.expect("error")).error).toBe("Missing required fields: sdp, call_id");
  });

  it("reject", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const { initiated } = await startCall(a, b);
    b.send("reject_call", { call_id: initiated.call_id });
    for (const ws of [a, b]) {
      const rejected = await ws.expect("call_rejected");
      expect(rejected).toMatchObject({
        status: "call_rejected", end_reason: "declined", rejector_id: "B", caller_name: "A", duration_seconds: 0,
        call_id: initiated.call_id,
      });
    }
  });

  it("caller cancel pushes incoming then missed to an offline receiver", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    a.send("call_initiate", { receiver_id: "B" });
    const initiated = await a.expect("call_initiated");
    await a.expectNone("call_ringing");
    const incomingPush = await env.push.waitFor((p) => p.data.type === "incoming_call");
    expect(incomingPush).toMatchObject({ user_id: "B", channel: "call_ringtone", ttl: 45, title: "Alice", body: "Incoming audio call" });
    expect(incomingPush.data).toEqual({
      type: "incoming_call", call_id: initiated.call_id, chat_id: null, caller_id: "A", caller_name: "Alice",
      caller_avatar: "https://img/a.png", call_type: "audio",
    });

    a.send("end_call", { call_id: initiated.call_id });
    expect((await a.expect("call_ended")).end_reason).toBe("caller_cancelled");
    const missed = await env.push.waitFor((p) => p.data.type === "missed_call");
    expect(missed.channel).toBe("messages");
    expect(missed.data.call_id).toBe(initiated.call_id);
    expect(missed.body).toBe("Missed audio call");
  });

  it("busy and already in a call", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const c = await env.ws("C");
    const { initiated } = await startCall(a, b);

    c.send("call_initiate", { receiver_id: "B", call_type: "video" });
    const busy = await c.expect("call_rejected");
    expect(busy.call_id).toBeNull();
    expect(busy).toMatchObject({ status: "busy", reason: "busy", caller_id: "C", receiver_id: "B", call_type: "video" });
    expect(Object.keys(busy).sort()).toEqual(
      ["type", "call_id", "status", "reason", "caller_id", "receiver_id", "call_type", "timestamp"].sort(),
    );

    a.send("call_initiate", { receiver_id: "C" });
    expect(await a.expect("error")).toEqual({ type: "error", error: "You are already in a call.", context: "call" });
    a.send("call_initiate", { receiver_id: "A" });
    expect((await a.expect("error")).error).toBe("You cannot call yourself.");
    b.send("answer_call", { call_id: "nope" });
    expect(await b.expect("error")).toEqual({ type: "error", error: "Call not found", call_id: "nope", context: "call" });
    expect(initiated.call_id).toBeTruthy();
  });

  it("ring timeout", async () => {
    const env = await makeCallEnv({ config: { ringTimeout: 0.4 } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    const { initiated } = await startCall(a, b);
    for (const ws of [a, b]) {
      const missed = await ws.expect("call_missed", {}, 3000);
      expect(missed).toMatchObject({ status: "missed", end_reason: "no_answer", call_id: initiated.call_id });
    }
    // Answering after the timeout just stops the ringing.
    b.send("answer_call", { call_id: initiated.call_id });
    expect((await b.expect("call_ended")).end_reason).toBe("missed");
    expect(env.push.sent.filter((p) => p.data.type === "missed_call")).toEqual([]); // B was online
  });

  it("policy deny passes the host payload through with context call", async () => {
    const credits: CallPolicy = {
      authorize(_db, _caller, _receiver, message) {
        if (message.credit_acknowledged) return allow();
        return deny("This would be a paid feature.", {
          status: 403,
          message: "1 Credit = 1 Profile",
          info: { credit_balance: 3, need_credits: true, credits_needed: 1, access_type: "call" },
        });
      },
    };
    const env = await makeCallEnv({ policy: credits });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("call_initiate", { receiver_id: "B" });
    expect(await a.expect("error")).toEqual({
      type: "error",
      error: "This would be a paid feature.",
      status: 403,
      message: "1 Credit = 1 Profile",
      context: "call",
      info: { credit_balance: 3, need_credits: true, credits_needed: 1, access_type: "call" },
    });
    await b.expectNone("incoming_call");

    a.send("call_initiate", { receiver_id: "B", credit_acknowledged: true });
    await a.expect("call_initiated");
    await b.expect("incoming_call");
  });

  it("REST reject and re-ring with the stored offer on reconnect", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    a.send("call_initiate", { receiver_id: "B" });
    const callId = (await a.expect("call_initiated")).call_id;
    a.send("sdp_offer", { call_id: callId, sdp: OFFER }); // stored for a late receiver
    await a.sync();

    const b = await env.ws("B");
    const again = await b.expect("incoming_call");
    expect(again).toMatchObject({ call_id: callId, sdp: OFFER, caller_name: "Alice" });

    expect((await env.post("/call/nope/reject", "B")).status).toBe(404);
    expect((await env.post(`/call/${callId}/reject`, "C")).status).toBe(404);
    expect((await env.post(`/call/${callId}/reject`)).status).toBe(401);
    const resp = await env.post(`/call/${callId}/reject`, "B");
    expect(resp.status).toBe(200);
    expect(resp.json).toEqual({ status: true });
    const rejected = await a.expect("call_rejected");
    expect(rejected).toMatchObject({ rejector_id: "B", end_reason: "declined" });
    expect((await env.post("/call/nope/reject", "B")).json).toEqual({ status: false, message: "Call not found" });
  });

  it("disconnect grace ends an answered call", async () => {
    const env = await makeCallEnv({ config: { ringingDisconnectGrace: 0.2, answeredDisconnectGrace: 0.4 } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    const { initiated } = await startCall(a, b);
    b.send("answer_call", { call_id: initiated.call_id });
    await a.expect("call_answered");
    await b.close();
    const ended = await a.expect("call_ended", {}, 3000);
    expect(ended).toMatchObject({ end_reason: "disconnected", ended_by: "B" });
  });

  it("disconnect grace misses a ringing call", async () => {
    const env = await makeCallEnv({ config: { ringingDisconnectGrace: 0.2, answeredDisconnectGrace: 0.4 } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    await startCall(a, b);
    await b.close();
    // The receiver left while ringing: the caller learns the call ended.
    const ended = await a.expect("call_ended", { end_reason: "disconnected" }, 3000);
    expect(ended.ended_by).toBe("B");
    const row = await env.db.selectFrom("calls").selectAll().executeTakeFirst();
    expect(row!.call_status).toBe("missed");
  });

  it("reconnecting inside the grace keeps the call", async () => {
    const env = await makeCallEnv({ config: { ringingDisconnectGrace: 0.3, answeredDisconnectGrace: 0.6 } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    const { initiated } = await startCall(a, b);
    b.send("answer_call", { call_id: initiated.call_id });
    await a.expect("call_answered");
    await b.close();
    const b2 = await env.ws("B");
    await sleep(900);
    await a.expectNone("call_ended", 100);
    b2.send("end_call", { call_id: initiated.call_id });
    expect((await a.expect("call_ended")).end_reason).toBe("hangup");
  });

  it("TURN credentials: HMAC-SHA1, 503 when unconfigured", async () => {
    const env = await makeCallEnv({ config: { turnSecret: "turn-test-secret", turnUris: ["turn:example.org:3478"] } });
    const body = (await env.post("/call/turn-credentials", "A")).json;
    expect(body.ttl).toBe(3600);
    expect(body.uris).toEqual(["turn:example.org:3478"]);
    expect(body.username).toMatch(/^\d+$/); // Python: no user id in the username
    expect(body.password).toBe(createHmac("sha1", "turn-test-secret").update(body.username).digest("base64"));
    expect((await env.post("/call/turn-credentials")).status).toBe(401);

    const plain = await makeCallEnv();
    const r = await plain.post("/call/turn-credentials", "A");
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ detail: "TURN is not configured" });

    expect(turnCredentials("s", ["u"], 60, "U1", 1000).username).toBe("1060:U1");
  });

  it("rate-limits call_initiate per caller", async () => {
    const env = await makeCallEnv({ config: { initiateRate: new RateLimit(2, 60) } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    await startCall(a, b);
    a.send("call_initiate", { receiver_id: "C" });
    expect((await a.expect("error")).error).toBe("You are already in a call."); // second token used
    a.send("call_initiate", { receiver_id: "C" });
    const limited = await a.expect("error");
    expect(limited).toMatchObject({ code: "rate_limited", context: "call" });
    expect(limited.error).toMatch(/^Too many calls\. Try again in \d+ s\.$/);
    expect(Number.isInteger(limited.retry_after)).toBe(true);
  });

  it("a stale leftover call (nobody connected) does not make the receiver busy", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    a.send("call_initiate", { receiver_id: "B" });
    const callId = (await a.expect("call_initiated")).call_id;
    // B has no socket anywhere; A goes away too -> the ringing call to B is a leftover.
    await a.close();
    await sleep(100);
    const c = await env.ws("C");
    c.send("call_initiate", { receiver_id: "B" });
    await c.expect("call_initiated");
    const row = await env.db.selectFrom("calls").selectAll().where("call_id", "=", callId).executeTakeFirst();
    expect(row!.call_status).toBe("missed");
    expect(row!.end_reason).toBe("stale");
  });

  it("endCallsBetween ends ringing (missed) and answered (ended) calls with the reason", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const { initiated } = await startCall(a, b);
    const ended = await env.call.endCallsBetween("A", "B", "blocked", "A");
    expect(ended).toHaveLength(1);
    for (const ws of [a, b]) {
      expect(await ws.expect("call_ended")).toMatchObject({
        call_id: initiated.call_id, end_reason: "blocked", ended_by: "A", status: "call_ended",
      });
    }
    const row = await env.db.selectFrom("calls").selectAll().executeTakeFirst();
    expect(row).toMatchObject({ call_status: "missed", end_reason: "blocked" });

    const second = await startCall(a, b);
    b.send("answer_call", { call_id: second.initiated.call_id });
    await a.expect("call_answered");
    await env.call.endCallsBetween("B", "A", "blocked");
    expect(await a.expect("call_ended")).toMatchObject({ end_reason: "blocked", ended_by: "B" });
    const rows = await env.db.selectFrom("calls").selectAll().where("call_id", "=", second.initiated.call_id).execute();
    expect(rows[0].call_status).toBe("ended");
    expect(await env.call.endCallsBetween("A", "C", "blocked")).toEqual([]);
  });

  it("deleteUserData removes the user's calls only", async () => {
    const env = await makeCallEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const c = await env.ws("C");
    const first = await startCall(a, b);
    a.send("end_call", { call_id: first.initiated.call_id });
    await a.expect("call_ended");
    c.send("call_initiate", { receiver_id: "A" });
    await c.expect("call_initiated");
    expect(await env.call.deleteUserData("B")).toEqual({ calls: 1 });
    const left = await env.db.selectFrom("calls").selectAll().execute();
    expect(left).toHaveLength(1);
    expect(left[0].caller_id).toBe("C");
    expect(await env.call.deleteUserData("B")).toEqual({ calls: 0 });
  });

  it("shutdown cancels pending timers", async () => {
    const env = await makeCallEnv({ config: { ringTimeout: 0.2 } });
    const a = await env.ws("A");
    a.send("call_initiate", { receiver_id: "B" });
    await a.expect("call_initiated");
    await env.hub.shutdown();
    await sleep(400);
    const row = await env.db.selectFrom("calls").selectAll().executeTakeFirst();
    expect(row!.call_status).toBe("ringing");
  });
});

describe("helpers", () => {
  it("callkitUuid vectors (UUIDv5 over NAMESPACE_URL)", () => {
    expect(callkitUuid("call-123")).toBe("e394bb1f-a663-5750-8664-4de655ce4bf3");
    expect(callkitUuid("3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c")).toBe("653579da-f398-55b8-9545-46885f1e073e");
  });

  it("callLogText formats", () => {
    expect(callLogText("ended", false, 342)).toBe("Voice call · 05:42");
    expect(callLogText("ended", true, 0)).toBe("Video call · 00:00");
    expect(callLogText("ended", false, 3600)).toBe("Voice call · 1:00:00");
    expect(callLogText("ended", false, 3725)).toBe("Voice call · 1:02:05");
    expect(callLogText("missed", false, 0, "caller_cancelled")).toBe("Missed voice call");
    expect(callLogText("rejected", true, 0)).toBe("Declined video call");
    expect(callLogText("ended", false, -5)).toBe("Voice call · 00:00");
  });

  it("an uninstalled CallFeature refuses hub access", () => {
    expect(() => new CallFeature().hub).toThrow();
  });
});
