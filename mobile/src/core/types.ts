/**
 * Shared wire types (docs/archive/PROTOCOL.md v1). Used by core, chat and call.
 * Field names are exactly what goes over the socket.
 */

export type UserId = string;
export type ChatId = number;

/** Every frame is a JSON object with a string `type`. */
export interface WireMessage {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Core / presence (§2)
// ---------------------------------------------------------------------------

export type PresenceStatus = "online" | "offline" | "away";

export interface UserStatusEvent {
  type: "user_status";
  user_id: UserId;
  status: PresenceStatus;
  timestamp?: string;
}

/** Server sends `PONG` (legacy upper case); the client delivers it as `pong`. */
export interface PongEvent {
  type: "pong";
  timestamp?: string;
}

/** Generic error frame. `context:"call"` marks call errors (§1). */
export interface ErrorEvent {
  type: "error";
  error?: string;
  context?: string;
  call_id?: string | null;
  status?: number | string;
  message?: string;
  info?: Record<string, unknown> & { access_type?: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Chat (§3)
// ---------------------------------------------------------------------------

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "document"
  | "webm"
  | "audio_call"
  | "video_call"
  | (string & {});

export interface ReplyPreviewDto {
  id: number | string;
  sender_id: UserId;
  content?: string | null;
  message_type?: string | null;
  file_name?: string | null;
}

export interface MessageDto {
  id: number | string;
  chat_id: ChatId;
  sender_id: UserId;
  /** Relative to the receiver of the frame: "user" = me, "other" = them. */
  sender_type: "user" | "other" | (string & {});
  content: string | null;
  message_type: MessageType;
  timestamp: string;
  file_url?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  file_type?: string | null;
  thumbnail_url?: string | null;
  duration?: number | null;
  is_read?: boolean;
  is_delivered?: boolean;
  call_id?: string | null;
  reply_to?: ReplyPreviewDto | null;
}

export interface ConversationDto {
  user_id: UserId;
  username?: string | null;
  avatar?: string | null;
  status?: PresenceStatus | string;
  updated_at?: string | null;
  unread_count?: number;
  last_message?: MessageDto | null;
  chat_id?: ChatId | null;
  is_blocked?: boolean;
  blocked_by_other?: boolean;
}

export interface ConversationInfoDto {
  user_id: UserId;
  username?: string | null;
  avatar?: string | null;
  status?: string;
  last_seen?: string | null;
  chat_consent_given?: boolean | null;
  is_blocked?: boolean;
  blocked_by_other?: boolean;
  [key: string]: unknown;
}

export interface ResUsersEvent {
  type: "res_users";
  users: ConversationDto[];
}
export interface ReqUsersErrorEvent {
  type: "req_users_error";
  error: string;
}
export interface ResMessagesEvent {
  type: "res_messages";
  messages: MessageDto[];
  offset?: number;
  has_more?: boolean;
  info?: ConversationInfoDto;
}
/** `message` wrapper; legacy servers may send the DTO flat (see ChatStore). */
export interface NewMessageEvent {
  type: "new_message";
  message: MessageDto;
}
export interface MessageSentEvent {
  type: "message_sent";
  message: MessageDto;
}
export interface MediaUploadSuccessEvent {
  type: "media_upload_success";
  message: MessageDto;
}
export interface ChatReadEvent {
  type: "chat_read";
  chat_id: ChatId;
}
export interface MessagesReadEvent {
  type: "messages_read";
  chat_id: ChatId;
  read_by?: UserId;
}
export interface DeliveryStatusEvent {
  type: "delivery_status";
  chat_id: ChatId;
  message_ids: Array<number | string>;
  status: "delivered";
  timestamp?: string;
}
export interface TypingStatusEvent {
  type: "typing_status";
  user_id: UserId;
  chat_id?: ChatId | null;
  is_typing: boolean;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Call (§4)
// ---------------------------------------------------------------------------

export type CallType = "audio" | "video";

export interface SessionDescriptionInit {
  type: string;
  sdp?: string;
}
export interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  [key: string]: unknown;
}

/** Base payload of server call events. `call_id` is null only for the busy reply. */
export interface CallEventBase {
  call_id: string | null;
  chat_id?: ChatId | null;
  caller_id?: UserId;
  receiver_id?: UserId;
  call_type?: CallType;
  webrtc_session_id?: string;
  timestamp?: string;
  status?: string;
  caller_name?: string;
  caller_avatar?: string | null;
}

export interface CallInitiatedEvent extends CallEventBase {
  type: "call_initiated";
}
export interface IncomingCallEvent extends CallEventBase {
  type: "incoming_call";
  sdp?: SessionDescriptionInit;
}
export interface CallRingingEvent extends CallEventBase {
  type: "call_ringing";
}
export interface CallAnsweredEvent extends CallEventBase {
  type: "call_answered";
  answerer_id?: UserId;
}
export interface CallRejectedEvent extends CallEventBase {
  type: "call_rejected";
  end_reason?: string;
  duration_seconds?: number | null;
  rejector_id?: UserId;
  reason?: string;
}
export interface CallEndedEvent extends CallEventBase {
  type: "call_ended";
  end_reason?: string;
  ended_by?: UserId;
  duration_seconds?: number | null;
}
export interface CallMissedEvent extends CallEventBase {
  type: "call_missed";
  end_reason?: string;
}
export interface SdpEvent {
  type: "sdp_offer" | "sdp_answer";
  call_id: string;
  from_user_id?: UserId;
  sdp: SessionDescriptionInit;
  timestamp?: string;
}
export interface IceCandidateEvent {
  type: "ice_candidate";
  call_id: string;
  from_user_id?: UserId;
  candidate: IceCandidateInit;
  timestamp?: string;
}
export interface CallLogEvent {
  type: "call_log";
  call_id: string;
  chat_id?: ChatId | null;
  message_id?: number | string | null;
  content: string;
  status?: string;
  duration_seconds?: number | null;
  /** Set on the client-side fallback the call provider dispatches locally. */
  local?: boolean;
}

/** Server -> client events the kit understands, by `type`. */
export interface ServerEventMap {
  user_status: UserStatusEvent;
  pong: PongEvent;
  error: ErrorEvent;
  res_users: ResUsersEvent;
  req_users_error: ReqUsersErrorEvent;
  res_messages: ResMessagesEvent;
  new_message: NewMessageEvent;
  message_sent: MessageSentEvent;
  media_upload_success: MediaUploadSuccessEvent;
  chat_read: ChatReadEvent;
  messages_read: MessagesReadEvent;
  delivery_status: DeliveryStatusEvent;
  typing_status: TypingStatusEvent;
  call_initiated: CallInitiatedEvent;
  incoming_call: IncomingCallEvent;
  call_ringing: CallRingingEvent;
  call_answered: CallAnsweredEvent;
  call_rejected: CallRejectedEvent;
  call_ended: CallEndedEvent;
  call_missed: CallMissedEvent;
  sdp_offer: SdpEvent;
  sdp_answer: SdpEvent;
  ice_candidate: IceCandidateEvent;
  call_log: CallLogEvent;
}

/** Client -> server payloads (without `type`). */
export interface ClientEventMap {
  ping: Record<string, never>;
  user_status: { status: "online" | "away" };
  req_users: Record<string, never>;
  get_messages: { chat_id?: ChatId | null; candidate_user_id?: UserId; offset?: number; limit?: number };
  send_message: {
    candidate_user_id: UserId;
    content: string;
    message_type?: string;
    reply_to_id?: number | string;
    chat_id?: ChatId | null;
  };
  mark_read: { chat_id?: ChatId | null; candidate_user_id?: UserId };
  typing: { target_user_id: UserId; is_typing: boolean; chat_id?: ChatId | null };
  media_upload: {
    target_user_id: UserId;
    file_name: string;
    file_data: string;
    file_type?: string;
    media_type?: string;
    reply_to_id?: number | string;
  };
  call_initiate: { receiver_id: UserId; call_type?: CallType; chat_id?: ChatId | null; [hostField: string]: unknown };
  answer_call: { call_id: string };
  reject_call: { call_id: string };
  end_call: { call_id: string };
  sdp_offer: { call_id: string; sdp: SessionDescriptionInit };
  sdp_answer: { call_id: string; sdp: SessionDescriptionInit };
  ice_candidate: { call_id: string; candidate: IceCandidateInit };
  start_recording: { call_id: string };
}
