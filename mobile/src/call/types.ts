import type { CallType, ChatId, IceCandidateInit, SessionDescriptionInit, UserId } from "../core/types";

export type { CallType, IceCandidateInit, SessionDescriptionInit } from "../core/types";

// ---------------------------------------------------------------------------
// Minimal WebRTC shapes (what the engine uses). @stream-io/react-native-webrtc
// satisfies them; tests pass mocks.
// ---------------------------------------------------------------------------

export interface MediaStreamTrackLike {
  enabled: boolean;
  kind?: string;
  stop(): void;
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
  getAudioTracks(): MediaStreamTrackLike[];
  /** RN webrtc: URL for <RTCView streamURL>. */
  toURL?(): string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RTCPeerConnectionLike {
  localDescription: SessionDescriptionInit | null;
  remoteDescription: SessionDescriptionInit | null;
  iceGatheringState?: string;
  connectionState?: string;
  iceConnectionState?: string;
  onicecandidate: ((event: { candidate: any }) => void) | null;
  ontrack: ((event: { streams?: MediaStreamLike[] }) => void) | null;
  onconnectionstatechange: ((event?: any) => void) | null;
  addEventListener?(type: string, listener: (...args: any[]) => void): void;
  removeEventListener?(type: string, listener: (...args: any[]) => void): void;
  addTrack(track: MediaStreamTrackLike, stream: MediaStreamLike): unknown;
  createOffer(options?: Record<string, unknown>): Promise<SessionDescriptionInit>;
  createAnswer(options?: Record<string, unknown>): Promise<SessionDescriptionInit>;
  setLocalDescription(description: any): Promise<void>;
  setRemoteDescription(description: any): Promise<void>;
  addIceCandidate(candidate: any): Promise<void>;
  close(): void;
}

/** Injectable WebRTC implementation. Default: @stream-io/react-native-webrtc (lazily required). */
export interface WebRTCFactory {
  createPeerConnection(configuration: { iceServers: IceServer[] }): RTCPeerConnectionLike;
  getUserMedia(constraints: { audio: boolean | Record<string, unknown>; video?: boolean | Record<string, unknown> }): Promise<MediaStreamLike>;
  /** Wrap an SDP init (RTCSessionDescription). Default: pass through. */
  sessionDescription?(init: SessionDescriptionInit): any;
  /** Wrap an ICE candidate init (RTCIceCandidate). Default: pass through. */
  iceCandidate?(init: IceCandidateInit): any;
}

/** Static list, or an async provider (e.g. `turnCredentialsIceServers(...)`). */
export type IceServersOption = IceServer[] | (() => Promise<IceServer[]> | IceServer[]);

// ---------------------------------------------------------------------------
// Call state
// ---------------------------------------------------------------------------

export type CallStatus = "idle" | "ringing" | "connected";
export type CallDirection = "incoming" | "outgoing";

export interface CallState {
  status: CallStatus;
  /** Fixed for the whole call. */
  direction: CallDirection | null;
  /** Incoming and still ringing (show the incoming-call screen). */
  isIncoming: boolean;
  /** Outgoing and not connected yet (show "Calling..."). */
  isOutgoing: boolean;
  /** Any call in progress (ringing or connected). */
  isActive: boolean;
  callId?: string;
  /** Always the OTHER person (legacy "caller view" already normalised). */
  peerId?: UserId;
  peerName?: string;
  peerAvatar?: string;
  chatId?: ChatId | null;
  callType: CallType;
  /** Epoch ms when audio connected; timers and duration count from here. */
  connectedAt?: number;
}

export type CallEndReason =
  /** Hung up after connecting. */
  | "ended"
  /** No answer (or the caller gave up, from the callee's side). */
  | "missed"
  | "declined"
  /** We hung up before it connected. */
  | "cancelled"
  /** Error / busy / policy (credits) / no media. */
  | "failed"
  /** Another device of ours answered. */
  | "answered_elsewhere";

export interface CallSummary {
  callId?: string;
  endReason: CallEndReason;
  outgoing: boolean;
  peerId?: UserId;
  peerName?: string;
  chatId?: ChatId | null;
  callType: CallType;
  /** null when it never connected. */
  durationSeconds: number | null;
}

export type CallErrorKind =
  /** Host policy refused the call (e.g. credits, status 402/403). Payload in `raw`. */
  | "policy"
  /** Receiver is on another call. */
  | "busy"
  /** Other server call error (`{type:"error", context:"call"}`). */
  | "server"
  /** WebRTC module missing. */
  | "unavailable"
  | "not_connected"
  | "already_in_call"
  /** Microphone permission / capture failed. */
  | "microphone"
  /** Offer/answer negotiation failed. */
  | "media"
  /** Callee accepted but the caller's offer never arrived (10 s). */
  | "no_offer"
  /** The pair is blocked (moderation, PROTOCOL §7: `reason: "blocked"`). */
  | "blocked";

export interface CallError {
  kind: CallErrorKind;
  message: string;
  /** HTTP-like status from policy errors (402 / 403). */
  status?: number;
  callId?: string | null;
  peerId?: UserId;
  /** Raw server frame for server-originated errors (credit info lives in `raw.info`). */
  raw?: Record<string, unknown>;
}

/** What `startCall` was called with; used to retry after a policy error. */
export interface CallAttempt {
  peerId: UserId;
  chatId?: ChatId | null;
  peerName?: string;
  callType?: CallType;
  /** Extra host fields merged into `call_initiate` (e.g. `{credit_acknowledged: true}`). */
  extra?: Record<string, unknown>;
}

export interface StartCallOptions {
  chatId?: ChatId | string | null;
  peerName?: string;
  callType?: CallType;
  extra?: Record<string, unknown>;
}

export interface CallEngineSnapshot {
  call: CallState;
  isMuted: boolean;
  isSpeakerOn: boolean;
  localStream: MediaStreamLike | null;
  remoteStream: MediaStreamLike | null;
  /** Summary of the last finished call (for an "ended" screen); cleared on the next call. */
  lastEnded: CallSummary | null;
}
