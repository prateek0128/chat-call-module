/**
 * Push payload parsing (PROTOCOL §8). Pure, shared by commskit/notifications and
 * commskit/call-native (which must not depend on each other).
 *
 * Accepts every shape a push reaches JS in:
 * - an Expo `Notification` (`request.content.data`) or `NotificationResponse` (`notification.request...`)
 * - the plain `data` object (`{type: "chat", cid, ...}`)
 * - Android data-only / background-task variants where the payload is a JSON string
 *   (`{data: {body: "{\"type\":...}"}}`, `dataString`, or the string itself)
 */
import type { CallType, UserId } from "./types";

export interface ChatPushData {
  type: "chat";
  /** Conversation partner: from `cid` (`messaging:<peer>`) or `sender_id`. */
  peerId: UserId;
  chatId?: string;
  senderId?: UserId;
  cid?: string;
  raw: Record<string, unknown>;
}

export interface IncomingCallPushData {
  type: "incoming_call";
  callId: string;
  chatId?: string;
  callerId?: UserId;
  callerName?: string;
  callerAvatar?: string;
  callType: CallType;
  /** CallKit UUID (iOS VoIP pushes only). */
  uuid?: string;
  raw: Record<string, unknown>;
}

export interface MissedCallPushData {
  type: "missed_call";
  callId?: string;
  chatId?: string;
  callerId?: UserId;
  callType: CallType;
  raw: Record<string, unknown>;
}

export interface UnknownPushData {
  type: "unknown";
  raw: Record<string, unknown>;
}

export type PushData = ChatPushData | IncomingCallPushData | MissedCallPushData | UnknownPushData;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (v === null || v === undefined || v === "" ? undefined : String(v));
const looksLikePayload = (o: Obj) => typeof o.type === "string" && ("cid" in o || "call_id" in o || "sender_id" in o || "caller_id" in o);

/** Wrapper keys to look through, in order (`data` before `body`: Expo's content.body is the visible text). */
const WRAPPERS = ["notification", "request", "content", "trigger", "payload", "data", "dataString", "body", "message"];

const unwrap = (v: unknown, depth: number): Obj | null => {
  if (depth > 6 || v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t.startsWith("{")) return null;
    try {
      return unwrap(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (!isObj(v)) return null;
  if (looksLikePayload(v)) return v;
  for (const key of WRAPPERS) {
    if (v[key] == null) continue;
    const found = unwrap(v[key], depth + 1);
    if (found) return found;
  }
  return typeof v.type === "string" ? v : null;
};

/** `messaging:<peer_user_id>` -> peer id (PROTOCOL §6). */
export const peerIdFromCid = (cid: unknown): string | undefined => {
  const s = str(cid);
  if (!s) return undefined;
  const i = s.indexOf(":");
  return str(i >= 0 ? s.slice(i + 1) : s);
};

const callType = (v: unknown): CallType => (v === "video" ? "video" : "audio");

/** Normalise any push / notification shape to a typed payload; null when it carries no commskit data. */
export const parseNotificationData = (input: unknown): PushData | null => {
  const raw = unwrap(input, 0);
  if (!raw) return null;
  switch (raw.type) {
    case "chat": {
      const peerId = peerIdFromCid(raw.cid) || str(raw.sender_id);
      if (!peerId) return { type: "unknown", raw };
      return { type: "chat", peerId, chatId: str(raw.chat_id), senderId: str(raw.sender_id), cid: str(raw.cid), raw };
    }
    case "incoming_call": {
      const callId = str(raw.call_id);
      if (!callId) return { type: "unknown", raw };
      return {
        type: "incoming_call",
        callId,
        chatId: str(raw.chat_id),
        callerId: str(raw.caller_id),
        callerName: str(raw.caller_name),
        callerAvatar: str(raw.caller_avatar),
        callType: callType(raw.call_type),
        uuid: str(raw.uuid),
        raw,
      };
    }
    case "missed_call":
      return { type: "missed_call", callId: str(raw.call_id), chatId: str(raw.chat_id), callerId: str(raw.caller_id), callType: callType(raw.call_type), raw };
    default:
      return { type: "unknown", raw };
  }
};
