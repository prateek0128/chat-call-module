import type { CallAudio } from "../src/call/adapters";
import type { CallError, CallSummary, MediaStreamLike, RTCPeerConnectionLike, WebRTCFactory } from "../src/call/types";
import { VoiceCallEngine } from "../src/call/VoiceCallEngine";
import { makeSender } from "./helpers";

const ME = "U1";
const PEER = "U2";

class MockTrack {
  enabled = true;
  stopped = false;
  kind = "audio";
  stop() {
    this.stopped = true;
  }
}
class MockStream implements MediaStreamLike {
  tracks = [new MockTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}
class MockPC implements RTCPeerConnectionLike {
  static all: MockPC[] = [];
  localDescription: any = null;
  remoteDescription: any = null;
  iceGatheringState = "new";
  onicecandidate: any = null;
  ontrack: any = null;
  onconnectionstatechange: any = null;
  added: any[] = [];
  tracks: any[] = [];
  closed = false;
  listeners: Record<string, Array<() => void>> = {};
  constructor(public config: any) {
    MockPC.all.push(this);
  }
  addEventListener(type: string, l: () => void) {
    (this.listeners[type] ||= []).push(l);
  }
  removeEventListener(type: string, l: () => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== l);
  }
  addTrack(track: any) {
    this.tracks.push(track);
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription(d: any) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: any) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: any) {
    this.added.push(c);
  }
  close() {
    this.closed = true;
  }
  completeGathering() {
    this.iceGatheringState = "complete";
    (this.listeners.icegatheringstatechange || []).forEach((l) => l());
  }
  static last() {
    return MockPC.all[MockPC.all.length - 1];
  }
}

const makeWebRTC = (opts: { micFails?: boolean } = {}): WebRTCFactory & { streams: MockStream[] } => {
  const streams: MockStream[] = [];
  return {
    streams,
    createPeerConnection: (c) => new MockPC(c),
    getUserMedia: async () => {
      if (opts.micFails) throw new Error("denied");
      const s = new MockStream();
      streams.push(s);
      return s;
    },
  };
};

const makeAudio = () => {
  const calls: string[] = [];
  const audio: CallAudio = {
    start: ({ speaker }) => calls.push(`start:${speaker}`),
    stop: () => calls.push("stop"),
    startRingtone: () => calls.push("ringtone"),
    stopRingtone: () => calls.push("stopRingtone"),
    startRingback: () => calls.push("ringback"),
    stopRingback: () => calls.push("stopRingback"),
    setSpeaker: (on) => calls.push(`speaker:${on}`),
  };
  return { audio, calls };
};

const setup = (opts: { micFails?: boolean; connected?: boolean; webrtc?: WebRTCFactory | null } = {}) => {
  const s = makeSender();
  const errors: Array<{ error: CallError; attempt: any }> = [];
  const ended: CallSummary[] = [];
  const incoming: any[] = [];
  const { audio, calls } = makeAudio();
  const webrtc = opts.webrtc === undefined ? makeWebRTC(opts) : opts.webrtc;
  const engine = new VoiceCallEngine({
    send: s.send,
    isConnected: () => opts.connected !== false,
    getUserId: () => ME,
    webrtc,
    iceServers: async () => [{ urls: "turn:t.example:3478", username: "u", credential: "p" }],
    audio,
    onError: (error, attempt) => errors.push({ error, attempt }),
    onCallEnded: (sum) => ended.push(sum),
    onIncomingCall: (c) => incoming.push(c),
  });
  return { engine, s, errors, ended, incoming, audioCalls: calls };
};

const base = (type: string, over: Record<string, any> = {}) => ({
  type,
  call_id: "c1",
  chat_id: 7,
  call_type: "audio",
  webrtc_session_id: "c1",
  timestamp: "t",
  ...over,
});

beforeEach(() => {
  MockPC.all = [];
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe("VoiceCallEngine — caller", () => {
  it("initiate -> full offer after ICE gathering -> answer -> connected -> end", async () => {
    const { engine, s, ended, audioCalls } = setup();
    expect(await engine.startCall(PEER, { chatId: "7", peerName: "Asha" })).toBe(true);
    expect(s.last("call_initiate")).toEqual({ type: "call_initiate", receiver_id: PEER, call_type: "audio", chat_id: 7 });
    expect(engine.state.isActive).toBe(false); // waits for call_initiated (no policy ack)

    // legacy caller view: receiver in caller_id / caller_name
    const p = engine.handle(base("call_initiated", { caller_id: PEER, receiver_id: PEER, caller_name: PEER, status: "calling" }));
    await jest.advanceTimersByTimeAsync(0);
    expect(engine.state).toMatchObject({ status: "ringing", direction: "outgoing", isOutgoing: true, peerId: PEER, peerName: "Asha", callId: "c1", chatId: 7 });
    const pc = MockPC.last();
    expect(pc.config.iceServers[0].urls).toBe("turn:t.example:3478");
    expect(s.ofType("sdp_offer")).toHaveLength(0); // still gathering
    pc.onicecandidate({ candidate: { candidate: "cand-1", sdpMid: "0", toJSON: () => ({ candidate: "cand-1", sdpMid: "0" }) } });
    expect(s.last("ice_candidate")).toEqual({ type: "ice_candidate", call_id: "c1", candidate: { candidate: "cand-1", sdpMid: "0" } });
    pc.completeGathering();
    await p;
    expect(s.last("sdp_offer")).toEqual({ type: "sdp_offer", call_id: "c1", sdp: { type: "offer", sdp: "offer-sdp" } });
    expect(audioCalls).toContain("ringback");

    // a callee candidate before the answer is queued, then flushed
    await engine.handle(base("ice_candidate", { candidate: { candidate: "remote-1" } }));
    expect(pc.added).toHaveLength(0);
    await engine.handle(base("sdp_answer", { sdp: { type: "answer", sdp: "a" } }));
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "a" });
    expect(pc.added).toEqual([{ candidate: "remote-1" }]);
    expect(engine.state.status).toBe("connected");
    expect(engine.state.connectedAt).toBeDefined();
    expect(audioCalls).toContain("start:false");

    await engine.handle(base("call_answered", { answerer_id: PEER }));
    expect(engine.state.status).toBe("connected");

    jest.advanceTimersByTime(65000);
    engine.end();
    expect(s.last("end_call")).toEqual({ type: "end_call", call_id: "c1" });
    expect(pc.closed).toBe(true);
    expect(engine.state.isActive).toBe(false);
    expect(ended[0]).toMatchObject({ callId: "c1", endReason: "ended", outgoing: true, peerId: PEER, durationSeconds: 65, chatId: 7 });
    expect(engine.getSnapshot().lastEnded?.callId).toBe("c1");
    expect(audioCalls).toContain("stop");
  });

  it("sends the offer after 3 s even if gathering never completes", async () => {
    const { engine, s } = setup();
    await engine.startCall(PEER);
    const p = engine.handle(base("call_initiated", { caller_id: PEER, receiver_id: PEER }));
    await jest.advanceTimersByTimeAsync(2999);
    expect(s.ofType("sdp_offer")).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(s.ofType("sdp_offer")).toHaveLength(1);
  });

  it("cancel before call_initiated -> end_call as soon as the id arrives", async () => {
    const { engine, s } = setup();
    await engine.startCall(PEER, { extra: { credit_acknowledged: true } });
    expect(engine.state).toMatchObject({ isActive: true, isOutgoing: true }); // shown right away with ack
    engine.end();
    expect(s.ofType("end_call")).toHaveLength(0);
    await engine.handle(base("call_initiated", { caller_id: PEER, receiver_id: PEER }));
    expect(s.last("end_call")).toEqual({ type: "end_call", call_id: "c1" });
    expect(MockPC.all).toHaveLength(0);
  });

  it("policy (credit) error is forwarded untouched with the attempt; retry carries extra", async () => {
    const { engine, s, errors } = setup();
    await engine.startCall(PEER, { chatId: 7, peerName: "Asha", extra: { source: "profile" } });
    const raw = {
      type: "error",
      context: "call",
      status: 403,
      error: "Call requires credits",
      message: "Confirm",
      info: { credit_balance: 10, need_credits: true, credits_needed: 5, access_type: "call" },
    };
    await engine.handle(raw);
    expect(errors[0].error).toMatchObject({ kind: "policy", status: 403, message: "Call requires credits", raw });
    expect(errors[0].attempt).toMatchObject({ peerId: PEER, chatId: 7, extra: { source: "profile" } });
    // retry (what CallProvider's retry() does)
    const a = errors[0].attempt;
    await engine.startCall(a.peerId, { chatId: a.chatId, extra: { ...a.extra, credit_acknowledged: true } });
    expect(s.last("call_initiate")).toEqual({
      type: "call_initiate",
      source: "profile",
      credit_acknowledged: true,
      receiver_id: PEER,
      call_type: "audio",
      chat_id: 7,
    });
  });

  it("legacy credit error without context:'call' is still a call error; chat errors are ignored", async () => {
    const { engine, errors } = setup();
    await engine.handle({ type: "error", error: "Message too large" });
    expect(errors).toHaveLength(0);
    await engine.startCall(PEER);
    await engine.handle({ type: "error", status: 402, error: "No credits", info: { access_type: "call" } });
    expect(errors[0].error.kind).toBe("policy");
  });

  it("busy reply (call_rejected, call_id null) -> busy error, nothing left behind", async () => {
    const { engine, errors, ended } = setup();
    await engine.startCall(PEER);
    await engine.handle({ type: "call_rejected", call_id: null, status: "busy", reason: "busy", caller_id: ME, receiver_id: PEER, call_type: "audio" });
    expect(errors[0].error.kind).toBe("busy");
    expect(engine.state.isActive).toBe(false);
    expect(ended).toHaveLength(0);
    // a new call is possible
    expect(await engine.startCall(PEER)).toBe(true);
  });

  it("declined / missed set the end reason", async () => {
    const { engine, ended, s } = setup();
    await engine.startCall(PEER);
    void engine.handle(base("call_initiated", { caller_id: PEER, receiver_id: PEER }));
    await jest.advanceTimersByTimeAsync(0);
    await engine.handle(base("call_rejected", { caller_id: PEER, caller_name: ME, end_reason: "declined", rejector_id: PEER }));
    expect(ended[0]).toMatchObject({ endReason: "declined", durationSeconds: null, outgoing: true });

    await engine.startCall(PEER);
    void engine.handle(base("call_initiated", { call_id: "c2", caller_id: PEER, receiver_id: PEER }));
    await jest.advanceTimersByTimeAsync(0);
    await engine.handle(base("call_missed", { call_id: "c2", end_reason: "no_answer" }));
    expect(ended[1]).toMatchObject({ callId: "c2", endReason: "missed" });
    // the pending offer is never sent for a call that already ended
    await jest.advanceTimersByTimeAsync(3000);
    expect(s.ofType("sdp_offer")).toHaveLength(0);
  });

  it("refuses when unavailable / disconnected / already in a call / no mic", async () => {
    let ctx = setup({ webrtc: null });
    expect(await ctx.engine.startCall(PEER)).toBe(false);
    expect(ctx.errors[0].error.kind).toBe("unavailable");
    ctx = setup({ connected: false });
    expect(await ctx.engine.startCall(PEER)).toBe(false);
    expect(ctx.errors[0].error.kind).toBe("not_connected");
    ctx = setup({ micFails: true });
    expect(await ctx.engine.startCall(PEER)).toBe(false);
    expect(ctx.errors[0].error.kind).toBe("microphone");
    ctx = setup();
    await ctx.engine.startCall(PEER);
    expect(await ctx.engine.startCall("U3")).toBe(false);
    expect(ctx.errors[0].error.kind).toBe("already_in_call");
  });

  it("ignores call_initiated it did not ask for (other device)", async () => {
    const { engine, s } = setup();
    await engine.handle(base("call_initiated", { caller_id: PEER, receiver_id: PEER }));
    expect(engine.state.isActive).toBe(false);
    expect(s.sent).toHaveLength(0);
  });
});

describe("VoiceCallEngine — callee", () => {
  const ring = async (engine: VoiceCallEngine, over: Record<string, any> = {}) =>
    engine.handle(base("incoming_call", { caller_id: PEER, receiver_id: ME, caller_name: "Asha", caller_avatar: "https://a", ...over }));

  it("rings, accepts, waits for the offer, answers", async () => {
    const { engine, s, incoming, audioCalls } = setup();
    await ring(engine);
    expect(engine.state).toMatchObject({ status: "ringing", isIncoming: true, peerId: PEER, peerName: "Asha", peerAvatar: "https://a", chatId: 7 });
    expect(incoming).toHaveLength(1);
    expect(audioCalls).toEqual(["ringtone"]);

    // caller candidate before we have a peer connection -> queued
    await engine.handle(base("ice_candidate", { candidate: { candidate: "early" } }));
    const accepting = engine.accept();
    await jest.advanceTimersByTimeAsync(500);
    expect(s.ofType("sdp_answer")).toHaveLength(0); // still waiting for the offer
    await engine.handle(base("sdp_offer", { sdp: { type: "offer", sdp: "o" }, from_user_id: PEER }));
    await accepting;
    const pc = MockPC.last();
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "o" });
    expect(pc.added).toEqual([{ candidate: "early" }]);
    expect(s.sent.map((m) => m.type)).toEqual(["sdp_answer", "answer_call"]);
    expect(s.last("sdp_answer")).toEqual({ type: "sdp_answer", call_id: "c1", sdp: { type: "answer", sdp: "answer-sdp" } });
    expect(engine.state).toMatchObject({ status: "connected", isIncoming: false, direction: "incoming" });
    expect(audioCalls).toContain("stopRingtone");
    expect(audioCalls).toContain("start:false");
  });

  it("uses the stored offer from a re-sent incoming_call", async () => {
    const { engine, s } = setup();
    await ring(engine);
    await ring(engine, { sdp: { type: "offer", sdp: "stored" } }); // reconnect re-send
    await engine.accept();
    expect(MockPC.last().remoteDescription).toEqual({ type: "offer", sdp: "stored" });
    expect(s.ofType("answer_call")).toHaveLength(1);
  });

  it("no offer within 10 s -> no_offer error + reject_call", async () => {
    const { engine, s, errors, ended } = setup();
    await ring(engine);
    const accepting = engine.accept();
    await jest.advanceTimersByTimeAsync(10000);
    await accepting;
    expect(errors[0].error.kind).toBe("no_offer");
    expect(s.last("reject_call")).toEqual({ type: "reject_call", call_id: "c1" });
    expect(ended[0].endReason).toBe("failed");
  });

  it("answered on another device -> stop ringing here", async () => {
    const { engine, ended, s } = setup();
    await ring(engine);
    await engine.handle(base("call_answered", { caller_id: PEER, receiver_id: ME, answerer_id: ME }));
    expect(engine.state.isActive).toBe(false);
    expect(ended[0].endReason).toBe("answered_elsewhere");
    expect(s.sent).toHaveLength(0);
  });

  it("reject sends reject_call; caller hanging up = missed", async () => {
    const { engine, s, ended } = setup();
    await ring(engine);
    engine.reject();
    expect(s.last("reject_call")).toEqual({ type: "reject_call", call_id: "c1" });
    expect(ended[0]).toMatchObject({ endReason: "declined", outgoing: false });

    await ring(engine, { call_id: "c3" });
    await engine.handle(base("call_ended", { call_id: "c3", end_reason: "caller_cancelled", caller_name: PEER }));
    expect(ended[1]).toMatchObject({ callId: "c3", endReason: "missed" });
  });

  it("events for another call are ignored; a second incoming call doesn't drop the live one", async () => {
    const { engine } = setup();
    await ring(engine);
    await engine.handle(base("call_ended", { call_id: "other" }));
    expect(engine.state.callId).toBe("c1");
    await ring(engine, { call_id: "c9", caller_id: "U9" });
    expect(engine.state.callId).toBe("c1");
  });

  it("toggleMute flips the local track; toggleSpeaker uses the audio adapter", async () => {
    const { engine, audioCalls } = setup();
    await ring(engine, { sdp: { type: "offer", sdp: "o" } });
    await engine.accept();
    expect(engine.toggleMute()).toBe(true);
    expect(engine.getSnapshot().localStream!.getAudioTracks()[0].enabled).toBe(false);
    expect(engine.toggleMute()).toBe(false);
    expect(engine.toggleSpeaker()).toBe(true);
    expect(audioCalls).toContain("speaker:true");
    engine.end();
    expect(engine.getSnapshot()).toMatchObject({ isMuted: false, isSpeakerOn: false, localStream: null });
  });

  it("call errors for a call we already left are ignored", async () => {
    const { engine, errors } = setup();
    await ring(engine);
    engine.reject();
    await engine.handle({ type: "error", context: "call", call_id: "c1", error: "Call not found" });
    expect(errors).toHaveLength(0);
  });
});
