/** Chat + call wiring: calls live in the chat as call-log entries. The only file importing both features. */
import { type CallChatBridge, type CallFeature, type CallInfo, callLogText } from "../call/index.js";
import { type ChatFeature, ChatService } from "../chat/index.js";
import type { Db } from "../core/db.js";

export const CALL_PLACEHOLDER = "[Call Initiated]";

/** Implements `CallChatBridge` on top of the chat tables. */
export class ChatCallBridge implements CallChatBridge {
  constructor(
    readonly chat: ChatFeature,
    readonly call: CallFeature,
  ) {}

  async resolveChatId(db: Db, callerId: string, receiverId: string, _requestedChatId: unknown): Promise<number | null> {
    // Always the pair's chat; a client-sent chat_id is never trusted.
    return (await new ChatService(db, this.call.hub.dialect).getOrCreateChat(callerId, receiverId)).id;
  }

  async onCallCreated(db: Db, info: CallInfo): Promise<void> {
    if (info.chatId === null) return;
    await new ChatService(db, this.call.hub.dialect).sendMessage(
      info.chatId,
      info.callerId,
      CALL_PLACEHOLDER,
      `${info.callType}_call`,
      { callId: info.callId },
    );
  }

  async onCallFinalizing(trx: Db, info: CallInfo): Promise<void> {
    const text = callLogText(info.status, info.isVideoCall, info.duration, info.endReason);
    info.messageId = await new ChatService(trx, this.call.hub.dialect).rewriteCallMessage(info.callId, text);
    info.logText = text;
  }

  /** `call.finalized` listener: both parties' chat entry now reads e.g. "Voice call · 05:42". */
  async sendCallLog(info: CallInfo): Promise<void> {
    if (!info.messageId) return;
    const payload = {
      type: "call_log",
      call_id: info.callId,
      chat_id: info.chatId,
      message_id: info.messageId,
      content: info.logText,
      status: info.status,
      duration_seconds: info.duration,
    };
    const hub = this.call.hub;
    await hub.send(info.callerId, payload);
    await hub.send(info.receiverId, payload);
  }
}

/** Both features must already be installed on the same hub. */
export function linkChatAndCall(chat: ChatFeature, call: CallFeature): ChatCallBridge {
  if (chat.hub !== call.hub) throw new Error("chat and call must be installed on the same CommsHub");
  if (call.chatBridge) throw new Error("call feature is already linked to a chat bridge");
  const bridge = new ChatCallBridge(chat, call);
  call.chatBridge = bridge;
  call.hub.events.on("call.finalized", (info: CallInfo) => bridge.sendCallLog(info));
  return bridge;
}
