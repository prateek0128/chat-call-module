/**
 * VoiceCallEngine — framework-free WebRTC call state machine.
 * No React, no react-native imports; WebRTC, audio and the socket
 * are injected so it can be unit-tested with mocks.
 *
 * Flow (PROTOCOL §4):
 *   caller: call_initiate -> call_initiated -> full sdp_offer after ICE gathering (<= 3 s)
 *           -> sdp_answer / call_answered -> connected
 *   callee: incoming_call (ringing) -> accept -> wait for offer (<= 10 s) -> sdp_answer + answer_call
 * ICE candidates are trickled both ways and queued until the remote description is set.
 * Multi-device: `call_answered` by our own id on a device that didn't accept = answered elsewhere.
 * Busy and host-policy (credit) errors are reported through `onError` untouched.
 */
import { secondsSince } from "../core/callLog";
import { Logger, noopLogger } from "../core/config";
import type { IceCandidateInit, SessionDescriptionInit } from "../core/types";
import { CallAudio, noopAudio } from "./adapters";
import { isCallError, isPolicyError, normalizeCallEvent, NormalizedCallEvent, toChatId } from "./compat";
import { resolveIceServers } from "./iceServers";
import type {
  CallAttempt,
  CallEndReason,
  CallEngineSnapshot,
  CallError,
  CallState,
  CallSummary,
  IceServersOption,
  MediaStreamLike,
  RTCPeerConnectionLike,
  StartCallOptions,
  WebRTCFactory,
} from "./types";

export const ICE_GATHER_TIMEOUT_MS = 3000;
export const OFFER_WAIT_TIMEOUT_MS = 10000;
/** Give up on a call_initiate the server never answered (so a lost reply can't leave the user stuck "in a call"). */
export const INITIATE_TIMEOUT_MS = 15000;

/** Server frames the engine consumes (the provider subscribes to exactly these). */
export const CALL_EVENT_TYPES = [
  "error",
  "incoming_call",
  "call_initiated",
  "call_ringing",
  "call_answered",
  "sdp_offer",
  "sdp_answer",
  "ice_candidate",
  "call_missed",
  "call_ended",
  "call_rejected",
] as const;

export const IDLE_CALL: CallState = {
  status: "idle",
  direction: null,
  isIncoming: false,
  isOutgoing: false,
  isActive: false,
  callType: "audio",
};

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export interface VoiceCallEngineOptions {
  /** Sends a client frame; returns false when it could not be sent. */
  send: (type: string, payload: Record<string, unknown>) => boolean;
  /** Socket open? */
  isConnected: () => boolean;
  /** Our user id (for "answered elsewhere" and peer resolution). */
  getUserId: () => string | null | undefined;
  /** WebRTC implementation, or a lazy getter. Default: none (the provider passes the stream-io loader). */
  webrtc?: WebRTCFactory | null | (() => WebRTCFactory | null);
  iceServers?: IceServersOption;
  audio?: CallAudio;
  logger?: Logger;
  iceGatherTimeoutMs?: number;
  offerWaitTimeoutMs?: number;
  initiateTimeoutMs?: number;
  /** Open + close the mic once before calling to surface permission errors early (default true). */
  testMicrophone?: boolean;
  onError?: (error: CallError, attempt: CallAttempt | null) => void;
  onCallEnded?: (summary: CallSummary) => void;
  onIncomingCall?: (call: CallState) => void;
}

type Listener = () => void;

export class VoiceCallEngine {
  private o: VoiceCallEngineOptions;
  private log: Logger;
  private audio: CallAudio;
  private snapshot: CallEngineSnapshot = {
    call: IDLE_CALL,
    isMuted: false,
    isSpeakerOn: false,
    localStream: null,
    remoteStream: null,
    lastEnded: null,
  };
  private listeners = new Set<Listener>();

  private pc: RTCPeerConnectionLike | null = null;
  private callId: string | null = null;
  private offer: SessionDescriptionInit | null = null;
  private offerWaiters: Array<(offer: SessionDescriptionInit | null) => void> = [];
  private pendingIce: IceCandidateInit[] = [];
  private accepted = false;
  /** startCall sent call_initiate; waiting for call_initiated (or an error). */
  private outgoing: CallAttempt | null = null;
  /** Outgoing call cancelled before the server assigned a call_id. */
  private pendingCancel = false;
  private endReason: CallEndReason | null = null;
  private lastAttempt: CallAttempt | null = null;
  private audioStarted = false;
  private initiateTimer: any = null;

  constructor(options: VoiceCallEngineOptions) {
    this.o = options;
    this.log = options.logger || noopLogger;
    this.audio = options.audio || noopAudio;
  }

  // ---- external store ----------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CallEngineSnapshot => this.snapshot;

  get state(): CallState {
    return this.snapshot.call;
  }

  /** Last `startCall` arguments (for "call again" / retry after a policy error). */
  get lastCallAttempt(): CallAttempt | null {
    return this.lastAttempt;
  }

  setAudio(audio: CallAudio | undefined): void {
    this.audio = audio || noopAudio;
  }

  setIceServers(iceServers: IceServersOption | undefined): void {
    this.o = { ...this.o, iceServers };
  }

  // ---- commands ----------------------------------------------------------

  async startCall(peerId: string, options: StartCallOptions = {}): Promise<boolean> {
    const attempt: CallAttempt = {
      peerId: String(peerId),
      chatId: toChatId(options.chatId),
      peerName: options.peerName,
      callType: options.callType || "audio",
      extra: options.extra,
    };
    const webrtc = this.webrtc();
    if (!webrtc) return this.fail({ kind: "unavailable", message: "Voice calling is not available on this device" }, attempt);
    if (!this.o.isConnected()) return this.fail({ kind: "not_connected", message: "Not connected to the server" }, attempt);
    if (this.snapshot.call.isActive || this.outgoing) {
      return this.fail({ kind: "already_in_call", message: "Already in a call" }, attempt);
    }
    if (this.o.testMicrophone !== false && !(await this.testMicrophone(webrtc))) {
      return this.fail({ kind: "microphone", message: "Microphone permission is required for calls" }, attempt);
    }

    this.lastAttempt = attempt;
    this.outgoing = attempt;
    this.pendingCancel = false;
    this.endReason = null;
    const sent = this.o.send("call_initiate", {
      ...(attempt.extra || {}),
      receiver_id: attempt.peerId,
      call_type: attempt.callType,
      chat_id: attempt.chatId ?? null,
    });
    if (!sent) {
      this.setOutgoing(null);
      return this.fail({ kind: "not_connected", message: "Not connected to the server" }, attempt);
    }
    // With a policy acknowledgement the server either starts the call or errors, so
    // show the calling screen right away. Otherwise wait for
    // call_initiated, so a policy prompt doesn't flash a calling screen first.
    if (attempt.extra?.credit_acknowledged) this.showOutgoing(attempt, undefined);
    this.patch({ lastEnded: null });
    this.armInitiateTimeout(attempt);
    return true;
  }

  async accept(): Promise<void> {
    const callId = this.callId;
    const webrtc = this.webrtc();
    const call = this.snapshot.call;
    if (!callId || !webrtc || this.accepted || call.direction !== "incoming") return;
    this.accepted = true;
    this.safeAudio("stopRingtone", () => this.audio.stopRingtone());
    try {
      const pc = await this.createPeerConnection(webrtc, callId);
      await this.attachLocalAudio(webrtc, pc);
      const offer = await this.waitForOffer();
      if (this.callId !== callId) return; // ended while waiting
      if (!offer) {
        this.emitError({ kind: "no_offer", message: "Could not connect the call (no offer received)", callId, peerId: call.peerId });
        this.o.send("reject_call", { call_id: callId });
        this.endReason = "failed";
        this.cleanup();
        return;
      }
      await pc.setRemoteDescription(this.wrapSdp(webrtc, offer));
      await this.flushPendingIce(webrtc);
      const answer = await pc.createAnswer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(answer);
      if (this.callId !== callId) return;
      this.o.send("sdp_answer", { call_id: callId, sdp: pc.localDescription || answer });
      this.o.send("answer_call", { call_id: callId });
      this.setConnected();
    } catch (e) {
      if (this.callId !== callId) return;
      this.log.error("accept failed", e);
      this.emitError({ kind: "media", message: "Failed to accept the call. Check microphone permissions.", callId, peerId: call.peerId });
      this.o.send("reject_call", { call_id: callId });
      this.endReason = "failed";
      this.cleanup();
    }
  }

  reject(): void {
    this.endReason = "declined";
    this.hangUp("reject_call");
  }

  end(): void {
    this.hangUp("end_call");
  }

  toggleMute(): boolean {
    return this.setMuted(!this.snapshot.isMuted);
  }

  setMuted(muted: boolean): boolean {
    const track = this.snapshot.localStream?.getAudioTracks()[0];
    if (!track) return this.snapshot.isMuted;
    track.enabled = !muted;
    this.patch({ isMuted: !track.enabled });
    return this.snapshot.isMuted;
  }

  toggleSpeaker(): boolean {
    return this.setSpeaker(!this.snapshot.isSpeakerOn);
  }

  setSpeaker(on: boolean): boolean {
    this.snapshot.remoteStream?.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    this.safeAudio("setSpeaker", () => this.audio.setSpeaker(on));
    this.patch({ isSpeakerOn: on });
    return on;
  }

  clearLastEnded(): void {
    if (this.snapshot.lastEnded) this.patch({ lastEnded: null });
  }

  /**
   * Local teardown without notifying the server (logout / provider unmount).
   * The engine stays usable afterwards (React StrictMode remounts).
   */
  dispose(): void {
    this.setOutgoing(null);
    this.pendingCancel = false;
    if (this.snapshot.call.isActive) {
      this.endReason = this.endReason || "failed";
      this.cleanup();
    }
  }

  // ---- server events -----------------------------------------------------

  /** Feed every server frame of CALL_EVENT_TYPES here. */
  async handle(raw: Record<string, any>): Promise<void> {
    if (!raw || typeof raw.type !== "string") return;
    try {
      if (raw.type === "error") return this.onError(raw);
      const ev = normalizeCallEvent(raw, this.o.getUserId());
      switch (ev.type) {
        case "incoming_call":
          return this.onIncoming(ev);
        case "call_initiated":
          return await this.onInitiated(ev);
        case "call_ringing":
          if (this.isOtherCall(ev.callId) || !this.snapshot.call.isActive) return;
          if (this.snapshot.call.status !== "connected") this.setCall({ ...this.snapshot.call, status: "ringing" });
          return;
        case "call_answered":
          return this.onAnswered(ev);
        case "sdp_offer":
          if (this.isOtherCall(ev.callId) || !ev.sdp) return;
          this.offer = ev.sdp;
          this.resolveOffer(ev.sdp);
          return;
        case "sdp_answer":
          return await this.onSdpAnswer(ev);
        case "ice_candidate":
          return await this.onIce(ev);
        case "call_missed":
        case "call_ended":
        case "call_rejected":
          return this.onTerminal(ev);
      }
    } catch (e) {
      this.log.error("call event failed", raw.type, e);
    }
  }

  private onError(raw: Record<string, any>): void {
    // Chat errors arrive on the same socket; only call errors concern us.
    if (!isCallError(raw)) return;
    const callId = raw.call_id != null ? String(raw.call_id) : null;
    if (this.isOtherCall(callId)) return;
    // Errors naming a call we already left (e.g. "Call not found" after hanging up).
    if (callId && !this.snapshot.call.isActive) return;
    const policy = isPolicyError(raw);
    const attempt = this.outgoing || this.lastAttempt;
    this.emitError(
      {
        kind: policy ? "policy" : raw.reason === "blocked" ? "blocked" : "server",
        message: String(raw.error || raw.message || "Call failed"),
        status: raw.status !== undefined && !Number.isNaN(Number(raw.status)) ? Number(raw.status) : undefined,
        callId,
        peerId: this.snapshot.call.peerId || attempt?.peerId,
        raw,
      },
      attempt,
    );
    this.setOutgoing(null);
    this.pendingCancel = false;
    this.endReason = "failed";
    this.cleanup();
  }

  private onIncoming(ev: NormalizedCallEvent): void {
    const callId = ev.callId;
    if (!callId) return;
    const current = this.snapshot.call;
    if (current.isActive && current.callId === callId) {
      // Re-sent after a reconnect: just pick up the offer if we missed it.
      if (ev.sdp && !this.offer) {
        this.offer = ev.sdp;
        this.resolveOffer(ev.sdp);
      }
      return;
    }
    if (current.isActive || this.outgoing) return; // server prevents this; never drop a live call for it
    this.resetCallRefs();
    this.callId = callId;
    this.offer = ev.sdp || null;
    this.endReason = null;
    this.patch({ lastEnded: null });
    this.setCall({
      status: "ringing",
      direction: "incoming",
      isIncoming: true,
      isOutgoing: false,
      isActive: true,
      callId,
      peerId: ev.peerId,
      peerName: ev.peerName,
      peerAvatar: ev.peerAvatar,
      chatId: ev.chatId,
      callType: ev.callType,
    });
    this.safeAudio("startRingtone", () => this.audio.startRingtone());
    try {
      this.o.onIncomingCall?.(this.snapshot.call);
    } catch (e) {
      this.log.error("onIncomingCall failed", e);
    }
  }

  private async onInitiated(ev: NormalizedCallEvent): Promise<void> {
    const callId = ev.callId;
    if (!callId) return;
    const attempt = this.outgoing;
    if (!attempt) return; // not ours (e.g. another device of this user placed it)
    this.setOutgoing(null);
    if (this.pendingCancel) {
      this.pendingCancel = false;
      this.o.send("end_call", { call_id: callId });
      return;
    }
    this.resetCallRefs();
    this.callId = callId;
    this.showOutgoing(attempt, ev);
    this.safeAudio("startRingback", () => this.audio.startRingback?.());

    const webrtc = this.webrtc();
    if (!webrtc) return;
    try {
      const pc = await this.createPeerConnection(webrtc, callId);
      await this.attachLocalAudio(webrtc, pc);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      // A complete offer lets a receiver who connects late (from a push) get every candidate.
      await this.waitForIceGathering(pc);
      if (this.callId !== callId) return; // cancelled meanwhile
      this.o.send("sdp_offer", { call_id: callId, sdp: pc.localDescription || offer });
    } catch (e) {
      if (this.callId !== callId) return;
      this.log.error("outgoing offer failed", e);
      this.emitError({ kind: "microphone", message: "Microphone permission is required for calls", callId, peerId: attempt.peerId }, attempt);
      this.o.send("end_call", { call_id: callId });
      this.endReason = "failed";
      this.cleanup();
    }
  }

  private onAnswered(ev: NormalizedCallEvent): void {
    if (this.isOtherCall(ev.callId) || !this.snapshot.call.isActive) return;
    const me = this.o.getUserId();
    if (me && ev.answererId === String(me) && !this.accepted && this.snapshot.call.direction === "incoming") {
      // Answered on another device of ours: stop ringing here.
      this.endReason = "answered_elsewhere";
      this.cleanup();
      return;
    }
    this.setConnected();
  }

  private async onSdpAnswer(ev: NormalizedCallEvent): Promise<void> {
    const webrtc = this.webrtc();
    if (this.isOtherCall(ev.callId) || !this.pc || !ev.sdp || !webrtc) return;
    await this.pc.setRemoteDescription(this.wrapSdp(webrtc, ev.sdp));
    await this.flushPendingIce(webrtc);
    // The receiver only answers after accepting; older backends never send call_answered to the caller.
    if (this.snapshot.call.isActive) this.setConnected();
  }

  private async onIce(ev: NormalizedCallEvent): Promise<void> {
    if (this.isOtherCall(ev.callId) || !ev.candidate || !this.callId) return;
    const pc = this.pc;
    const webrtc = this.webrtc();
    if (pc && pc.remoteDescription && webrtc) {
      try {
        await pc.addIceCandidate(this.wrapIce(webrtc, ev.candidate));
      } catch (e) {
        this.log.warn("addIceCandidate failed", e);
      }
    } else {
      // Still ringing (no peer connection) or no remote description yet: apply later.
      this.pendingIce.push(ev.candidate);
    }
  }

  private onTerminal(ev: NormalizedCallEvent): void {
    if (ev.isBusy && !ev.callId) {
      // Reply to our call_initiate; there is no call.
      const attempt = this.outgoing || this.lastAttempt;
      if (!this.outgoing && !this.snapshot.call.isOutgoing) return;
      this.emitError({ kind: "busy", message: "User is busy on another call", peerId: attempt?.peerId, raw: ev.raw }, attempt);
      this.setOutgoing(null);
      this.pendingCancel = false;
      this.endReason = "failed";
      this.cleanup();
      return;
    }
    if (this.isOtherCall(ev.callId) || !this.snapshot.call.isActive) return;
    this.endReason =
      ev.type === "call_rejected" ? "declined" : ev.type === "call_missed" ? "missed" : null;
    this.pendingCancel = false;
    this.cleanup();
  }

  // ---- internals ---------------------------------------------------------

  private webrtc(): WebRTCFactory | null {
    const w = this.o.webrtc;
    if (typeof w === "function") {
      try {
        return w() || null;
      } catch {
        return null;
      }
    }
    return w || null;
  }

  private setOutgoing(attempt: CallAttempt | null): void {
    this.outgoing = attempt;
    if (!attempt && this.initiateTimer) {
      clearTimeout(this.initiateTimer);
      this.initiateTimer = null;
    }
  }

  private armInitiateTimeout(attempt: CallAttempt): void {
    if (this.initiateTimer) clearTimeout(this.initiateTimer);
    this.initiateTimer = setTimeout(() => {
      this.initiateTimer = null;
      if (this.outgoing !== attempt) return;
      this.setOutgoing(null);
      this.pendingCancel = false;
      if (this.snapshot.call.isActive && !this.callId) {
        this.emitError({ kind: "server", message: "No response from the server", peerId: attempt.peerId }, attempt);
        this.endReason = "failed";
        this.cleanup();
      }
    }, this.o.initiateTimeoutMs ?? INITIATE_TIMEOUT_MS);
  }

  private fail(error: CallError, attempt: CallAttempt | null): false {
    this.emitError(error, attempt);
    return false;
  }

  private emitError(error: CallError, attempt: CallAttempt | null = this.lastAttempt): void {
    try {
      this.o.onError?.(error, attempt);
    } catch (e) {
      this.log.error("onError handler failed", e);
    }
  }

  private safeAudio(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.warn(`audio ${what} failed`, e);
    }
  }

  private isOtherCall(callId: string | null | undefined): boolean {
    return !!callId && !!this.callId && callId !== this.callId;
  }

  private patch(p: Partial<CallEngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...p };
    this.listeners.forEach((l) => l());
  }

  private setCall(next: CallState): void {
    let call = next;
    if (call.status === "connected" && !call.connectedAt) {
      call = { ...call, connectedAt: this.snapshot.call.connectedAt || Date.now() };
    }
    // Derived flags.
    call = {
      ...call,
      isIncoming: call.isActive && call.direction === "incoming" && call.status === "ringing",
      isOutgoing: call.isActive && call.direction === "outgoing" && call.status !== "connected",
    };
    this.patch({ call });
  }

  private showOutgoing(attempt: CallAttempt, ev: NormalizedCallEvent | undefined): void {
    this.setCall({
      status: "ringing",
      direction: "outgoing",
      isIncoming: false,
      isOutgoing: true,
      isActive: true,
      callId: this.callId || undefined,
      peerId: attempt.peerId || ev?.peerId,
      peerName: attempt.peerName,
      chatId: ev?.chatId ?? attempt.chatId ?? null,
      callType: ev?.callType || attempt.callType || "audio",
    });
  }

  private setConnected(): void {
    const call = this.snapshot.call;
    if (!call.isActive) return;
    if (call.status !== "connected") this.setCall({ ...call, status: "connected" });
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.safeAudio("stopRingback", () => this.audio.stopRingback?.());
      this.safeAudio("stopRingtone", () => this.audio.stopRingtone());
      this.safeAudio("start", () => this.audio.start({ speaker: this.snapshot.isSpeakerOn }));
    }
  }

  private hangUp(type: "reject_call" | "end_call"): void {
    const call = this.snapshot.call;
    if (!this.endReason) this.endReason = call.connectedAt ? "ended" : "cancelled";
    if (this.callId) {
      this.o.send(type, { call_id: this.callId });
    } else if (this.outgoing) {
      // Server hasn't answered call_initiate yet; cancel as soon as it does.
      this.pendingCancel = true;
    }
    this.cleanup();
  }

  private async testMicrophone(webrtc: WebRTCFactory): Promise<boolean> {
    try {
      const stream = await webrtc.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e) {
      this.log.warn("microphone access denied", e);
      return false;
    }
  }

  private async createPeerConnection(webrtc: WebRTCFactory, callId: string): Promise<RTCPeerConnectionLike> {
    this.closePeerConnection();
    const iceServers = await resolveIceServers(this.o.iceServers, this.log);
    if (this.callId !== callId) throw new Error("call changed while preparing");
    const pc = webrtc.createPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e?.candidate && this.callId === callId) {
        const c = e.candidate;
        this.o.send("ice_candidate", { call_id: callId, candidate: typeof c.toJSON === "function" ? c.toJSON() : c });
      }
    };
    pc.onconnectionstatechange = () => {
      this.log.debug("pc connection", pc.connectionState, "ice", pc.iceConnectionState);
    };
    pc.ontrack = (e) => {
      const stream = e?.streams?.[0];
      if (stream && this.callId === callId) this.patch({ remoteStream: stream });
    };
    this.pc = pc;
    return pc;
  }

  private async attachLocalAudio(webrtc: WebRTCFactory, pc: RTCPeerConnectionLike): Promise<MediaStreamLike> {
    const stream = await webrtc.getUserMedia({ audio: AUDIO_CONSTRAINTS });
    if (this.pc !== pc) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("call ended while opening the microphone");
    }
    this.patch({ localStream: stream });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    return stream;
  }

  private async flushPendingIce(webrtc: WebRTCFactory): Promise<void> {
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) return;
    const pending = this.pendingIce;
    this.pendingIce = [];
    for (const c of pending) {
      try {
        await pc.addIceCandidate(this.wrapIce(webrtc, c));
      } catch (e) {
        this.log.warn("pending addIceCandidate failed", e);
      }
    }
  }

  private wrapSdp(webrtc: WebRTCFactory, sdp: SessionDescriptionInit): any {
    return webrtc.sessionDescription ? webrtc.sessionDescription(sdp) : sdp;
  }

  private wrapIce(webrtc: WebRTCFactory, c: IceCandidateInit): any {
    return webrtc.iceCandidate ? webrtc.iceCandidate(c) : c;
  }

  private waitForOffer(): Promise<SessionDescriptionInit | null> {
    if (this.offer) return Promise.resolve(this.offer);
    const timeout = this.o.offerWaitTimeoutMs ?? OFFER_WAIT_TIMEOUT_MS;
    return new Promise((resolve) => {
      let done = false;
      const finish = (offer: SessionDescriptionInit | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.offerWaiters = this.offerWaiters.filter((w) => w !== finish);
        resolve(offer);
      };
      const timer = setTimeout(() => finish(this.offer), timeout);
      this.offerWaiters.push(finish);
    });
  }

  private resolveOffer(offer: SessionDescriptionInit | null): void {
    const waiters = this.offerWaiters;
    this.offerWaiters = [];
    waiters.forEach((w) => w(offer));
  }

  private waitForIceGathering(pc: RTCPeerConnectionLike): Promise<void> {
    const timeout = this.o.iceGatherTimeoutMs ?? ICE_GATHER_TIMEOUT_MS;
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const onChange = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener?.("icegatheringstatechange", onChange);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      pc.addEventListener?.("icegatheringstatechange", onChange);
    });
  }

  private closePeerConnection(): void {
    const pc = this.pc;
    this.pc = null;
    if (!pc) return;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try {
      pc.close();
    } catch (e) {
      this.log.warn("pc.close failed", e);
    }
  }

  private resetCallRefs(): void {
    this.callId = null;
    this.offer = null;
    this.pendingIce = [];
    this.accepted = false;
    this.audioStarted = false;
    this.resolveOffer(null);
  }

  /** Ends the local side of the call and reports a summary (once). */
  private cleanup(): void {
    const ended = this.snapshot.call;
    let summary: CallSummary | null = null;
    if (ended.isActive) {
      summary = {
        callId: ended.callId || this.callId || undefined,
        endReason: this.endReason || (ended.connectedAt ? "ended" : "missed"),
        outgoing: ended.direction === "outgoing",
        peerId: ended.peerId,
        peerName: ended.peerName,
        chatId: ended.chatId ?? null,
        callType: ended.callType,
        durationSeconds: ended.connectedAt ? secondsSince(ended.connectedAt) : null,
      };
    }
    this.endReason = null;
    this.safeAudio("stopRingtone", () => this.audio.stopRingtone());
    this.safeAudio("stopRingback", () => this.audio.stopRingback?.());
    this.safeAudio("stop", () => this.audio.stop());

    this.snapshot.localStream?.getTracks().forEach((t) => t.stop());
    this.snapshot.remoteStream?.getTracks().forEach((t) => t.stop());
    this.closePeerConnection();
    this.resetCallRefs();
    this.snapshot = {
      ...this.snapshot,
      call: IDLE_CALL,
      isMuted: false,
      isSpeakerOn: false,
      localStream: null,
      remoteStream: null,
      lastEnded: summary ?? this.snapshot.lastEnded,
    };
    this.listeners.forEach((l) => l());
    if (summary) {
      try {
        this.o.onCallEnded?.(summary);
      } catch (e) {
        this.log.error("onCallEnded handler failed", e);
      }
    }
  }
}
