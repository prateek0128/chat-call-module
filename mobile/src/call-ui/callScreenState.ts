/**
 * Call screen state mapping (pure): engine state / end summary / error -> what the call
 * screen shows (phase, status line, controls). DESIGN_SYSTEM.md "Call screens".
 */
import { formatCallDuration } from "../core/callLog";
import type { CallError, CallErrorKind, CallState, CallSummary } from "../call/types";

export type CallScreenPhase = "outgoing" | "incoming" | "connecting" | "active" | "ended" | "failed";

export type CallControlId = "mute" | "speaker" | "hangup" | "decline" | "accept" | "close" | "callAgain" | "message";

export interface CallScreenModel {
  phase: CallScreenPhase;
  /** Status line ("Calling…", "Ringing…", "Incoming voice call", "Connecting…", "" for active (timer), reason for failures). */
  status: string;
  /** Extra explanation under the status (microphone blocked). */
  hint: string | null;
  controls: CallControlId[];
  /** Pulse rings around the avatar (ringing / calling). */
  pulse: boolean;
  /** Show the running MM:SS timer instead of `status`. */
  showTimer: boolean;
  /** Auto-close after this many ms (ended summary), else null. */
  autoDismissMs: number | null;
  /** The screen may be minimised to a "Return to call" pill. */
  canMinimise: boolean;
  tone: "normal" | "danger";
  peerId?: string;
  peerName?: string;
  peerAvatar?: string;
  callType: "audio" | "video";
  /** Outgoing call (failure screens offer "Call again" for these). */
  outgoing: boolean;
}

export const ENDED_AUTO_DISMISS_MS = 1600;

export interface LiveCallInput {
  call: Pick<CallState, "status" | "direction" | "isActive" | "peerId" | "peerName" | "peerAvatar" | "callType" | "callId">;
  /** Accept was pressed on this device and the call is not connected yet. */
  accepted: boolean;
  /** `call_ringing` arrived for this outgoing call (callee's device is ringing). */
  ringingReceived: boolean;
  /** The platform can switch the audio output (InCallManager). */
  speakerAvailable: boolean;
}

const kindWord = (t: "audio" | "video") => (t === "video" ? "video" : "voice");

/** Screen for a call in progress, or null when there is none. */
export const mapLiveCall = ({ call, accepted, ringingReceived, speakerAvailable }: LiveCallInput): CallScreenModel | null => {
  if (!call.isActive) return null;
  const callType = call.callType === "video" ? "video" : "audio";
  const inCallControls: CallControlId[] = speakerAvailable ? ["mute", "speaker", "hangup"] : ["mute", "hangup"];
  const base = {
    hint: null,
    autoDismissMs: null,
    tone: "normal" as const,
    peerId: call.peerId,
    peerName: call.peerName,
    peerAvatar: call.peerAvatar,
    callType,
    outgoing: call.direction === "outgoing",
  } as const;
  if (call.status === "connected") {
    return { ...base, phase: "active", status: "", controls: inCallControls, pulse: false, showTimer: true, canMinimise: true };
  }
  if (call.direction === "incoming") {
    if (accepted) return { ...base, phase: "connecting", status: "Connecting…", controls: inCallControls, pulse: false, showTimer: false, canMinimise: true };
    return {
      ...base,
      phase: "incoming",
      status: `Incoming ${kindWord(callType)} call`,
      controls: ["decline", "accept"],
      pulse: true,
      showTimer: false,
      canMinimise: false,
    };
  }
  return {
    ...base,
    phase: "outgoing",
    status: ringingReceived ? "Ringing…" : "Calling…",
    controls: inCallControls,
    pulse: true,
    showTimer: false,
    canMinimise: true,
  };
};

export interface FailureCopy {
  status: string;
  hint: string | null;
  /** "Call again" makes sense for this failure (outgoing calls only). */
  retryable: boolean;
}

/** Failure reason for an error kind; null = no failure screen (the host handles it, e.g. policy prompts). */
export const failureCopy = (kind: CallErrorKind): FailureCopy | null => {
  switch (kind) {
    case "busy":
      return { status: "On another call", hint: null, retryable: true };
    case "microphone":
      return {
        status: "Microphone access is blocked",
        hint: "Allow microphone access for this app in your device Settings, then try again.",
        retryable: true,
      };
    case "unavailable":
      return { status: "Calling isn't available on this device", hint: null, retryable: false };
    case "blocked":
      return { status: "You can't call this person", hint: null, retryable: false };
    case "not_connected":
      return { status: "Couldn't connect", hint: "Check your internet connection and try again.", retryable: true };
    case "server":
    case "media":
    case "no_offer":
      return { status: "Couldn't connect", hint: null, retryable: true };
    case "policy":
    case "already_in_call":
    default:
      return null;
  }
};

export interface EndedCallInput {
  /** `useCall().lastEnded` for the call that just ended (null when the call never started). */
  summary: CallSummary | null;
  /** Error reported for this call / attempt, if any (wins over the summary's generic "failed"). */
  error: Pick<CallError, "kind" | "peerId"> | null;
  /** Peer details when there is no summary (failure before the call screen showed). */
  peerName?: string;
  peerAvatar?: string;
  /** Show "Message" (host passed onOpenChat). */
  canOpenChat?: boolean;
}

/** Screen after a call ends / fails, or null to just close (cancelled by me, declined by me, answered elsewhere, policy). */
export const mapEndedCall = ({ summary, error, peerName, peerAvatar, canOpenChat = false }: EndedCallInput): CallScreenModel | null => {
  const callType = summary?.callType === "video" ? "video" : "audio";
  const peerId = summary?.peerId || error?.peerId;
  const name = summary?.peerName || peerName;
  const base = {
    peerId,
    peerName: name,
    peerAvatar,
    callType,
    pulse: false,
    showTimer: false,
    canMinimise: false,
  } as const;
  const message: CallControlId[] = canOpenChat && peerId ? ["message"] : [];

  const failed = (copy: FailureCopy, outgoing: boolean): CallScreenModel => ({
    ...base,
    phase: "failed",
    status: copy.status,
    hint: copy.hint,
    controls: ["close", ...(copy.retryable && outgoing && peerId ? (["callAgain"] as CallControlId[]) : []), ...message],
    autoDismissMs: null,
    tone: "danger",
    outgoing,
  });

  if (error) {
    const copy = failureCopy(error.kind);
    if (!copy) return null;
    // Errors before a call existed come from startCall (outgoing); accept failures are incoming.
    const outgoing = summary ? summary.outgoing : !(error.kind === "no_offer" || error.kind === "media");
    return failed(copy, outgoing);
  }
  if (!summary) return null;

  const outgoing = summary.outgoing;
  switch (summary.endReason) {
    case "ended":
      return {
        ...base,
        phase: "ended",
        status: summary.durationSeconds != null ? `Call ended · ${formatCallDuration(summary.durationSeconds)}` : "Call ended",
        hint: null,
        controls: [],
        autoDismissMs: ENDED_AUTO_DISMISS_MS,
        tone: "normal",
        outgoing,
      };
    case "missed":
      if (outgoing) return failed({ status: "No answer", hint: null, retryable: true }, true);
      return {
        ...base,
        phase: "ended",
        status: "Missed call",
        hint: null,
        controls: [],
        autoDismissMs: ENDED_AUTO_DISMISS_MS,
        tone: "normal",
        outgoing,
      };
    case "declined":
      return outgoing ? failed({ status: "Declined", hint: null, retryable: true }, true) : null;
    case "failed":
      return failed({ status: "Couldn't connect", hint: null, retryable: true }, outgoing);
    case "cancelled":
    case "answered_elsewhere":
    default:
      return null;
  }
};

/** Accessible label for a control, given the toggles. */
export const controlLabel = (id: CallControlId, opts: { muted?: boolean; speaker?: boolean; peerName?: string } = {}): string => {
  switch (id) {
    case "mute":
      return opts.muted ? "Unmute microphone" : "Mute microphone";
    case "speaker":
      return opts.speaker ? "Turn speaker off" : "Turn speaker on";
    case "hangup":
      return "Hang up";
    case "decline":
      return "Decline call";
    case "accept":
      return "Accept call";
    case "close":
      return "Close";
    case "callAgain":
      return opts.peerName ? `Call ${opts.peerName} again` : "Call again";
    case "message":
      return opts.peerName ? `Message ${opts.peerName}` : "Message";
  }
};

/** Short visible caption under a control button. */
export const controlCaption = (id: CallControlId, opts: { muted?: boolean; speaker?: boolean } = {}): string => {
  switch (id) {
    case "mute":
      return opts.muted ? "Unmute" : "Mute";
    case "speaker":
      return "Speaker";
    case "hangup":
      return "End";
    case "decline":
      return "Decline";
    case "accept":
      return "Accept";
    case "close":
      return "Close";
    case "callAgain":
      return "Call again";
    case "message":
      return "Message";
  }
};
