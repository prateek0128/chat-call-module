/** Call entries inside a conversation ("Voice call · 05:42", "Missed voice call", live `call_<id>`). Pure. */
import { friendlyDuration, parseCallEntry, type ParsedCallEntry } from "../core/callLog";
import type { ChatMessage } from "../chat/types";
import type { IconName } from "../theme/iconNames";

export interface CallEntryModel {
  /** "Voice call", "Missed voice call", "Declined video call", ... */
  title: string;
  /**
   * Duration ("5 min 42 sec") for connected calls; not picked up: caller "No answer" / "Declined",
   * callee "Tap to call back"; else "Incoming" / "Outgoing" (live: "Calling…" / "Incoming").
   */
  detail: string;
  direction: "incoming" | "outgoing";
  outcome: ParsedCallEntry["outcome"];
  callType: "audio" | "video";
  /** Missed or declined on the CALLEE's side (red); the caller sees a neutral "No answer" / "Declined". */
  danger: boolean;
  /** Live entry (`call_<id>` while the call is in progress, before the call log arrives). */
  live: boolean;
  icon: IconName;
  /** "Call back" makes sense (finished calls). */
  canCallBack: boolean;
  /** Full sentence for screen readers. */
  accessibilityLabel: string;
}

export type CallEntryInput = Pick<ChatMessage, "id" | "content" | "isMine"> & Partial<Pick<ChatMessage, "call_type" | "duration">>;

export const isCallMessage = (m: Pick<ChatMessage, "message_type">): boolean => m.message_type === "call";

export const describeCallEntry = (m: CallEntryInput): CallEntryModel => {
  const parsed = parseCallEntry(m.content);
  const callType = m.call_type === "video" || parsed.callType === "video" ? "video" : "audio";
  const kind = callType === "video" ? "video" : "voice";
  const Kind = callType === "video" ? "Video" : "Voice";
  const direction = m.isMine ? "outgoing" : "incoming";
  const dirLabel = direction === "outgoing" ? "Outgoing" : "Incoming";
  const live = parsed.outcome === "unknown" && String(m.id).startsWith("call_");

  let title = `${Kind} call`;
  let detail = dirLabel;
  let danger = false;
  let icon: IconName = direction === "outgoing" ? "callOutgoing" : "callIncoming";
  switch (parsed.outcome) {
    case "connected":
      detail = parsed.seconds !== null ? friendlyDuration(parsed.seconds) : dirLabel;
      break;
    case "missed":
    case "declined":
      if (direction === "outgoing") {
        // I called, they didn't pick up: neutral wording for the caller.
        detail = parsed.outcome === "missed" ? "No answer" : "Declined";
      } else {
        title = parsed.outcome === "missed" ? `Missed ${kind} call` : `Declined ${kind} call`;
        detail = "Tap to call back";
        danger = true;
        icon = "callMissed";
      }
      break;
    case "cancelled":
      title = `Cancelled ${kind} call`;
      break;
    default:
      if (live) detail = direction === "outgoing" ? "Calling…" : "Incoming";
  }
  return {
    title,
    detail,
    direction,
    outcome: parsed.outcome,
    callType,
    danger,
    live,
    icon,
    canCallBack: !live,
    accessibilityLabel: `${title}, ${detail}`,
  };
};
