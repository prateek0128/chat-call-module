/** Call screen state mapping: engine state / end summary / error -> phase, status line, controls. */
import type { CallState, CallSummary } from "../src/call/types";
import { IDLE_CALL } from "../src/call/VoiceCallEngine";
import { controlCaption, controlLabel, ENDED_AUTO_DISMISS_MS, failureCopy, mapEndedCall, mapLiveCall } from "../src/call-ui/callScreenState";

const live = (over: Partial<CallState>): CallState => ({
  ...IDLE_CALL,
  status: "ringing",
  direction: "outgoing",
  isIncoming: false,
  isOutgoing: true,
  isActive: true,
  callId: "c1",
  peerId: "bob",
  peerName: "Bob",
  callType: "audio",
  ...over,
});

const summary = (over: Partial<CallSummary>): CallSummary => ({
  callId: "c1",
  endReason: "ended",
  outgoing: true,
  peerId: "bob",
  peerName: "Bob",
  callType: "audio",
  durationSeconds: null,
  ...over,
});

const L = (call: CallState, o: { accepted?: boolean; ringing?: boolean; speaker?: boolean } = {}) =>
  mapLiveCall({ call, accepted: !!o.accepted, ringingReceived: !!o.ringing, speakerAvailable: o.speaker ?? true });

describe("live call -> screen", () => {
  it("no screen when idle", () => {
    expect(L(IDLE_CALL)).toBeNull();
  });

  it("outgoing: Calling… then Ringing… once call_ringing arrives; Mute, Speaker, Hang up; pulse", () => {
    expect(L(live({}))).toMatchObject({ phase: "outgoing", status: "Calling…", controls: ["mute", "speaker", "hangup"], pulse: true, canMinimise: true });
    expect(L(live({}), { ringing: true })).toMatchObject({ phase: "outgoing", status: "Ringing…" });
  });

  it("speaker only where the platform can switch output", () => {
    expect(L(live({}), { speaker: false })!.controls).toEqual(["mute", "hangup"]);
  });

  it("incoming: Decline / Accept, not minimisable", () => {
    const call = live({ direction: "incoming", isIncoming: true, isOutgoing: false });
    expect(L(call)).toMatchObject({ phase: "incoming", status: "Incoming voice call", controls: ["decline", "accept"], pulse: true, canMinimise: false });
    expect(L({ ...call, callType: "video" })!.status).toBe("Incoming video call");
  });

  it("incoming after Accept: Connecting…", () => {
    const call = live({ direction: "incoming", isIncoming: true, isOutgoing: false });
    expect(L(call, { accepted: true })).toMatchObject({ phase: "connecting", status: "Connecting…", controls: ["mute", "speaker", "hangup"], pulse: false });
  });

  it("connected: timer + toggles", () => {
    expect(L(live({ status: "connected", isOutgoing: false, connectedAt: 1 }))).toMatchObject({ phase: "active", showTimer: true, pulse: false, controls: ["mute", "speaker", "hangup"] });
    expect(L(live({ status: "connected", direction: "incoming", isIncoming: false }), { accepted: true })!.phase).toBe("active");
  });
});

describe("ended / failed -> screen", () => {
  it("connected call: 'Call ended · MM:SS', auto-dismiss 1.6 s, no controls", () => {
    expect(mapEndedCall({ summary: summary({ durationSeconds: 342 }), error: null })).toMatchObject({
      phase: "ended",
      status: "Call ended · 05:42",
      controls: [],
      autoDismissMs: ENDED_AUTO_DISMISS_MS,
    });
    expect(ENDED_AUTO_DISMISS_MS).toBe(1600);
  });

  it("outgoing no answer / declined: reason + Close + Call again", () => {
    expect(mapEndedCall({ summary: summary({ endReason: "missed" }), error: null })).toMatchObject({
      phase: "failed",
      status: "No answer",
      controls: ["close", "callAgain"],
      tone: "danger",
    });
    expect(mapEndedCall({ summary: summary({ endReason: "declined" }), error: null })).toMatchObject({ status: "Declined", controls: ["close", "callAgain"] });
  });

  it("incoming missed shows a short summary; my own decline / cancel / answered elsewhere just close", () => {
    expect(mapEndedCall({ summary: summary({ endReason: "missed", outgoing: false }), error: null })).toMatchObject({ phase: "ended", status: "Missed call" });
    expect(mapEndedCall({ summary: summary({ endReason: "declined", outgoing: false }), error: null })).toBeNull();
    expect(mapEndedCall({ summary: summary({ endReason: "cancelled" }), error: null })).toBeNull();
    expect(mapEndedCall({ summary: summary({ endReason: "answered_elsewhere", outgoing: false }), error: null })).toBeNull();
    expect(mapEndedCall({ summary: null, error: null })).toBeNull();
  });

  it("errors give the specific reason", () => {
    const busy = mapEndedCall({ summary: summary({ endReason: "failed" }), error: { kind: "busy" } });
    expect(busy).toMatchObject({ phase: "failed", status: "On another call", controls: ["close", "callAgain"] });
    const mic = mapEndedCall({ summary: null, error: { kind: "microphone", peerId: "bob" }, peerName: "Bob" });
    expect(mic).toMatchObject({ status: "Microphone access is blocked", peerName: "Bob", controls: ["close", "callAgain"] });
    expect(mic!.hint).toMatch(/Settings/);
    expect(mapEndedCall({ summary: summary({ endReason: "failed" }), error: null })!.status).toBe("Couldn't connect");
    expect(mapEndedCall({ summary: null, error: { kind: "unavailable", peerId: "bob" } })).toMatchObject({ status: "Calling isn't available on this device", controls: ["close"] });
  });

  it("no Call again for incoming failures or without a peer", () => {
    expect(mapEndedCall({ summary: summary({ endReason: "failed", outgoing: false }), error: { kind: "no_offer" } })!.controls).toEqual(["close"]);
    expect(mapEndedCall({ summary: null, error: { kind: "busy" } })!.controls).toEqual(["close"]);
  });

  it("policy / already-in-call errors are left to the host (no screen)", () => {
    expect(mapEndedCall({ summary: summary({ endReason: "failed" }), error: { kind: "policy" } })).toBeNull();
    expect(mapEndedCall({ summary: null, error: { kind: "already_in_call" } })).toBeNull();
    expect(failureCopy("policy")).toBeNull();
  });

  it("Message action when chat is available", () => {
    expect(mapEndedCall({ summary: summary({ endReason: "missed" }), error: null, canOpenChat: true })!.controls).toEqual(["close", "callAgain", "message"]);
  });
});

describe("control labels", () => {
  it("are explicit for screen readers", () => {
    expect(controlLabel("mute")).toBe("Mute microphone");
    expect(controlLabel("mute", { muted: true })).toBe("Unmute microphone");
    expect(controlLabel("callAgain", { peerName: "Bob" })).toBe("Call Bob again");
    expect(controlLabel("accept")).toBe("Accept call");
    expect(controlCaption("hangup")).toBe("End");
    expect(controlCaption("mute", { muted: true })).toBe("Unmute");
  });
});
