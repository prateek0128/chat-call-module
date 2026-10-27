/** Conversation-row preview text, delivery ticks, attachment labels, header presence. Pure. */
import type { ChatMessage, Conversation } from "../chat/types";
import { isDeletedMessage, isSystemMessage } from "../chat/types";
import { describeCallEntry, isCallMessage } from "./callEntryModel";
import { isPlaceholder } from "./format";
import { headerStatus, type HeaderStatusInput } from "./lastSeen";

export type TickState = "pending" | "sent" | "delivered" | "read";

/** Delivery state of my own message; null for incoming messages and call entries. */
export const messageTicks = (m: Pick<ChatMessage, "id" | "isMine" | "pending" | "is_read" | "is_delivered" | "message_type">): TickState | null => {
  if (!m.isMine || isCallMessage(m) || isDeletedMessage(m)) return null;
  if ((m as Partial<ChatMessage>).failed) return null;
  if (m.pending || String(m.id).startsWith("temp_")) return "pending";
  if (m.is_read) return "read";
  if (m.is_delivered) return "delivered";
  return "sent";
};

export const TICK_GLYPHS: Record<TickState, string> = { pending: "…", sent: "✓", delivered: "✓✓", read: "✓✓" };
export const TICK_LABELS: Record<TickState, string> = { pending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read" };

export type MediaKind = "image" | "video" | "audio" | "file";

/** Media kind of a message (null for text and call entries). */
export const mediaKindOf = (m: Pick<ChatMessage, "message_type"> & Partial<Pick<ChatMessage, "file_type" | "file_url" | "file_name">>): MediaKind | null => {
  const t = (m.message_type || "").toLowerCase();
  if (t === "text" || t === "call" || t === "" || t === "deleted" || t === "system") return null;
  if (t === "image" || /^image\//.test(m.file_type || "")) return "image";
  if (t === "video" || /^video\//.test(m.file_type || "")) return "video";
  if (t === "audio" || t === "voice" || t === "webm" || /^audio\//.test(m.file_type || "")) return "audio";
  return "file";
};

/** "📷 Photo", "🎥 Video", "🎤 Audio", "📎 report.pdf". */
export const attachmentLabel = (m: Pick<ChatMessage, "message_type"> & Partial<Pick<ChatMessage, "file_type" | "file_name">>): string => {
  switch (mediaKindOf(m)) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎤 Audio";
    case "file":
      return `📎 ${m.file_name || "File"}`;
    default:
      return "";
  }
};

export interface ConversationPreview {
  kind: "typing" | "call" | "attachment" | "text" | "empty" | "deleted" | "system";
  /** Italic (deleted placeholder). */
  italic?: boolean;
  /** "You: " for my own messages (not for typing / call entries). */
  prefix: string;
  text: string;
  /** Ticks shown before my own last message. */
  ticks: TickState | null;
  /** Accent (typing). */
  accent: boolean;
  /** Danger (missed / declined call). */
  danger: boolean;
}

/** Priority: typing > call entry > attachment > text; "You: " + ticks for my own messages. */
export const conversationPreview = (
  conversation: Pick<Conversation, "last_message">,
  typing = false,
): ConversationPreview => {
  if (typing) return { kind: "typing", prefix: "", text: "typing…", ticks: null, accent: true, danger: false };
  const m = conversation.last_message;
  if (!m) return { kind: "empty", prefix: "", text: "", ticks: null, accent: false, danger: false };
  if (isCallMessage(m)) {
    const call = describeCallEntry(m);
    const notPickedUp = call.outcome === "missed" || call.outcome === "declined";
    const withDetail = call.live || call.outcome === "connected" || (notPickedUp && call.direction === "outgoing");
    const text = withDetail ? `${call.title} · ${call.detail}` : call.title;
    return { kind: "call", prefix: "", text, ticks: null, accent: false, danger: call.danger };
  }
  if (isDeletedMessage(m)) {
    return { kind: "deleted", prefix: "", text: m.isMine ? DELETED_MINE_TEXT : DELETED_TEXT, ticks: null, accent: false, danger: false, italic: true };
  }
  if (isSystemMessage(m)) {
    return { kind: "system", prefix: "", text: (m.content || "").replace(/\s+/g, " ").trim(), ticks: null, accent: false, danger: false };
  }
  const prefix = m.isMine ? "You: " : "";
  const ticks = messageTicks(m);
  const label = attachmentLabel(m);
  if (label) {
    // Caption (if any) after the label.
    const caption = (m.content || "").trim();
    const showCaption = caption && caption !== m.file_name && !isPlaceholder(caption);
    return { kind: "attachment", prefix, text: showCaption ? `${label} ${caption}` : label, ticks, accent: false, danger: false };
  }
  return { kind: "text", prefix, text: (m.content || "").replace(/\s+/g, " ").trim(), ticks, accent: false, danger: false };
};

/** Bubble / preview text of a message unsent for everyone. */
export const DELETED_TEXT = "This message was deleted";
export const DELETED_MINE_TEXT = "You deleted this message";

export interface PresenceLabel {
  text: string;
  tone: "accent" | "online" | "muted" | "danger";
}

/**
 * Chat header subtitle. Two-argument form (back-compat): "typing…" > "online" > "offline".
 * With `extra` (last seen, block flags, now, clock) it follows `headerStatus`:
 * "You are blocked" > "Blocked" > "typing…" > "online" > "last seen …" > "offline".
 */
export const presenceLabel = (
  typing: boolean,
  status: string | null | undefined,
  extra?: Omit<HeaderStatusInput, "typing" | "status">,
): PresenceLabel => {
  const h = headerStatus({ ...(extra || {}), typing, status });
  return { text: h.text, tone: h.tone };
};

const fold = (s: string): string => {
  let out = s;
  try {
    out = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    // engines without normalize(): plain lower-case match
  }
  return out.toLowerCase().trim();
};

/** Searchable text of a conversation's last message (text, caption or file name; not calls / deleted). */
const lastMessageText = (m: ChatMessage | null | undefined): string => {
  if (!m || isCallMessage(m) || isDeletedMessage(m)) return "";
  return [m.content, m.file_name].filter(Boolean).join(" ");
};

/**
 * Filters conversations by name OR last-message text (case- and accent-insensitive).
 * Empty query returns the input.
 */
export const filterConversations = <T extends Pick<Conversation, "username" | "user_id"> & Partial<Pick<Conversation, "last_message">>>(
  conversations: T[],
  query: string,
): T[] => {
  const q = fold(query || "");
  if (!q) return conversations;
  return conversations.filter((c) => fold(c.username || "").includes(q) || fold(lastMessageText(c.last_message)).includes(q));
};
