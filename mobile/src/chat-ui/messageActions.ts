/** Reply, long-press actions, media duration and swipe helpers for the chat screen. Pure. */
import { isDeletedMessage, isSystemMessage, type ChatMessage, type ReplyPreview } from "../chat/types";
import { isPlaceholder, parseTimestamp } from "./format";
import type { IconName } from "../theme/iconNames";
import { isCallMessage } from "./callEntryModel";
import { attachmentLabel, mediaKindOf } from "./preview";

/** What `send` / `sendMedia` take as `replyTo` (same shape as commskit/chat `ReplyTarget`). */
export type ReplyTargetInput = Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name">;

const SNIPPET_MAX = 120;


/**
 * One-line preview of a (quoted) message: its text, else an attachment label
 * ("📷 Photo", "📎 report.pdf"), else "Message". Whitespace collapsed, trimmed to `max`.
 */
export const replySnippet = (
  m: Pick<ChatMessage, "message_type"> & Partial<Pick<ChatMessage, "content" | "file_name" | "file_type">> | Pick<ReplyPreview, "message_type" | "content" | "file_name"> | null | undefined,
  max: number = SNIPPET_MAX,
): string => {
  if (!m) return "Message";
  const text = String(m.content || "").replace(/\s+/g, " ").trim();
  const media = { message_type: m.message_type || "text", file_name: m.file_name, file_type: (m as Partial<ChatMessage>).file_type };
  const label = attachmentLabel(media);
  const real = !!text && !isPlaceholder(text) && text !== m.file_name;
  let out = real ? (mediaKindOf(media) ? `${label.split(" ")[0]} ${text}` : text) : label || text || "Message";
  return out.length > max ? `${out.slice(0, Math.max(1, max - 1)).trimEnd()}…` : out;
};

/** "You" for my own messages, else the peer's name (fallback "Them"). */
export const replySenderLabel = (m: { isMine?: boolean; sender_id?: unknown } | null | undefined, peerName?: string | null, myId?: string | null): string => {
  if (!m) return peerName || "Them";
  const mine = m.isMine !== undefined ? m.isMine : myId != null && String(m.sender_id) === String(myId);
  return mine ? "You" : peerName || "Them";
};

/** Can this message be replied to? (not call entries, not unconfirmed `temp_*` messages) */
export const canReplyTo = (m: Pick<ChatMessage, "id" | "message_type"> & Partial<Pick<ChatMessage, "pending" | "sender_type">>): boolean =>
  !isCallMessage(m) && !m.pending && !String(m.id).startsWith("temp_") && !isDeletedMessage(m) && !isSystemMessage(m);

export const toReplyTarget = (m: ChatMessage): ReplyTargetInput => ({
  id: m.id,
  sender_id: m.sender_id,
  content: m.content,
  message_type: m.message_type,
  file_name: m.file_name ?? null,
});

// ---- long-press actions ---------------------------------------------------------

export type BuiltInMessageActionKey = "reply" | "copy" | "save" | "download" | "share" | "report" | "retry" | "deleteForMe" | "deleteForEveryone";

/** Default unsend window (PROTOCOL §9 `unsend_window_seconds`): 1 hour. 0 = no limit, -1 = disabled. */
export const DEFAULT_UNSEND_WINDOW_SECONDS = 3600;

/** Server-confirmed message (not `temp_*`, not a live `call_*` entry). */
const isServerMessage = (m: Pick<ChatMessage, "id">) => !String(m.id).startsWith("temp_") && !String(m.id).startsWith("call_");

/**
 * "Delete for everyone" (unsend): my own confirmed message, not a call / system / deleted one, sent
 * within `windowSeconds` (0 = no limit, negative = disabled). Mirror the server's window.
 */
export const canDeleteForEveryone = (
  m: Pick<ChatMessage, "id" | "isMine" | "message_type" | "timestamp"> & Partial<Pick<ChatMessage, "sender_type" | "pending" | "failed">>,
  windowSeconds: number = DEFAULT_UNSEND_WINDOW_SECONDS,
  now: number = Date.now(),
): boolean => {
  if (!m.isMine || m.pending || m.failed || !isServerMessage(m)) return false;
  if (isCallMessage(m) || isSystemMessage(m) || isDeletedMessage(m)) return false;
  if (windowSeconds < 0) return false;
  if (windowSeconds === 0) return true;
  const at = parseTimestamp(m.timestamp);
  if (!at) return false;
  return now - at.getTime() <= windowSeconds * 1000;
};

/** "Delete for me": any confirmed message except call entries; failed / temp ones are dropped locally. */
export const canDeleteForMe = (m: Pick<ChatMessage, "id" | "message_type"> & Partial<Pick<ChatMessage, "pending" | "failed">>): boolean =>
  !isCallMessage(m) && (!m.pending || !!m.failed);

/** Rate-limit toast: "You're sending messages too fast. Try again in 7 s". */
export const rateLimitText = (retryAfterSeconds?: number | null): string => {
  const n = Math.ceil(Number(retryAfterSeconds));
  return Number.isFinite(n) && n > 0 ? `You're sending messages too fast. Try again in ${n} s` : "You're sending messages too fast. Try again in a moment";
};

export interface MessageAction {
  key: BuiltInMessageActionKey | (string & {});
  label: string;
  icon?: IconName;
  /** Danger colour (e.g. Report). */
  destructive?: boolean;
  /** Host actions: run with the message. Built-ins are handled by ChatScreen. */
  onPress?: (message: ChatMessage) => void;
}

export interface MessageActionAvailability {
  /** Reply is wired (ChatScreen: always). */
  reply?: boolean;
  /** expo-clipboard present (or a host copy handler). */
  copy?: boolean;
  /** Save image/video to the gallery (expo-media-library or a host adapter). */
  saveToGallery?: boolean;
  /** Download / share wired (default adapter always: falls back to Linking). */
  download?: boolean;
  share?: boolean;
  /** A ModerationProvider is mounted (incoming messages only). */
  report?: boolean;
  /** "Delete for me" (PROTOCOL §9). */
  deleteForMe?: boolean;
  /** "Delete for everyone" on own messages within `unsendWindowSeconds` (PROTOCOL §9). */
  deleteForEveryone?: boolean;
  /** Default 3600 (0 = no limit, negative = never). */
  unsendWindowSeconds?: number;
  /** Reference time (ms) for the unsend window. */
  now?: number;
  /** "Retry" on failed sends. */
  retry?: boolean;
}

/** Text worth copying: the message text, or a real caption on an attachment. */
export const copyableText = (m: Pick<ChatMessage, "content" | "message_type"> & Partial<Pick<ChatMessage, "file_name">>): string | null => {
  if (isCallMessage(m)) return null;
  const t = String(m.content || "").trim();
  if (!t || isPlaceholder(t) || (m.file_name && t === m.file_name)) return null;
  return t;
};

/**
 * Built-in long-press actions for a message, in order: Reply, Copy text, Save to gallery /
 * Download, Share, Report message, then `extra` (host actions). Items whose capability is
 * unavailable are left out.
 */
export const messageActionList = (
  m: ChatMessage,
  available: MessageActionAvailability,
  extra: readonly MessageAction[] = [],
): MessageAction[] => {
  if (isCallMessage(m)) return extra.slice();
  if (isSystemMessage(m)) return extra.slice();
  if (isDeletedMessage(m)) return available.deleteForMe ? [{ key: "deleteForMe", label: "Delete for me", destructive: true }, ...extra] : extra.slice();
  if (m.failed) {
    const failed: MessageAction[] = [];
    if (available.retry) failed.push({ key: "retry", label: "Retry" });
    if (available.copy && copyableText(m)) failed.push({ key: "copy", label: "Copy text" });
    if (available.deleteForMe) failed.push({ key: "deleteForMe", label: "Delete", destructive: true });
    return failed.concat(extra);
  }
  const out: MessageAction[] = [];
  const kind = mediaKindOf(m);
  const hasFile = !!kind && !!m.file_url && !m.pending;
  if (available.reply && canReplyTo(m)) out.push({ key: "reply", label: "Reply" });
  if (available.copy && copyableText(m)) out.push({ key: "copy", label: "Copy text" });
  if (hasFile && (kind === "image" || kind === "video") && available.saveToGallery) out.push({ key: "save", label: "Save to gallery" });
  else if (hasFile && available.download) out.push({ key: "download", label: "Download" });
  if (hasFile && available.share) out.push({ key: "share", label: "Share" });
  if (available.report && !m.isMine && canReplyTo(m)) out.push({ key: "report", label: "Report message", destructive: true });
  if (available.deleteForMe && canDeleteForMe(m) && isServerMessage(m)) out.push({ key: "deleteForMe", label: "Delete for me", destructive: true });
  if (available.deleteForEveryone && canDeleteForEveryone(m, available.unsendWindowSeconds ?? DEFAULT_UNSEND_WINDOW_SECONDS, available.now ?? Date.now())) {
    out.push({ key: "deleteForEveryone", label: "Delete for everyone", destructive: true });
  }
  return out.concat(extra);
};

// ---- media ------------------------------------------------------------------------

/**
 * Media duration: seconds -> "0:07", "1:05", "1:02:03". Values above 10 hours are taken as
 * milliseconds. Unknown / negative -> "".
 */
export const formatMediaDuration = (value: number | null | undefined): string => {
  let n = Number(value);
  if (value == null || !Number.isFinite(n) || n < 0) return "";
  if (n > 36000) n = n / 1000;
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

// ---- swipe-to-reply ---------------------------------------------------------------

/** Horizontal distance (px) that triggers a reply. */
export const SWIPE_REPLY_THRESHOLD = 56;
/** Max visual travel of the bubble. */
export const SWIPE_REPLY_MAX = 80;

/** Bubble offset for a drag of `dx` (right only, resisted after the threshold). */
export const swipeReplyOffset = (dx: number, threshold: number = SWIPE_REPLY_THRESHOLD, max: number = SWIPE_REPLY_MAX): number => {
  if (!Number.isFinite(dx) || dx <= 0) return 0;
  if (dx <= threshold) return dx;
  return Math.min(max, threshold + (dx - threshold) * 0.35);
};

export const shouldTriggerReply = (dx: number, threshold: number = SWIPE_REPLY_THRESHOLD): boolean => Number.isFinite(dx) && dx >= threshold;
