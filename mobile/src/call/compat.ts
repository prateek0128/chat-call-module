/**
 * The ONE place the mobile kit deals with legacy call-protocol quirks (PROTOCOL §6),
 * so the engine and app code only see clean values:
 *
 * 1. Caller-side `call_initiated` / `call_ringing` put the RECEIVER in `caller_id` /
 *    `caller_name` ("caller view")       -> `peerId` is always the other person.
 * 2. `caller_name` in `call_ended` / `call_rejected` is the caller's ID
 *                                        -> names equal to an id are dropped.
 * 3. Busy is `call_rejected` with `call_id: null` (`status`/`reason` "busy")
 *                                        -> `isBusy: true`.
 *
 * Works for both the legacy and a fixed backend (it never relies on the quirk being present).
 */
import type { CallType, ChatId, IceCandidateInit, SessionDescriptionInit, UserId } from "../core/types";

export interface NormalizedCallEvent {
  type: string;
  callId: string | null;
  chatId: ChatId | null;
  callType: CallType;
  /** The other party, when it can be determined from this frame. */
  peerId?: UserId;
  /** A real display name for the peer (never an id). */
  peerName?: string;
  peerAvatar?: string;
  isBusy: boolean;
  answererId?: UserId;
  sdp?: SessionDescriptionInit;
  candidate?: IceCandidateInit;
  status?: string;
  endReason?: string;
  durationSeconds?: number | null;
  raw: Record<string, any>;
}

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === "" ? undefined : String(v));

/** A name is real when it is not one of the ids in the frame. */
const realName = (name: unknown, ids: Array<string | undefined>): string | undefined => {
  const n = str(name);
  if (!n || !n.trim()) return undefined;
  return ids.includes(n) ? undefined : n;
};

export const isBusyReply = (raw: Record<string, any>): boolean =>
  raw.status === "busy" ||
  raw.reason === "busy" ||
  (raw.type === "call_rejected" && (raw.call_id === null || raw.call_id === undefined) && raw.end_reason !== "declined");

export const normalizeCallEvent = (raw: Record<string, any>, myUserId?: string | null): NormalizedCallEvent => {
  const me = str(myUserId);
  const callerId = str(raw.caller_id);
  const receiverId = str(raw.receiver_id);
  const ids = [callerId, receiverId, str(raw.answerer_id), str(raw.rejector_id), str(raw.ended_by), me];

  let peerId: string | undefined;
  switch (raw.type) {
    case "incoming_call":
      peerId = callerId;
      break;
    case "call_initiated":
    case "call_ringing":
      // Caller side: the peer is the receiver (legacy puts it in caller_id too).
      peerId = receiverId ?? callerId;
      break;
    default:
      if (me) peerId = [callerId, receiverId].find((id) => id && id !== me);
      if (!peerId && raw.from_user_id) peerId = str(raw.from_user_id);
  }

  return {
    type: String(raw.type),
    callId: str(raw.call_id) ?? null,
    chatId: raw.chat_id === undefined || raw.chat_id === null || raw.chat_id === "" ? null : (Number(raw.chat_id) as ChatId),
    callType: raw.call_type === "video" ? "video" : "audio",
    peerId,
    // Only incoming_call carries the real caller name; elsewhere it is an id or the receiver.
    peerName: raw.type === "incoming_call" ? realName(raw.caller_name, ids) : undefined,
    peerAvatar: raw.type === "incoming_call" ? str(raw.caller_avatar) : undefined,
    isBusy: isBusyReply(raw),
    answererId: str(raw.answerer_id),
    sdp: raw.sdp || undefined,
    candidate: raw.candidate || undefined,
    status: str(raw.status),
    endReason: str(raw.end_reason),
    durationSeconds: typeof raw.duration_seconds === "number" ? raw.duration_seconds : null,
    raw,
  };
};

/** Call errors: `context:"call"`, or (older backends) credit errors tagged `info.access_type:"call"`. */
export const isCallError = (raw: Record<string, any>): boolean =>
  raw.type === "error" && (raw.context === "call" || raw.info?.access_type === "call");

/** Host policy errors (e.g. paid credits) are 402 / 403. */
export const isPolicyError = (raw: Record<string, any>): boolean => {
  const status = Number(raw.status);
  return status === 402 || status === 403;
};

/** `chat_id` given as string ("12"), number, "0" or junk -> number | null. */
export const toChatId = (value: unknown): ChatId | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
