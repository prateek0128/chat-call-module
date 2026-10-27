/**
 * ChatStore — framework-free chat state machine (PROTOCOL §3 + call entries).
 * No React, no react-native: plug it into anything with `subscribe` / `getSnapshot`
 * (React: `useSyncExternalStore`). The ChatProvider feeds it server frames via
 * `handle(message)` and gives it a `send` function.
 *
 * Behaviour:
 * - optimistic `temp_*` messages replaced by `message_sent`
 * - `mergeMessage`: ticks never go backwards (sent -> delivered -> read)
 * - unread +1 for incoming messages unless that chat is the active one
 * - typing auto-clears after 4 s
 * - pagination with limit 10, `hasMore = has_more !== false && page.length === limit`
 * - call entries: `call_<id>` placeholders from call_* events, rewritten by `call_log`
 * - PROTOCOL §9 extras: `message_deleted` (placeholder / removal), `chat_cleared`, system
 *   messages, `rate_limited` / `too_long` errors (optimistic message kept as `failed`, retryable)
 */

import { UserDirectory } from "../core/userDirectory";
import type {
  CallType,
  ChatId,
  ConversationDto,
  ConversationInfoDto,
  MessageDto,
  UserId,
} from "../core/types";
import type {
  ChatError,
  ChatMessage,
  ChatState,
  Conversation,
  ConversationThread,
  MediaFile,
  ReadFileAsBase64,
  ReplyPreview,
} from "./types";
import { isSystemMessage } from "./types";

export const DEFAULT_PAGE_SIZE = 10;
export const TYPING_TIMEOUT_MS = 4000;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface ChatStoreOptions {
  /** Sends a client frame; returns false when it could not be sent. */
  send: (type: string, payload: Record<string, unknown>) => boolean;
  /** Whether a send would go out now (avoids reading big files while offline). */
  canSend?: () => boolean;
  /** Current user id (sender_type is used first; this is a fallback). */
  getUserId?: () => string | null | undefined;
  users?: UserDirectory;
  readFileAsBase64?: ReadFileAsBase64;
  onError?: (error: ChatError) => void;
  pageSize?: number;
  typingTimeoutMs?: number;
  maxUploadBytes?: number;
  /** Send `mark_read` when a message arrives in the active, open conversation (default true). */
  autoMarkReadActive?: boolean;
}

/** Server frame types the store consumes (the provider subscribes to exactly these). */
export const CHAT_EVENT_TYPES = [
  "res_users",
  "req_users_error",
  "res_messages",
  "new_message",
  "message_sent",
  "media_upload_success",
  "chat_read",
  "messages_read",
  "delivery_status",
  "typing_status",
  "user_status",
  "error",
  "call_log",
  // PROTOCOL §9 chat extras
  "message_deleted",
  "chat_cleared",
  // PROTOCOL §7 (moderation feature): keep the block flags of conversations current.
  "user_blocked",
  "user_unblocked",
  "blocked_by_user",
  "unblocked_by_user",
  "call_initiated",
  "incoming_call",
  "call_ringing",
  "call_answered",
  "call_ended",
  "call_rejected",
  "call_missed",
] as const;

const CALL_ENTRY_EVENTS = new Set([
  "call_initiated",
  "incoming_call",
  "call_answered",
  "call_ended",
  "call_rejected",
  "call_missed",
]);

const isTempId = (id: unknown) => String(id).startsWith("temp_");
const isLocalCallId = (id: unknown) => String(id).startsWith("call_");
const isServerId = (id: unknown) => !isTempId(id) && !isLocalCallId(id);
const sameId = (a: unknown, b: unknown) => String(a) === String(b);

/** Epoch ms of a server timestamp; naive ISO strings (no zone) are UTC. NaN when invalid. */
export const timestampMs = (ts: string | number | null | undefined): number => {
  if (ts == null || ts === "") return NaN;
  if (typeof ts === "number") return ts;
  let s = String(ts).trim();
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/.exec(s);
  if (naive) s = `${naive[1]}T${naive[2].length === 5 ? `${naive[2]}:00` : naive[2]}${naive[3] ? naive[3].slice(0, 4) : ""}Z`;
  else s = s.replace(/(\.\d{3})\d+/, "$1");
  return new Date(s).getTime();
};

/** "This message was deleted" placeholder for a message unsent for everyone (PROTOCOL §9). */
export const toDeletedMessage = (m: ChatMessage): ChatMessage => ({
  ...m,
  message_type: "deleted",
  content: "",
  file_url: null,
  file_name: null,
  file_type: null,
  file_size: null,
  thumbnail_url: null,
  duration: null,
  reply_to: null,
  pending: false,
  failed: false,
});

/** Same message seen again: keep newer fields, never let ticks go backwards. */
export const mergeMessage = (existing: ChatMessage, incoming: ChatMessage): ChatMessage => ({
  ...existing,
  ...incoming,
  is_delivered: !!(existing.is_delivered || incoming.is_delivered || existing.is_read || incoming.is_read),
  is_read: !!(existing.is_read || incoming.is_read),
});

/** Stored call entries are "audio_call" / "video_call"; the kit exposes "call" + call_type. */
export const normalizeMessageType = (type?: string | null): { message_type: string; call_type?: CallType } => {
  const t = (type || "text").toLowerCase();
  if (t === "audio_call") return { message_type: "call", call_type: "audio" };
  if (t === "video_call") return { message_type: "call", call_type: "video" };
  if (t === "call") return { message_type: "call", call_type: "audio" };
  return { message_type: t };
};

export const toReplyPreview = (m: Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name">): ReplyPreview => ({
  id: m.id,
  sender_id: m.sender_id,
  content: m.content,
  message_type: m.message_type,
  file_name: m.file_name ?? null,
});

/** picker type / MIME -> (wire media_type, kit message_type) */
export const classifyMedia = (fileType?: string): { mediaType: string; messageType: string } => {
  const t = (fileType || "").toLowerCase();
  if (t === "image" || t.startsWith("image/")) return { mediaType: "photos", messageType: "image" };
  if (t === "video" || t.startsWith("video/")) return { mediaType: "videos", messageType: "video" };
  if (t === "audio" || t.startsWith("audio/")) return { mediaType: "audios", messageType: "audio" };
  return { mediaType: "documents", messageType: "document" };
};

const EMPTY_THREAD = (peerId: UserId, chatId: ChatId | null = null): ConversationThread => ({
  peerId,
  chatId,
  messages: [],
  loading: false,
  loadingMore: false,
  hasMore: true,
  loaded: false,
  info: null,
});

interface PendingSend {
  tempId: string;
  peerId: UserId;
  media: boolean;
  content: string;
}

interface RetryInfo {
  peerId: UserId;
  text?: string;
  file?: MediaFile;
  replyTo?: Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name"> | null;
}

type Listener = () => void;

export class ChatStore {
  private state: ChatState = {
    conversations: [],
    conversationsLoaded: false,
    threads: {},
    typing: {},
    activePeerId: null,
    unreadTotal: 0,
    rateLimitedUntil: null,
  };
  private listeners = new Set<Listener>();
  private opts: Required<Pick<ChatStoreOptions, "pageSize" | "typingTimeoutMs" | "maxUploadBytes" | "autoMarkReadActive">> &
    ChatStoreOptions;
  private chatToPeer = new Map<string, UserId>();
  private pending: PendingSend[] = [];
  private openCounts = new Map<UserId, number>();
  private typingTimers = new Map<UserId, any>();
  private serverCallLogs = new Set<string>();
  private usersRequested = false;
  private tempSeq = 0;
  /** What to resend for an optimistic message (kept until it is confirmed). */
  private retryInfo = new Map<string, RetryInfo>();
  /** clear_chat sent for a peer whose chat id is unknown (chat_cleared names the chat id only). */
  private pendingClears: UserId[] = [];

  constructor(options: ChatStoreOptions) {
    // `undefined` options (ChatProvider forwards its optional props as-is) must not erase the defaults.
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as unknown as ChatStoreOptions;
    this.opts = {
      pageSize: DEFAULT_PAGE_SIZE,
      typingTimeoutMs: TYPING_TIMEOUT_MS,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      autoMarkReadActive: true,
      ...given,
    };
  }

  // ---- external store ----------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChatState => this.state;

  getThread(peerId: UserId): ConversationThread | undefined {
    return this.state.threads[peerId];
  }

  getConversation(peerId: UserId): Conversation | undefined {
    return this.state.conversations.find((c) => c.user_id === peerId);
  }

  /** Inject the reader later (ChatProvider passes the default lazily). */
  setReadFileAsBase64(reader: ReadFileAsBase64 | undefined): void {
    this.opts.readFileAsBase64 = reader;
  }

  // ---- commands ----------------------------------------------------------

  /** Called by the provider whenever the socket (re)opens. */
  onConnected(): void {
    this.refreshConversations();
    // Re-fetch every conversation that is on screen (messages may have arrived meanwhile).
    this.openCounts.forEach((count, peerId) => {
      if (count > 0) this.fetchMessages(peerId);
    });
  }

  refreshConversations(): boolean {
    const ok = this.opts.send("req_users", {});
    if (ok) this.usersRequested = true;
    return ok;
  }

  /**
   * A screen shows the conversation with `peerId`. Fetches the first page and
   * (optionally) marks it read. Returns the matching close function.
   */
  openConversation(peerId: UserId, options: { chatId?: ChatId | null; markRead?: boolean } = {}): () => void {
    const peer = String(peerId);
    if (options.chatId != null) this.linkChat(options.chatId, peer);
    const wasOpen = (this.openCounts.get(peer) || 0) > 0;
    this.openCounts.set(peer, (this.openCounts.get(peer) || 0) + 1);
    this.ensureThread(peer, options.chatId ?? null);
    this.fetchMessages(peer);
    if (!wasOpen && options.markRead !== false) this.markRead(peer);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (this.openCounts.get(peer) || 1) - 1;
      if (n <= 0) this.openCounts.delete(peer);
      else this.openCounts.set(peer, n);
    };
  }

  /** First page (offset 0). */
  fetchMessages(peerId: UserId): boolean {
    const thread = this.ensureThread(peerId);
    const ok = this.opts.send("get_messages", {
      chat_id: thread.chatId,
      candidate_user_id: peerId,
      offset: 0,
      limit: this.opts.pageSize,
    });
    this.patchThread(peerId, { loading: ok && !thread.loaded, hasMore: thread.loaded ? thread.hasMore : true });
    return ok;
  }

  /** Next (older) page. No-op while a page is loading or nothing is left. */
  loadMore(peerId: UserId): boolean {
    const thread = this.state.threads[peerId];
    if (!thread || thread.loadingMore || !thread.hasMore || !thread.loaded) return false;
    const offset = thread.messages.filter((m) => isServerId(m.id)).length;
    const ok = this.opts.send("get_messages", {
      chat_id: thread.chatId,
      candidate_user_id: peerId,
      offset,
      limit: this.opts.pageSize,
    });
    if (ok) this.patchThread(peerId, { loadingMore: true });
    return ok;
  }

  sendText(peerId: UserId, text: string, replyTo?: Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name"> | null): boolean {
    const content = text;
    if (!content || !content.trim()) return false;
    if (this.isBlocked(peerId)) {
      this.emitError({ kind: "blocked", message: "Cannot send: this conversation is blocked", peerId });
      return false;
    }
    const thread = this.ensureThread(peerId);
    const payload: Record<string, unknown> = {
      candidate_user_id: peerId,
      chat_id: thread.chatId,
      message_type: "text",
      content,
    };
    // Only real (server) ids can be quoted, not optimistic temp ones.
    if (replyTo && isServerId(replyTo.id)) payload.reply_to_id = replyTo.id;
    if (!this.opts.send("send_message", payload)) {
      this.emitError({ kind: "not_connected", message: "Not connected", peerId });
      return false;
    }
    const temp = this.makeTemp(peerId, {
      content,
      message_type: "text",
      reply_to: replyTo ? toReplyPreview(replyTo) : null,
    });
    this.pending.push({ tempId: String(temp.id), peerId, media: false, content });
    this.retryInfo.set(String(temp.id), { peerId, text: content, replyTo: replyTo ?? null });
    this.prependMessage(peerId, temp);
    this.updateConversationLast(peerId, temp, { bumpUnread: false });
    return true;
  }

  async sendMedia(
    peerId: UserId,
    file: MediaFile,
    replyTo?: Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name"> | null,
  ): Promise<boolean> {
    if (!file?.uri) return false;
    if (this.isBlocked(peerId)) {
      this.emitError({ kind: "blocked", message: "Cannot send: this conversation is blocked", peerId });
      return false;
    }
    if (this.opts.canSend && !this.opts.canSend()) {
      this.emitError({ kind: "not_connected", message: "Not connected", peerId });
      return false;
    }
    const reader = this.opts.readFileAsBase64;
    if (!reader) {
      this.emitError({ kind: "read_failed", message: "No readFileAsBase64 configured", peerId });
      return false;
    }
    const fileName = file.name || file.uri.split("/").pop() || "file";
    const { mediaType, messageType } = classifyMedia(file.type);
    this.ensureThread(peerId);

    // Show it right away (uploading); replaced when the server confirms.
    const temp = this.makeTemp(peerId, {
      content: fileName,
      message_type: messageType,
      file_url: file.uri,
      file_name: fileName,
      file_type: file.type ?? null,
      file_size: file.size ?? null,
      reply_to: replyTo ? toReplyPreview(replyTo) : null,
    });
    const tempId = String(temp.id);
    this.prependMessage(peerId, temp);
    const dropTemp = () => {
      this.removeMessage(peerId, tempId);
      this.pending = this.pending.filter((p) => p.tempId !== tempId);
    };

    let base64: string;
    try {
      base64 = await reader(file.uri);
    } catch (e) {
      dropTemp();
      this.emitError({ kind: "read_failed", message: `Could not read file: ${String((e as Error)?.message || e)}`, peerId });
      return false;
    }
    // base64 length * 3/4 ~ raw bytes; authoritative even when the picker omits `size`.
    const approxBytes = Math.floor((base64.length * 3) / 4);
    const size = typeof file.size === "number" ? file.size : approxBytes;
    if (size > this.opts.maxUploadBytes || approxBytes > this.opts.maxUploadBytes) {
      dropTemp();
      this.emitError({
        kind: "too_large",
        message: `File is larger than ${Math.round(this.opts.maxUploadBytes / (1024 * 1024))} MB`,
        peerId,
      });
      return false;
    }
    const payload: Record<string, unknown> = {
      target_user_id: peerId,
      media_type: mediaType,
      file_name: fileName,
      file_type: file.type,
      file_data: base64,
    };
    if (replyTo && isServerId(replyTo.id)) payload.reply_to_id = replyTo.id;
    if (!this.opts.send("media_upload", payload)) {
      dropTemp();
      this.emitError({ kind: "not_connected", message: "Not connected", peerId });
      return false;
    }
    this.pending.push({ tempId, peerId, media: true, content: fileName });
    this.retryInfo.set(tempId, { peerId, file, replyTo: replyTo ?? null });
    return true;
  }

  markRead(peerId: UserId): boolean {
    const thread = this.ensureThread(peerId);
    const conv = this.getConversation(peerId);
    const chatId = thread.chatId ?? conv?.chat_id ?? null;
    const ok = this.opts.send("mark_read", { chat_id: chatId, candidate_user_id: peerId });
    if (conv && conv.unread_count) this.patchConversation(peerId, { unread_count: 0 });
    return ok;
  }

  setTyping(peerId: UserId, isTyping: boolean): boolean {
    const chatId = this.state.threads[peerId]?.chatId ?? this.getConversation(peerId)?.chat_id ?? null;
    return this.opts.send("typing", { target_user_id: peerId, chat_id: chatId, is_typing: isTyping });
  }

  /** The conversation on screen (null = none). Incoming messages there don't bump unread. */
  setActiveChat(peerId: UserId | null): void {
    if (this.state.activePeerId === peerId) return;
    this.commit({ ...this.state, activePeerId: peerId });
  }

  /**
   * Delete a message (PROTOCOL §9 `delete_message`). Unconfirmed / failed optimistic messages are
   * just dropped locally. "For me" hides it right away; "for everyone" (unsend) waits for the
   * server's `message_deleted` (it may answer `window_expired` / `not_allowed`).
   */
  deleteMessage(peerId: UserId, messageId: ChatMessage["id"], options: { forEveryone?: boolean } = {}): boolean {
    const peer = String(peerId);
    if (!isServerId(messageId)) {
      this.dropLocal(peer, String(messageId));
      return true;
    }
    const forEveryone = !!options.forEveryone;
    const ok = this.opts.send("delete_message", { message_id: messageId, for_everyone: forEveryone });
    if (!ok) {
      this.emitError({ kind: "not_connected", message: "Not connected", peerId: peer });
      return false;
    }
    if (!forEveryone) this.removeMessage(peer, String(messageId));
    return true;
  }

  /** Clear this chat for me (PROTOCOL §9 `clear_chat`); applied when `chat_cleared` arrives. */
  clearChat(peerId: UserId): boolean {
    const peer = String(peerId);
    const chatId = this.state.threads[peer]?.chatId ?? this.getConversation(peer)?.chat_id ?? null;
    const ok = this.opts.send("clear_chat", chatId != null ? { chat_id: chatId, candidate_user_id: peer } : { candidate_user_id: peer });
    if (!ok) {
      this.emitError({ kind: "not_connected", message: "Not connected", peerId: peer });
      return false;
    }
    if (chatId == null) this.pendingClears.push(peer);
    return true;
  }

  /** Resend a `failed` optimistic message (rate limited / too long). False when it can't be retried. */
  retryMessage(peerId: UserId, messageId: ChatMessage["id"]): boolean | Promise<boolean> {
    const peer = String(peerId);
    const id = String(messageId);
    const info = this.retryInfo.get(id);
    const msg = this.state.threads[peer]?.messages.find((m) => sameId(m.id, id));
    if (!info || !msg || !msg.failed) return false;
    this.dropLocal(peer, id);
    if (info.file) return this.sendMedia(peer, info.file, info.replyTo);
    return this.sendText(peer, info.text || msg.content, info.replyTo);
  }

  /** Host extensions (block / consent ...) can patch the conversation info. */
  updateInfo(peerId: UserId, patch: Partial<ConversationInfoDto>): void {
    const thread = this.ensureThread(peerId);
    this.patchThread(peerId, { info: { ...(thread.info || { user_id: peerId }), ...patch } as ConversationInfoDto });
    const convPatch: Partial<Conversation> = {};
    if ("is_blocked" in patch) convPatch.is_blocked = !!patch.is_blocked;
    if ("blocked_by_other" in patch) convPatch.blocked_by_other = !!patch.blocked_by_other;
    if (Object.keys(convPatch).length) this.patchConversation(peerId, convPatch);
  }

  removeConversation(peerId: UserId): void {
    this.setConversations(this.state.conversations.filter((c) => c.user_id !== peerId));
  }

  /** Logout: forget everything. */
  reset(): void {
    this.typingTimers.forEach((t) => clearTimeout(t));
    this.typingTimers.clear();
    this.chatToPeer.clear();
    this.pending = [];
    this.serverCallLogs.clear();
    this.retryInfo.clear();
    this.pendingClears = [];
    this.usersRequested = false;
    this.commit({
      conversations: [],
      conversationsLoaded: false,
      threads: {},
      typing: {},
      activePeerId: this.state.activePeerId,
      unreadTotal: 0,
      rateLimitedUntil: null,
    });
  }

  dispose(): void {
    this.typingTimers.forEach((t) => clearTimeout(t));
    this.typingTimers.clear();
    this.listeners.clear();
  }

  // ---- server events -----------------------------------------------------

  handle(message: { type: string }): void {
    const data = message as any;
    switch (data.type) {
      case "res_users":
        return this.onResUsers(data.users);
      case "req_users_error":
        this.usersRequested = false;
        return this.emitError({ kind: "req_users_failed", message: String(data.error || "req_users failed"), raw: data });
      case "res_messages":
        return this.onResMessages(data);
      case "new_message":
      case "message_sent":
      case "media_upload_success":
        // Legacy servers may send the DTO flat instead of {message}.
        return this.onMessage(data.type, (data.message || data) as MessageDto);
      case "chat_read":
        return this.onChatRead(data.chat_id);
      case "messages_read":
        return this.onMessagesRead(data.chat_id);
      case "delivery_status":
        return this.onDelivered(data.chat_id, data.message_ids || []);
      case "typing_status":
        return this.onTyping(String(data.user_id), !!data.is_typing);
      case "user_status":
        return this.onUserStatus(data);
      case "error":
        return this.onServerError(data);
      case "call_log":
        return this.onCallLog(data);
      case "message_deleted":
        return this.onMessageDeleted(data);
      case "chat_cleared":
        return this.onChatCleared(data);
      case "user_blocked":
      case "user_unblocked":
      case "blocked_by_user":
      case "unblocked_by_user": {
        const peer = data.candidate_user_id ?? data.user_id;
        if (peer == null) return;
        const on = data.type === "user_blocked" || data.type === "blocked_by_user";
        if (!this.getConversation(String(peer)) && !this.state.threads[String(peer)]) return;
        return this.updateInfo(String(peer), data.type.endsWith("_by_user") ? { blocked_by_other: on } : { is_blocked: on });
      }
      default:
        if (CALL_ENTRY_EVENTS.has(data.type)) return this.onCallEvent(data);
    }
  }

  private onResUsers(users: ConversationDto[] | undefined): void {
    this.usersRequested = false;
    if (!Array.isArray(users)) return;
    this.opts.users?.remember(users);
    const me = this.me();
    const conversations: Conversation[] = users.map((u) => {
      const id = String(u.user_id);
      if (u.chat_id != null) this.linkChat(u.chat_id, id);
      return {
        user_id: id,
        username: u.username ?? null,
        avatar: u.avatar ?? null,
        status: u.status,
        updated_at: u.updated_at ?? null,
        unread_count: Number(u.unread_count || 0),
        last_message: u.last_message ? this.toMessage(u.last_message, me) : null,
        chat_id: u.chat_id ?? null,
        is_blocked: u.is_blocked,
        blocked_by_other: u.blocked_by_other,
      };
    });
    // The open conversation was just read: don't resurrect its badge.
    const active = this.state.activePeerId;
    const fixed = active
      ? conversations.map((c) => (c.user_id === active && c.unread_count ? { ...c, unread_count: 0 } : c))
      : conversations;
    // Threads learn their chat ids.
    let threads = this.state.threads;
    for (const c of fixed) {
      const t = threads[c.user_id];
      if (t && t.chatId == null && c.chat_id != null) threads = { ...threads, [c.user_id]: { ...t, chatId: c.chat_id } };
    }
    this.commit({ ...this.state, threads, conversations: fixed, conversationsLoaded: true, unreadTotal: sumUnread(fixed) });
  }

  private onResMessages(data: any): void {
    const info: ConversationInfoDto | undefined = data.info;
    const page: MessageDto[] = Array.isArray(data.messages) ? data.messages : [];
    const peerId = info?.user_id != null ? String(info.user_id) : this.peerForChat(page[0]?.chat_id);
    if (!peerId) return;
    if (info) this.opts.users?.remember([info]);
    const me = this.me();
    const incoming = page.map((m) => this.toMessage(m, me));
    const chatId = page.find((m) => m.chat_id != null)?.chat_id ?? this.state.threads[peerId]?.chatId ?? null;
    if (chatId != null) this.linkChat(chatId, peerId);
    const thread = this.ensureThread(peerId, chatId);
    const offset = Number(data.offset || 0);
    const isLoadingMore = offset > 0;

    const incomingById = new Map(incoming.map((m) => [String(m.id), m]));
    const storedCallIds = new Set(incoming.map((m) => m.call_id).filter(Boolean) as string[]);
    let messages: ChatMessage[];
    if (isLoadingMore) {
      const merged = thread.messages.map((m) => {
        const inc = incomingById.get(String(m.id));
        return inc ? mergeMessage(m, inc) : m;
      });
      const existing = new Set(thread.messages.map((m) => String(m.id)));
      messages = [...merged, ...incoming.filter((m) => !existing.has(String(m.id)))];
    } else {
      // Fresh load: drop optimistic temps (a lingering temp would duplicate the real
      // message) and live call entries that now have their stored message.
      const liveCalls = thread.messages.filter(
        (m) => isLocalCallId(m.id) && !storedCallIds.has(String(m.id).slice("call_".length)),
      );
      const existingById = new Map(thread.messages.map((m) => [String(m.id), m]));
      const pageMerged = incoming.map((m) => {
        const ex = existingById.get(String(m.id));
        return ex ? mergeMessage(ex, m) : m;
      });
      const older = thread.messages.filter((m) => isServerId(m.id) && !incomingById.has(String(m.id)));
      // Failed sends stay (with their retry) until retried or deleted.
      const failed = thread.messages.filter((m) => m.failed && isTempId(m.id));
      messages = [...failed, ...liveCalls, ...pageMerged, ...older];
      this.pending = this.pending.filter((p) => p.peerId !== peerId);
    }
    const hasMore = data.has_more !== false && incoming.length === this.opts.pageSize;
    this.patchThread(peerId, {
      chatId: thread.chatId ?? chatId,
      messages,
      loading: false,
      loadingMore: false,
      loaded: true,
      hasMore: isLoadingMore || !thread.loaded ? hasMore : thread.hasMore && hasMore,
      info: info ? { ...(thread.info || {}), ...info } : thread.info,
    });
    if (info) {
      const patch: Partial<Conversation> = {};
      if (info.is_blocked !== undefined) patch.is_blocked = info.is_blocked;
      if (info.blocked_by_other !== undefined) patch.blocked_by_other = info.blocked_by_other;
      if (Object.keys(patch).length) this.patchConversation(peerId, patch);
    }
  }

  private onMessage(type: string, dto: MessageDto): void {
    if (!dto || (dto.chat_id == null && dto.sender_id == null)) return;
    const me = this.me();
    const msg = this.toMessage(dto, me);
    const peerId = this.peerForMessage(msg, type);
    if (!peerId) {
      // Unknown chat (e.g. first message of a new conversation): refresh the list.
      this.requestUsersOnce();
      return;
    }
    if (msg.chat_id != null) this.linkChat(msg.chat_id, peerId);
    const thread = this.ensureThread(peerId, msg.chat_id);

    // Same message already shown (history got it first): update it in place.
    if (thread.messages.some((m) => sameId(m.id, msg.id))) {
      this.patchThread(peerId, {
        chatId: thread.chatId ?? msg.chat_id,
        messages: thread.messages.map((m) => (sameId(m.id, msg.id) ? mergeMessage(m, msg) : m)),
      });
    } else {
      let messages = thread.messages;
      if (msg.isMine) {
        const tempId = this.takePending(peerId, msg);
        if (tempId) {
          const temp = messages.find((m) => sameId(m.id, tempId));
          // Keep the local preview while the server copy has no URL yet.
          const replaced: ChatMessage = temp
            ? { ...msg, file_url: msg.file_url || temp.file_url, reply_to: msg.reply_to ?? temp.reply_to ?? null }
            : msg;
          messages = messages.filter((m) => !sameId(m.id, tempId));
          messages = [replaced, ...messages];
        } else {
          messages = [msg, ...messages];
        }
      } else {
        messages = [msg, ...messages];
      }
      this.patchThread(peerId, { chatId: thread.chatId ?? msg.chat_id, messages });
    }

    if (type === "media_upload_success") return; // message_sent follows
    const isActive = this.state.activePeerId === peerId;
    const known = this.updateConversationLast(peerId, msg, { bumpUnread: !msg.isMine && !isActive });
    if (!known) this.requestUsersOnce();
    if (!msg.isMine && isActive && this.opts.autoMarkReadActive && (this.openCounts.get(peerId) || 0) > 0) {
      this.markRead(peerId);
    }
  }

  private onChatRead(chatId: ChatId): void {
    const peerId = this.peerForChat(chatId);
    const conversations = this.state.conversations.map((c) =>
      (c.chat_id != null && sameId(c.chat_id, chatId)) || (peerId && c.user_id === peerId)
        ? { ...c, unread_count: 0 }
        : c,
    );
    this.setConversations(conversations);
  }

  /** Read receipt: the peer read our messages in this chat -> blue ticks. */
  private onMessagesRead(chatId: ChatId): void {
    const peerId = this.peerForChat(chatId);
    const read = (m: ChatMessage): ChatMessage =>
      m.isMine && (!m.is_read || !m.is_delivered) ? { ...m, is_read: true, is_delivered: true } : m;
    if (peerId && this.state.threads[peerId]) {
      const t = this.state.threads[peerId];
      this.patchThread(peerId, { messages: t.messages.map(read) });
    }
    const conversations = this.state.conversations.map((c) =>
      c.last_message && ((c.chat_id != null && sameId(c.chat_id, chatId)) || c.user_id === peerId)
        ? { ...c, last_message: read(c.last_message) }
        : c,
    );
    this.setConversations(conversations);
  }

  private onDelivered(chatId: ChatId, ids: Array<number | string>): void {
    const set = new Set(ids.map(String));
    if (!set.size) return;
    const deliver = (m: ChatMessage) => (set.has(String(m.id)) && !m.is_delivered ? { ...m, is_delivered: true } : m);
    let threads = this.state.threads;
    for (const peerId of Object.keys(threads)) {
      const t = threads[peerId];
      if (chatId != null && t.chatId != null && !sameId(t.chatId, chatId)) continue;
      const messages = t.messages.map(deliver);
      if (messages.some((m, i) => m !== t.messages[i])) threads = { ...threads, [peerId]: { ...t, messages } };
    }
    const conversations = this.state.conversations.map((c) =>
      c.last_message && set.has(String(c.last_message.id)) ? { ...c, last_message: deliver(c.last_message) } : c,
    );
    this.commit({ ...this.state, threads, conversations });
  }

  private onTyping(userId: UserId, isTyping: boolean): void {
    const prevTimer = this.typingTimers.get(userId);
    if (prevTimer) clearTimeout(prevTimer);
    this.typingTimers.delete(userId);
    if (isTyping) {
      this.typingTimers.set(
        userId,
        setTimeout(() => {
          this.typingTimers.delete(userId);
          if (this.state.typing[userId]) this.commit({ ...this.state, typing: { ...this.state.typing, [userId]: false } });
        }, this.opts.typingTimeoutMs),
      );
    }
    if (!!this.state.typing[userId] === isTyping) return;
    this.commit({ ...this.state, typing: { ...this.state.typing, [userId]: isTyping } });
  }

  private onUserStatus(data: { user_id: string; status: string; timestamp?: string }): void {
    const userId = String(data.user_id);
    const offlineAt = data.status === "online" ? undefined : data.timestamp || new Date().toISOString();
    const conversations = this.state.conversations.map((c) =>
      c.user_id === userId ? { ...c, status: data.status, last_seen: offlineAt ?? c.last_seen } : c,
    );
    let threads = this.state.threads;
    const t = threads[userId];
    if (t?.info) {
      threads = {
        ...threads,
        [userId]: { ...t, info: { ...t.info, status: data.status, last_seen: offlineAt ?? t.info.last_seen } },
      };
    }
    this.commit({ ...this.state, conversations, threads });
  }

  private onServerError(data: any): void {
    // Call errors belong to the call feature.
    if (data.context === "call" || data.info?.access_type === "call") return;
    const text = String(data.error || data.message || "Server error");
    const code = typeof data.code === "string" ? data.code : undefined;
    if (code === "rate_limited" || code === "too_long") {
      const retryAfter = Number(data.retry_after);
      // Sends are answered in order: the oldest pending one is the rejected one.
      const failed = this.pending.shift();
      if (failed) this.markFailed(failed, code);
      if (code === "rate_limited") {
        const secs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1;
        this.commit({ ...this.state, rateLimitedUntil: Date.now() + secs * 1000 });
      }
      this.emitError({
        kind: code,
        code,
        message: text,
        raw: data,
        peerId: failed?.peerId,
        ...(code === "rate_limited" && Number.isFinite(retryAfter) ? { retryAfter } : {}),
        ...(code === "too_long" && data.max != null ? { max: Number(data.max) } : {}),
      });
      return;
    }
    if (code === "not_allowed" || code === "not_found" || code === "window_expired") {
      this.emitError({ kind: "delete_failed", code, message: text, raw: data });
      return;
    }
    const isSendError = /send|blocked|too large|upload|server error/i.test(text);
    if (isSendError && this.pending.length) {
      // A send failed: drop the optimistic messages so they don't sit "pending" forever.
      const failed = this.pending;
      const peers = new Set(failed.map((p) => p.peerId));
      this.pending = [];
      failed.forEach((p) => this.removeMessage(p.peerId, p.tempId));
      this.emitError({ kind: "send_failed", message: text, raw: data, peerId: peers.size === 1 ? Array.from(peers)[0] : undefined });
      return;
    }
    this.emitError({ kind: "server", message: text, raw: data });
  }

  /** PROTOCOL §9: for everyone -> placeholder; for me -> removed. */
  private onMessageDeleted(data: { chat_id?: ChatId | null; message_id?: number | string; for_everyone?: boolean }): void {
    if (data?.message_id == null) return;
    const id = String(data.message_id);
    let peerId = this.peerForChat(data.chat_id);
    if (!peerId || !this.state.threads[peerId]?.messages.some((m) => sameId(m.id, id))) {
      peerId =
        Object.keys(this.state.threads).find((p) => this.state.threads[p].messages.some((m) => sameId(m.id, id))) ??
        this.state.conversations.find((c) => c.last_message && sameId(c.last_message.id, id))?.user_id ??
        peerId;
    }
    if (!peerId) return;
    this.retryInfo.delete(id);
    if (!data.for_everyone) {
      this.removeMessage(peerId, id);
      return;
    }
    const t = this.state.threads[peerId];
    if (t) this.patchThread(peerId, { messages: t.messages.map((m) => (sameId(m.id, id) ? toDeletedMessage(m) : m)) });
    const conv = this.getConversation(peerId);
    if (conv?.last_message && sameId(conv.last_message.id, id)) this.patchConversation(peerId, { last_message: toDeletedMessage(conv.last_message) });
  }

  /** PROTOCOL §9: everything up to `cleared_at` is gone for me; preview + unread reset. */
  private onChatCleared(data: { chat_id?: ChatId | null; cleared_at?: string }): void {
    let peerId = this.peerForChat(data?.chat_id);
    if (!peerId && this.pendingClears.length) peerId = this.pendingClears.shift();
    else if (peerId) this.pendingClears = this.pendingClears.filter((p) => p !== peerId);
    if (!peerId) return;
    if (data.chat_id != null) this.linkChat(data.chat_id, peerId);
    const cutoff = timestampMs(data.cleared_at ?? null);
    const keep = (m: ChatMessage) => {
      if (isTempId(m.id)) return true; // still being sent
      if (!Number.isFinite(cutoff)) return false;
      const at = timestampMs(m.timestamp);
      return Number.isFinite(at) && at > cutoff;
    };
    const t = this.state.threads[peerId];
    let remaining: ChatMessage[] = [];
    if (t) {
      remaining = t.messages.filter(keep);
      t.messages.filter((m) => !keep(m)).forEach((m) => this.retryInfo.delete(String(m.id)));
      this.patchThread(peerId, {
        messages: remaining,
        hasMore: remaining.some((m) => isServerId(m.id)) ? t.hasMore : false,
        chatId: t.chatId ?? data.chat_id ?? null,
      });
    }
    const conv = this.getConversation(peerId);
    if (conv) {
      const last = conv.last_message && keep(conv.last_message) ? conv.last_message : remaining[0] || null;
      this.patchConversation(peerId, { last_message: last, unread_count: 0 });
    }
  }

  /** A finished call: its chat entry now shows e.g. "Voice call · 05:42". */
  private onCallLog(log: { call_id?: string; message_id?: number | string | null; content?: string; local?: boolean; chat_id?: ChatId | null }): void {
    if (!log?.call_id || !log.content) return;
    const callId = String(log.call_id);
    if (log.local) {
      if (this.serverCallLogs.has(callId)) return; // the server's version wins
    } else {
      this.serverCallLogs.add(callId);
    }
    const matches = (m?: ChatMessage | null): m is ChatMessage =>
      !!m &&
      (sameId(m.id, `call_${callId}`) ||
        m.call_id === callId ||
        (log.message_id != null && sameId(m.id, log.message_id)));
    const update = (m: ChatMessage): ChatMessage => ({
      ...m,
      content: log.content as string,
      message_type: "call",
      call_id: callId,
      id: log.message_id != null ? log.message_id : m.id,
    });
    let threads = this.state.threads;
    for (const peerId of Object.keys(threads)) {
      const t = threads[peerId];
      if (t.messages.some(matches)) {
        threads = { ...threads, [peerId]: { ...t, messages: t.messages.map((m) => (matches(m) ? update(m) : m)) } };
      }
    }
    const conversations = this.state.conversations.map((c) =>
      matches(c.last_message) ? { ...c, last_message: update(c.last_message) } : c,
    );
    this.commit({ ...this.state, threads, conversations });
  }

  /** call_* events become a `call_<id>` entry in a loaded conversation. */
  private onCallEvent(data: any): void {
    if (!data.call_id) return; // busy reply (call_id null) is not a chat entry
    const me = this.me();
    const callId = String(data.call_id);
    let peerId = data.chat_id != null ? this.peerForChat(data.chat_id) : undefined;
    if (!peerId) {
      const ids = [data.caller_id, data.receiver_id].filter((x) => x != null).map(String);
      peerId = me ? ids.find((id) => id !== me) : undefined;
      // Caller-side events carry the receiver (legacy "caller view" or not).
      if (!peerId && (data.type === "call_initiated" || data.type === "call_ringing")) peerId = data.receiver_id ?? data.caller_id;
      if (!peerId && data.type === "incoming_call") peerId = data.caller_id;
    }
    if (!peerId) return;
    peerId = String(peerId);
    if (data.chat_id != null) this.linkChat(data.chat_id, peerId);
    const thread = this.state.threads[peerId];
    if (!thread || !thread.loaded) return; // history will include the stored entry
    if (thread.messages.some((m) => sameId(m.id, `call_${callId}`) || m.call_id === callId)) return;

    let senderId = "system";
    let senderType: ChatMessage["sender_type"] = "system";
    if (data.type === "call_initiated") {
      senderId = me || "me";
      senderType = "user";
    } else if (data.type === "incoming_call") {
      senderId = String(data.caller_id || peerId);
      senderType = "other";
    }
    const entry: ChatMessage = {
      id: `call_${callId}`,
      chat_id: data.chat_id ?? thread.chatId ?? null,
      sender_id: senderId,
      sender_type: senderType,
      content: "[Call Initiated]",
      message_type: "call",
      call_type: data.call_type === "video" ? "video" : "audio",
      call_id: callId,
      is_read: false,
      is_delivered: true,
      timestamp: new Date().toISOString(),
      isMine: senderType === "user",
    };
    this.prependMessage(peerId, entry);
  }

  // ---- helpers -----------------------------------------------------------

  private me(): string | null {
    const id = this.opts.getUserId?.();
    return id ? String(id) : null;
  }

  private toMessage(m: MessageDto, me: string | null): ChatMessage {
    const { message_type, call_type } = normalizeMessageType(m.message_type);
    const senderType = m.sender_type || (message_type === "system" ? "system" : me && String(m.sender_id) === me ? "user" : "other");
    // System messages are never mine (sender_id may even be my id: "You matched with Asha").
    const system = message_type === "system" || (senderType === "system" && message_type !== "call");
    return {
      id: m.id ?? `${m.chat_id}_${Date.now()}`,
      chat_id: m.chat_id ?? null,
      sender_id: String(m.sender_id),
      sender_type: senderType,
      content: m.content ?? "",
      message_type,
      ...(call_type ? { call_type } : {}),
      call_id: m.call_id ?? null,
      reply_to: m.reply_to ?? null,
      // History / confirmations come from the server: delivered unless it says otherwise.
      is_read: m.is_read === true,
      is_delivered: m.is_delivered !== false,
      timestamp: m.timestamp || new Date().toISOString(),
      file_url: m.file_url ?? null,
      file_name: m.file_name ?? null,
      file_type: m.file_type ?? null,
      file_size: m.file_size ?? null,
      thumbnail_url: m.thumbnail_url ?? null,
      duration: m.duration ?? null,
      isMine: !system && (senderType === "user" || (!!me && String(m.sender_id) === me && senderType !== "other")),
    };
  }

  private makeTemp(peerId: UserId, fields: Partial<ChatMessage>): ChatMessage {
    this.tempSeq += 1;
    return {
      id: `temp_${Date.now()}_${this.tempSeq}`,
      chat_id: this.state.threads[peerId]?.chatId ?? null,
      sender_id: this.me() || "me",
      sender_type: "user",
      content: "",
      message_type: "text",
      is_read: false,
      is_delivered: false,
      timestamp: new Date().toISOString(),
      isMine: true,
      pending: true,
      ...fields,
    };
  }

  /** Which optimistic message does this confirmation replace? */
  private takePending(peerId: UserId, msg: ChatMessage): string | undefined {
    const isMedia = msg.message_type !== "text";
    const candidates = this.pending.filter((p) => p.peerId === peerId && p.media === isMedia);
    const exact = isMedia ? candidates[0] : candidates.find((p) => p.content === msg.content) || candidates[0];
    if (!exact) return undefined;
    this.pending = this.pending.filter((p) => p !== exact);
    this.retryInfo.delete(exact.tempId);
    return exact.tempId;
  }

  private peerForChat(chatId: unknown): UserId | undefined {
    if (chatId == null) return undefined;
    const known = this.chatToPeer.get(String(chatId));
    if (known) return known;
    const conv = this.state.conversations.find((c) => c.chat_id != null && sameId(c.chat_id, chatId));
    if (conv) return conv.user_id;
    const peer = Object.keys(this.state.threads).find((p) => {
      const t = this.state.threads[p];
      return t.chatId != null && sameId(t.chatId, chatId);
    });
    return peer;
  }

  private peerForMessage(msg: ChatMessage, type: string): UserId | undefined {
    if (isSystemMessage(msg)) return this.peerForChat(msg.chat_id) ?? (type === "new_message" ? msg.sender_id : undefined);
    if (!msg.isMine && type === "new_message") return msg.sender_id;
    const byChat = this.peerForChat(msg.chat_id);
    if (byChat) return byChat;
    if (!msg.isMine) return msg.sender_id;
    // First message to a new chat: the oldest pending send of the same kind.
    const isMedia = msg.message_type !== "text";
    return this.pending.find((p) => p.media === isMedia)?.peerId;
  }

  private linkChat(chatId: ChatId, peerId: UserId): void {
    this.chatToPeer.set(String(chatId), String(peerId));
  }

  private isBlocked(peerId: UserId): boolean {
    const info = this.state.threads[peerId]?.info;
    const conv = this.getConversation(peerId);
    return !!(info?.is_blocked || info?.blocked_by_other || conv?.is_blocked || conv?.blocked_by_other);
  }

  private requestUsersOnce(): void {
    if (this.usersRequested) return;
    this.refreshConversations();
  }

  private ensureThread(peerId: UserId, chatId: ChatId | null = null): ConversationThread {
    const existing = this.state.threads[peerId];
    if (existing) {
      if (existing.chatId == null && chatId != null) {
        const t = { ...existing, chatId };
        this.commit({ ...this.state, threads: { ...this.state.threads, [peerId]: t } });
        return t;
      }
      return existing;
    }
    const conv = this.getConversation(peerId);
    const t = EMPTY_THREAD(peerId, chatId ?? conv?.chat_id ?? null);
    this.commit({ ...this.state, threads: { ...this.state.threads, [peerId]: t } });
    return t;
  }

  private patchThread(peerId: UserId, patch: Partial<ConversationThread>): void {
    const t = this.ensureThread(peerId);
    this.commit({ ...this.state, threads: { ...this.state.threads, [peerId]: { ...t, ...patch } } });
  }

  private prependMessage(peerId: UserId, msg: ChatMessage): void {
    const t = this.ensureThread(peerId);
    this.patchThread(peerId, { messages: [msg, ...t.messages] });
  }

  private removeMessage(peerId: UserId, id: string): void {
    const t = this.state.threads[peerId];
    if (!t) return;
    const conv = this.getConversation(peerId);
    this.patchThread(peerId, { messages: t.messages.filter((m) => !sameId(m.id, id)) });
    if (conv?.last_message && sameId(conv.last_message.id, id)) {
      const next = this.state.threads[peerId].messages[0] || null;
      this.patchConversation(peerId, { last_message: next });
    }
  }

  /** Drop an optimistic message and everything the store remembers about it. */
  private dropLocal(peerId: UserId, id: string): void {
    this.pending = this.pending.filter((p) => p.tempId !== id);
    this.retryInfo.delete(id);
    this.removeMessage(peerId, id);
  }

  private markFailed(p: PendingSend, reason: string): void {
    const t = this.state.threads[p.peerId];
    if (!t) return;
    const mark = (m: ChatMessage): ChatMessage => (sameId(m.id, p.tempId) ? { ...m, pending: false, failed: true, failReason: reason } : m);
    this.patchThread(p.peerId, { messages: t.messages.map(mark) });
    const conv = this.getConversation(p.peerId);
    if (conv?.last_message && sameId(conv.last_message.id, p.tempId)) this.patchConversation(p.peerId, { last_message: mark(conv.last_message) });
  }

  private patchConversation(peerId: UserId, patch: Partial<Conversation>): void {
    if (!this.state.conversations.some((c) => c.user_id === peerId)) return;
    this.setConversations(this.state.conversations.map((c) => (c.user_id === peerId ? { ...c, ...patch } : c)));
  }

  /** Latest message + move to top (WhatsApp style). Returns false if the chat is not in the list. */
  private updateConversationLast(peerId: UserId, msg: ChatMessage, { bumpUnread }: { bumpUnread: boolean }): boolean {
    const list = this.state.conversations;
    const idx = list.findIndex((c) => c.user_id === peerId || (msg.chat_id != null && c.chat_id != null && sameId(c.chat_id, msg.chat_id)));
    if (idx === -1) return false;
    const target = list[idx];
    const updated: Conversation = {
      ...target,
      chat_id: target.chat_id ?? msg.chat_id,
      last_message: msg,
      updated_at: msg.timestamp,
      unread_count: bumpUnread ? (target.unread_count || 0) + 1 : target.unread_count || 0,
    };
    this.setConversations([updated, ...list.filter((_, i) => i !== idx)]);
    return true;
  }

  private setConversations(conversations: Conversation[]): void {
    this.commit({ ...this.state, conversations, unreadTotal: sumUnread(conversations) });
  }

  private emitError(error: ChatError): void {
    try {
      this.opts.onError?.(error);
    } catch {
      /* host callback errors are not ours */
    }
  }

  private commit(next: ChatState): void {
    this.state = next;
    this.listeners.forEach((l) => l());
  }
}

const sumUnread = (list: Conversation[]) => list.reduce((n, c) => n + (c.unread_count || 0), 0);
