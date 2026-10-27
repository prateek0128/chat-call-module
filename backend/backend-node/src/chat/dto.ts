/** MessageDto wire shape (PROTOCOL.md section 3). */
import { iso } from "../core/util.js";

/** Plain copy of a `messages` row with normalised types (safe to use anywhere). */
export interface MessageRow {
  id: number;
  chat_id: number;
  sender_id: string;
  content: string | null;
  message_type: string | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  thumbnail_url: string | null;
  duration: number | null;
  is_read: boolean;
  is_delivered: boolean;
  call_id: string | null;
  reply_to_id: number | null;
  created_at: unknown; // Date | string from the driver
}

export interface ReplyPreview {
  id: number;
  sender_id: string;
  content: string | null;
  message_type: string | null;
  file_name: string | null;
}

export type MessageDto = Record<string, any>;

/**
 * `sender_type` is relative to `viewerId`: "user" = me, "other" = them; "system" for
 * `message_type === "system"` (PROTOCOL.md section 9).
 */
export function messageDto(
  m: MessageRow,
  viewerId: string,
  replyTo: ReplyPreview | null | undefined = null,
  overrides: Record<string, unknown> = {},
): MessageDto {
  const senderType = m.message_type === "system" ? "system" : m.sender_id === viewerId ? "user" : "other";
  return {
    id: m.id,
    chat_id: m.chat_id,
    sender_id: m.sender_id,
    sender_type: senderType,
    content: m.content,
    message_type: m.message_type,
    timestamp: iso(m.created_at),
    file_url: m.file_url,
    file_name: m.file_name,
    file_size: m.file_size,
    file_type: m.file_type,
    thumbnail_url: m.thumbnail_url,
    duration: m.duration ? Math.trunc(m.duration) : m.duration,
    is_read: Boolean(m.is_read),
    is_delivered: Boolean(m.is_delivered),
    call_id: m.call_id,
    reply_to: replyTo ? { ...replyTo } : null,
    ...overrides,
  };
}
