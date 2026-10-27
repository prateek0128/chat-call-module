import type { CallType, ChatId, ConversationInfoDto, UserId } from "../core/types";

export type { ConversationDto, ConversationInfoDto, MessageDto, ReplyPreviewDto } from "../core/types";

export interface ReplyPreview {
  id: number | string;
  sender_id: UserId;
  content?: string | null;
  message_type?: string | null;
  file_name?: string | null;
}

/**
 * A message as the kit stores it. Same fields as the wire `MessageDto` plus:
 * - `id` may be `temp_*` (optimistic, not yet confirmed) or `call_<callId>` (live call entry)
 * - `message_type` `audio_call` / `video_call` is normalised to `"call"` (+ `call_type`)
 * - `isMine`, `pending` convenience flags
 */
export interface ChatMessage {
  id: number | string;
  chat_id: ChatId | null;
  sender_id: UserId;
  sender_type: "user" | "other" | "system" | (string & {});
  content: string;
  message_type: string;
  timestamp: string;
  is_read: boolean;
  is_delivered: boolean;
  file_url?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  thumbnail_url?: string | null;
  duration?: number | null;
  call_id?: string | null;
  call_type?: CallType;
  reply_to?: ReplyPreview | null;
  /** Sent by this user (sender_type "user"). */
  isMine: boolean;
  /** Optimistic message waiting for the server (`temp_*`). */
  pending?: boolean;
  /**
   * The server rejected this optimistic send (`rate_limited` / `too_long`, PROTOCOL §9). The bubble
   * stays with a retry affordance (`ChatStore.retryMessage`). `failReason` is the error code.
   */
  failed?: boolean;
  failReason?: "rate_limited" | "too_long" | (string & {}) | null;
}

/** "This message was deleted" placeholder (unsent for everyone, PROTOCOL §9). */
export const isDeletedMessage = (m: Pick<ChatMessage, "message_type">): boolean => m.message_type === "deleted";

/** Server-created system message (`message_type` or `sender_type` "system", PROTOCOL §9). */
export const isSystemMessage = (m: Pick<ChatMessage, "message_type"> & Partial<Pick<ChatMessage, "sender_type" | "id">>): boolean =>
  m.message_type === "system" || (m.sender_type === "system" && m.message_type !== "call" && !String(m.id ?? "").startsWith("call_"));

export interface Conversation {
  user_id: UserId;
  username?: string | null;
  avatar?: string | null;
  status?: string;
  last_seen?: string | null;
  updated_at?: string | null;
  unread_count: number;
  last_message: ChatMessage | null;
  chat_id: ChatId | null;
  is_blocked?: boolean;
  blocked_by_other?: boolean;
}

export interface ConversationThread {
  peerId: UserId;
  chatId: ChatId | null;
  /** Newest first (ready for an inverted FlatList). */
  messages: ChatMessage[];
  /** First page requested, not answered yet. */
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** At least one `res_messages` page arrived. */
  loaded: boolean;
  /** `res_messages.info` (name, avatar, status, last_seen, block flags, host extras). */
  info: ConversationInfoDto | null;
}

export interface ChatState {
  /** Newest activity first. */
  conversations: Conversation[];
  conversationsLoaded: boolean;
  /** Keyed by peer user id. */
  threads: Record<UserId, ConversationThread>;
  /** Peer user id -> is typing (auto-cleared after 4 s). */
  typing: Record<UserId, boolean>;
  /** Conversation currently on screen (suppresses unread increments). */
  activePeerId: UserId | null;
  unreadTotal: number;
  /**
   * Epoch ms until which the server asked us to slow down (`error` code `rate_limited`,
   * `retry_after` seconds); null when not rate limited.
   */
  rateLimitedUntil: number | null;
}

/** File picked by the host (expo-image-picker / document-picker shape). */
export interface MediaFile {
  uri: string;
  name?: string;
  /** MIME type (`image/jpeg`) or picker kind (`image`). */
  type?: string;
  size?: number;
}

export type ReadFileAsBase64 = (uri: string) => Promise<string>;

export type ChatErrorKind =
  | "send_failed"
  | "too_large"
  | "read_failed"
  | "blocked"
  | "not_connected"
  | "req_users_failed"
  | "rate_limited"
  | "too_long"
  | "delete_failed"
  | "server";

export interface ChatError {
  kind: ChatErrorKind;
  message: string;
  peerId?: UserId;
  /** Raw server frame, when the error came from the server. */
  raw?: unknown;
  /** Server error code (`rate_limited`, `too_long`, `not_allowed`, `not_found`, `window_expired`). */
  code?: string;
  /** `rate_limited`: seconds to wait. */
  retryAfter?: number;
  /** `too_long`: max text length. */
  max?: number;
}
