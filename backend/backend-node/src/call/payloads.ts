/** Call frame builders, including legacy quirks (PROTOCOL.md section 6). */
import { nowIso } from "../core/util.js";
import type { CallInfo } from "./service.js";

export function callPayload(event: string, info: CallInfo, extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    type: event,
    call_id: info.callId,
    chat_id: info.chatId,
    caller_id: info.callerId,
    receiver_id: info.receiverId,
    call_type: info.callType,
    webrtc_session_id: info.callId,
    timestamp: nowIso(),
    ...extra,
  };
}

/** Legacy: caller-side call_initiated / call_ringing carry the *receiver* in caller_id / caller_name. */
export const callerView = (info: CallInfo): Record<string, unknown> => ({
  caller_id: info.receiverId,
  caller_name: info.receiverId,
});

/** Legacy: busy is a call_rejected with call_id null. */
export function busyPayload(callerId: string, receiverId: string, callType: string): Record<string, unknown> {
  return {
    type: "call_rejected",
    call_id: null,
    status: "busy",
    reason: "busy",
    caller_id: callerId,
    receiver_id: receiverId,
    call_type: callType,
    timestamp: nowIso(),
  };
}

/** Tagged so clients only tear down call UI for call errors. */
export const callError = (error: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "error",
  error,
  ...extra,
  context: "call",
});
