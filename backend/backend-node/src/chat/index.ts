/** 1:1 chat feature. Depends only on `core`. */
export { type MessageDto, type MessageRow, type ReplyPreview, messageDto } from "./dto.js";
export { type ChatConfig, ChatFeature, type ChatFeatureOptions, defaultChatConfig } from "./feature.js";
export { chatDdl } from "./models.js";
export type { ChatClearedTable, ChatTables, ChatsTable, MessageHiddenTable, MessagesTable } from "./models.js";
export { AllowAllChatPolicy, type ChatPolicy } from "./policy.js";
export { ChatActionError, type ChatRow, ChatService, DELETED_TYPE, RESERVED_TYPES, SYSTEM_TYPE } from "./service.js";
