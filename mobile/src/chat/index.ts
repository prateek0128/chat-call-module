/** commskit/chat — 1:1 chat on top of commskit/core. Never imports call. */

export { ChatProvider, useChatContext, type ChatContextValue, type ChatProviderProps } from "./ChatProvider";
export {
  useChat,
  useChatApi,
  useConversation,
  useConversations,
  useUnreadCount,
  type ReplyTarget,
  type UseConversationOptions,
  type UseConversationResult,
} from "./hooks";
export {
  CHAT_EVENT_TYPES,
  ChatStore,
  classifyMedia,
  DEFAULT_PAGE_SIZE,
  MAX_UPLOAD_BYTES,
  mergeMessage,
  normalizeMessageType,
  timestampMs,
  toDeletedMessage,
  toReplyPreview,
  TYPING_TIMEOUT_MS,
  type ChatStoreOptions,
} from "./ChatStore";
export { registerPushToken, removePushToken, startChat, type ApiConfig, type PushTokenPayload, type StartChatResponse } from "./api";
export { expoReadFileAsBase64 } from "./media";
export * from "./types";
// Call-entry rendering helpers live in core (shared with call); re-exported for convenience.
export { callLogText, formatCallDuration, friendlyDuration, parseCallEntry, type ParsedCallEntry } from "../core/callLog";
