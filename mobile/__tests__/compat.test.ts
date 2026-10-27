import { isBusyReply, isCallError, isPolicyError, normalizeCallEvent, toChatId } from "../src/call/compat";

const ME = "U1";
const PEER = "U2";

describe("call/compat (PROTOCOL §6 quirks)", () => {
  it("legacy caller view: call_initiated / call_ringing peer is the receiver, caller_name dropped", () => {
    const legacy = { type: "call_initiated", call_id: "c1", chat_id: 7, caller_id: PEER, receiver_id: PEER, caller_name: PEER };
    expect(normalizeCallEvent(legacy, ME)).toMatchObject({ peerId: PEER, peerName: undefined, callId: "c1", chatId: 7 });
    const fixed = { type: "call_ringing", call_id: "c1", caller_id: ME, receiver_id: PEER };
    expect(normalizeCallEvent(fixed, ME).peerId).toBe(PEER);
    // works without knowing my id
    expect(normalizeCallEvent(legacy, null).peerId).toBe(PEER);
  });

  it("incoming_call: peer = caller, real name kept, name equal to an id dropped", () => {
    expect(normalizeCallEvent({ type: "incoming_call", call_id: "c", caller_id: PEER, receiver_id: ME, caller_name: "Asha", caller_avatar: "https://a" }, ME)).toMatchObject({
      peerId: PEER,
      peerName: "Asha",
      peerAvatar: "https://a",
    });
    expect(normalizeCallEvent({ type: "incoming_call", call_id: "c", caller_id: PEER, receiver_id: ME, caller_name: PEER }, ME).peerName).toBeUndefined();
  });

  it("caller_name in call_ended / call_rejected is an id -> ignored; peer resolved from ids", () => {
    const ev = normalizeCallEvent({ type: "call_ended", call_id: "c", caller_id: PEER, receiver_id: ME, caller_name: PEER, duration_seconds: 12 }, ME);
    expect(ev).toMatchObject({ peerId: PEER, peerName: undefined, durationSeconds: 12 });
    expect(normalizeCallEvent({ type: "call_rejected", call_id: "c", caller_id: ME, receiver_id: PEER, caller_name: ME }, ME).peerId).toBe(PEER);
  });

  it("busy = call_rejected with call_id null", () => {
    const busy = { type: "call_rejected", call_id: null, status: "busy", reason: "busy", caller_id: ME, receiver_id: PEER };
    expect(isBusyReply(busy)).toBe(true);
    expect(normalizeCallEvent(busy, ME)).toMatchObject({ isBusy: true, callId: null });
    expect(isBusyReply({ type: "call_rejected", call_id: null })).toBe(true);
    expect(isBusyReply({ type: "call_rejected", call_id: "c", status: "call_rejected", end_reason: "declined" })).toBe(false);
  });

  it("error classification", () => {
    expect(isCallError({ type: "error", context: "call" })).toBe(true);
    expect(isCallError({ type: "error", info: { access_type: "call" } })).toBe(true);
    expect(isCallError({ type: "error", error: "Message too large" })).toBe(false);
    expect(isPolicyError({ status: 402 })).toBe(true);
    expect(isPolicyError({ status: "403" })).toBe(true);
    expect(isPolicyError({ status: 500 })).toBe(false);
  });

  it("toChatId", () => {
    expect(toChatId("12")).toBe(12);
    expect(toChatId(5)).toBe(5);
    expect(toChatId("0")).toBeNull();
    expect(toChatId("abc")).toBeNull();
    expect(toChatId(undefined)).toBeNull();
  });
});
