/** Chat WebSocket handlers (PROTOCOL.md sections 3 and 9). Port of commskit.chat.handlers. */
import { UploadRejected, deleteMedia } from "../core/adapters.js";
import type { SocketLike } from "../core/connections.js";
import type { Db } from "../core/db.js";
import type { CommsHub } from "../core/hub.js";
import { logger } from "../core/logger.js";
import { detectMediaType } from "../core/media.js";
import { type RateLimit, retryAfterSeconds } from "../core/ratelimit.js";
import { LRU, codePointLength, iso, nowIso, pyBool, pyStr, truncateCodePoints } from "../core/util.js";
import { type MessageDto, type MessageRow, type ReplyPreview, messageDto } from "./dto.js";
import type { ChatFeature } from "./feature.js";
import { ChatActionError, ChatService, DELETED_TYPE, RESERVED_TYPES, SYSTEM_TYPE, type ChatRow, otherOf } from "./service.js";

export const ATTACHMENT_PREVIEW = "\u{1F4CE} Attachment"; // "📎 Attachment"

const errorFrame = (error: string, extra: Record<string, unknown> = {}) => ({ type: "error", error, ...extra });

/** Python `int()` for JSON values; throws like Python on garbage. */
function pyInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(value)}`);
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  try {
    return pyInt(value);
  } catch {
    return null;
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ChatHandlers {
  private hub: CommsHub;
  private pairChatIds = new LRU<string, number>(20000);

  constructor(private feature: ChatFeature) {
    this.hub = feature.hub;
  }

  get config() {
    return this.feature.config;
  }

  // Read on every use: integrations (e.g. moderation) may wrap feature.policy after install.
  get policy() {
    return this.feature.policy;
  }

  service(db: Db): ChatService {
    return new ChatService(db, this.hub.dialect);
  }

  register(): void {
    const on = (t: string, fn: (u: string, m: Record<string, any>, db: Db) => Promise<void>) => this.hub.on(t, fn.bind(this));
    on("req_users", this.reqUsers);
    on("get_messages", this.getMessages);
    on("send_message", this.sendMessage);
    on("mark_read", this.markRead);
    on("typing", this.typing);
    on("media_upload", this.mediaUpload);
    on("delete_message", this.deleteMessage);
    on("clear_chat", this.clearChat);
  }

  forgetUser(userId: string): void {
    this.pairChatIds.discardWhere((pair) => pair.split("\u0000").includes(userId));
  }

  private reply(userId: string, payload: unknown): Promise<boolean> {
    return this.hub.send(userId, payload);
  }

  private async failed(userId: string, message: unknown, err: unknown, error: string): Promise<void> {
    logger.error(`${(message as any)?.type ?? "chat handler"} failed`, err);
    await this.hub.reportHandlerError(userId, message, err);
    await this.reply(userId, errorFrame(error));
  }

  /** Seconds to wait (0 = allowed). Takes a token when allowed. */
  private async rateLimited(userId: string, action: string, limit: RateLimit | null | undefined): Promise<number> {
    if (!limit) return 0;
    return this.hub.rateLimiter.hit(`${action}:${userId}`, limit);
  }

  // ---------------------------------------------------------------- lists

  async reqUsers(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    try {
      const convs = (await this.service(db).getConversations(userId)).filter((c) => c.other_user_id !== userId);
      const otherIds = convs.map((c) => c.other_user_id);
      const profiles = await this.hub.profiles(otherIds);
      const online = otherIds.length ? await this.hub.connections.getOnlineUsers(otherIds) : new Set<string>();
      const blocks = otherIds.length ? await this.policy.blockStatus(db, userId, otherIds) : {};

      const users = convs.map((conv) => {
        const other = conv.other_user_id;
        const profile = profiles[other];
        const last = conv.last_message;
        const [isBlocked, blockedByOther] = blocks[other] ?? [false, false];
        return {
          user_id: other,
          username: profile?.name ? profile.name : other,
          avatar: profile ? (profile.avatar ?? null) : null,
          status: online.has(other) ? "online" : "offline",
          updated_at: last ? last.timestamp : null,
          unread_count: conv.unread_count,
          last_message: last,
          chat_id: conv.chat_id,
          is_blocked: Boolean(isBlocked),
          blocked_by_other: Boolean(blockedByOther),
        };
      });
      users.sort((a, b) => {
        const ka = `${a.updated_at ?? ""}\u0000${a.user_id}`;
        const kb = `${b.updated_at ?? ""}\u0000${b.user_id}`;
        return ka < kb ? 1 : ka > kb ? -1 : 0;
      });
      await this.reply(userId, { type: "res_users", users });
    } catch (err) {
      logger.error("req_users failed", err);
      await this.hub.reportHandlerError(userId, message, err);
      await this.reply(userId, { type: "req_users_error", error: `Failed to retrieve users: ${errMsg(err)}` });
    }
  }

  async getMessages(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    try {
      const service = this.service(db);
      const cfg = this.config;
      const limit = Math.max(1, Math.min(pyInt(message.limit ?? cfg.defaultPageSize), cfg.maxPageSize));
      const offset = Math.max(0, pyInt(message.offset ?? 0));

      let chat: ChatRow | null;
      let otherId: string;
      if (pyBool(message.chat_id)) {
        chat = await service.getChatForUser(pyInt(message.chat_id), userId);
        if (!chat) {
          await this.reply(userId, errorFrame("Chat not found"));
          return;
        }
        otherId = otherOf(chat, userId);
      } else {
        if (!pyBool(message.candidate_user_id)) {
          await this.reply(userId, errorFrame("Missing required fields: chat_id or candidate_user_id"));
          return;
        }
        otherId = pyStr(message.candidate_user_id);
        chat = await service.getChatBetween(userId, otherId);
      }

      let rows = chat ? await service.getMessagesPage(chat.id, limit + 1, offset, userId) : [];
      const hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
      const last: MessageRow | null = rows.length && offset === 0 ? rows[0]! : chat ? await service.getLastMessage(chat.id, userId) : null;

      const profile = await this.hub.profile(otherId);
      const blocks = await this.policy.blockStatus(db, userId, [otherId]);
      const [isBlocked, blockedByOther] = blocks[otherId] ?? [false, false];
      const info = {
        user_id: otherId,
        username: profile?.name ? profile.name : otherId,
        avatar: profile ? (profile.avatar ?? null) : null,
        status: (await this.hub.connections.isOnline(otherId)) ? "online" : "offline",
        last_seen: last ? iso(last.created_at) : null,
        ...(await this.policy.extraConversationInfo(db, userId, otherId)),
        is_blocked: Boolean(isBlocked),
        blocked_by_other: Boolean(blockedByOther),
      };
      const previews = await service.getReplyPreviews(rows.map((m) => m.reply_to_id));
      const messages = rows.map((m) => messageDto(m, userId, m.reply_to_id ? previews.get(m.reply_to_id) : null));
      await this.reply(userId, { type: "res_messages", messages, offset, has_more: hasMore, info });
    } catch (err) {
      await this.failed(userId, message, err, `Failed to retrieve messages: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------- sending

  /**
   * Store + deliver a message (WS `send_message`, `POST /chats/send`, `sendMessageAs`).
   * Returns the MessageDto as the sender sees it. Throws `ChatActionError` when refused.
   */
  async sendText(
    db: Db,
    sender: string,
    recipient: string,
    content: unknown,
    opts: { messageType?: string; replyToId?: unknown; checkPolicy?: boolean; rateLimit?: boolean } = {},
  ): Promise<MessageDto> {
    const checkPolicy = opts.checkPolicy ?? true;
    const rateLimit = opts.rateLimit ?? true;
    let messageType = opts.messageType ?? "text";
    if (sender === recipient) throw new ChatActionError("Cannot send a message to yourself.", undefined, 400);
    const text = typeof content === "string" ? content : pyStr(content);
    const maxLen = this.config.maxTextLength;
    if (maxLen && codePointLength(text) > maxLen) {
      throw new ChatActionError(`Message is too long (max ${maxLen} characters).`, "too_long", 422, { max: maxLen });
    }
    if (rateLimit) {
      const wait = await this.rateLimited(sender, "chat.message", this.config.messageRate);
      if (wait) {
        const seconds = retryAfterSeconds(wait);
        throw new ChatActionError(`Too many messages. Try again in ${seconds} s.`, "rate_limited", 429, { retry_after: seconds });
      }
    }
    if (checkPolicy && !(await this.policy.canMessage(db, sender, recipient))) {
      throw new ChatActionError(this.policy.refusalMessage, undefined, 403);
    }
    if (RESERVED_TYPES.has(messageType)) messageType = "text";

    const service = this.service(db);
    const chat = await service.getOrCreateChat(sender, recipient);
    const row = await service.sendMessage(chat.id, sender, text, messageType, { replyToId: opts.replyToId });
    const replyTo = row.reply_to_id ? (await service.getReplyPreviews([row.reply_to_id])).get(row.reply_to_id) : null;
    const preview = messageType === "text" ? truncateCodePoints(text, this.config.pushPreviewChars) : ATTACHMENT_PREVIEW;
    return this.deliver(db, row, recipient, replyTo, text, text, preview);
  }

  async sendMessage(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    try {
      const recipient = message.candidate_user_id;
      const content = message.content;
      if (!pyBool(recipient) || !pyBool(content)) {
        await this.reply(userId, errorFrame("Missing required fields: candidate_user_id, content"));
        return;
      }
      await this.sendText(db, userId, pyStr(recipient), content, {
        messageType: pyBool(message.message_type) ? pyStr(message.message_type) : "text",
        replyToId: message.reply_to_id,
      });
    } catch (err) {
      if (err instanceof ChatActionError) await this.reply(userId, err.frame());
      else await this.failed(userId, message, err, `Failed to send message: ${errMsg(err)}`);
    }
  }

  /** new_message -> recipient, mark delivered, offline push, message_sent -> sender. */
  private async deliver(
    db: Db,
    row: MessageRow,
    recipient: string,
    replyTo: ReplyPreview | null | undefined,
    recipientContent: string | null,
    senderContent: string | null,
    preview: string,
  ): Promise<MessageDto> {
    const sender = row.sender_id;
    const delivered = await this.hub.send(recipient, {
      type: "new_message",
      message: messageDto(row, recipient, replyTo, { content: recipientContent, is_read: false, is_delivered: true }),
    });
    if (delivered) await this.service(db).markDelivered([row.id]);
    await this.notifyOffline(recipient, sender, row.chat_id, preview);

    const sent = messageDto(row, sender, replyTo, { content: senderContent, is_read: false, is_delivered: delivered });
    await this.hub.send(sender, { type: "message_sent", message: sent });
    await this.hub.events.emit("chat.message_sent", sent);
    return sent;
  }

  /** Push when the recipient has no foreground socket anywhere. */
  async notifyOffline(
    recipient: string,
    sender: string,
    chatId: number,
    preview: string,
    title?: string | null,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (await this.hub.connections.isOnline(recipient)) return;
    const t = title ?? (await this.hub.displayName(sender, "New message"));
    const data = {
      ...(extra ?? {}),
      type: "chat",
      cid: `messaging:${sender}`, // legacy routing key used by installed apps
      chat_id: chatId,
      sender_id: sender,
    };
    this.hub.spawn(this.hub.push(recipient, t, preview, data, this.config.pushChannel));
  }

  async mediaUpload(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const recipientRaw = message.target_user_id;
    const fileName = message.file_name;
    const fileData = message.file_data;
    if (!pyBool(recipientRaw) || !pyBool(fileName) || !pyBool(fileData)) {
      await this.reply(userId, errorFrame("Missing required fields: target_user_id, file_name, file_data"));
      return;
    }
    const recipient = pyStr(recipientRaw);
    const maxBytes = this.config.maxUploadBytes;
    const tooLarge = errorFrame(`File too large. Maximum allowed size is ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    try {
      if (userId === recipient) {
        await this.reply(userId, errorFrame("Cannot send a message to yourself."));
        return;
      }
      if (!(await this.policy.canMessage(db, userId, recipient))) {
        await this.reply(userId, errorFrame(this.policy.refusalMessage));
        return;
      }
      if (typeof fileData !== "string") {
        await this.reply(userId, errorFrame("file_data must be a base64 string"));
        return;
      }
      // Reject before decoding so oversized payloads never hit memory twice.
      if (fileData.length > Math.floor((maxBytes * 4) / 3) + 4) {
        await this.reply(userId, tooLarge);
        return;
      }
      const wait = await this.rateLimited(userId, "chat.upload", this.config.uploadRate);
      if (wait) {
        const seconds = retryAfterSeconds(wait);
        await this.reply(userId, errorFrame(`Too many uploads. Try again in ${seconds} s.`, { code: "rate_limited", retry_after: seconds }));
        return;
      }
      if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(fileData) || fileData.replace(/\s/g, "").length % 4 === 1) {
        await this.reply(userId, errorFrame("Invalid base64 file_data"));
        return;
      }
      const content = Buffer.from(fileData, "base64");
      if (content.length > maxBytes) {
        await this.reply(userId, tooLarge);
        return;
      }

      const mediaType = detectMediaType(pyStr(fileName), message.media_type);
      if (mediaType === null) {
        await this.reply(userId, errorFrame(`Unsupported file type: ${pyStr(fileName)}`));
        return;
      }

      const service = this.service(db);
      // Always the chat between these two users; never trust a client chat_id.
      const chat = await service.getOrCreateChat(userId, recipient);
      let media;
      try {
        media = await this.feature.storage.upload(chat.id, pyStr(fileName), content, mediaType);
      } catch (err) {
        if (err instanceof UploadRejected) {
          await this.reply(userId, errorFrame(err.message));
          return;
        }
        throw err;
      }
      if (pyBool(message.file_type) && !media.file_type) media.file_type = pyStr(message.file_type);

      const text = `[${media.media_type.toUpperCase()}] ${pyStr(fileName)}`;
      const row = await service.sendMessage(chat.id, userId, text, media.media_type, { media, replyToId: message.reply_to_id });
      const replyTo = row.reply_to_id ? (await service.getReplyPreviews([row.reply_to_id])).get(row.reply_to_id) : null;
      await this.reply(userId, {
        type: "media_upload_success",
        message: messageDto(row, userId, replyTo, { content: null, is_read: false, is_delivered: true }),
      });
      await this.deliver(db, row, recipient, replyTo, text, null, ATTACHMENT_PREVIEW);
    } catch (err) {
      await this.failed(userId, message, err, `Server error: ${errMsg(err)}`);
    }
  }

  // ------------------------------------------------------ receipts/typing

  /** `chat_id` wins; otherwise the chat with `candidate_user_id`. Null if not a participant. */
  async resolveChat(service: ChatService, userId: string, chatId: unknown, candidate: unknown): Promise<ChatRow | null> {
    const cid = intOrNull(chatId);
    if (cid !== null) return service.getChatForUser(cid, userId);
    if (candidate !== null && candidate !== undefined && candidate !== "" && pyStr(candidate) !== userId) {
      return service.getChatBetween(userId, pyStr(candidate));
    }
    return null;
  }

  async markRead(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const { chat_id: chatId, candidate_user_id: candidate } = message;
    if (!pyBool(chatId) && !pyBool(candidate)) {
      await this.reply(userId, errorFrame("Missing chat_id"));
      return;
    }
    const service = this.service(db);
    const chat = await this.resolveChat(service, userId, chatId, candidate);
    if (!chat) {
      await this.reply(userId, errorFrame("Chat not found"));
      return;
    }
    await service.markMessagesAsRead(chat.id, userId);
    await this.notifyRead(chat.id, userId, otherOf(chat, userId));
  }

  async notifyRead(chatId: number, reader: string, other: string): Promise<void> {
    // The reader's own sockets clear the badge; the other side sees blue ticks.
    await this.hub.send(reader, { type: "chat_read", chat_id: chatId });
    await this.hub.send(other, { type: "messages_read", chat_id: chatId, read_by: reader });
  }

  async typing(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const targetRaw = message.target_user_id;
    if (!pyBool(targetRaw) || pyStr(targetRaw) === userId) return;
    const target = pyStr(targetRaw);
    const isTyping = pyBool(message.is_typing ?? false);
    // Only "started typing" counts against the limit, so a stop frame always gets through.
    if (isTyping && (await this.rateLimited(userId, "chat.typing", this.config.typingRate))) return;
    if (!(await this.policy.canMessage(db, userId, target))) return;
    const pair = [userId, target].sort().join("\u0000");
    let chatId = this.pairChatIds.get(pair);
    if (chatId === undefined) {
      const chat = await this.service(db).getChatBetween(userId, target);
      if (!chat) return;
      chatId = chat.id;
      this.pairChatIds.put(pair, chatId);
    }
    await this.hub.send(target, { type: "typing_status", user_id: userId, chat_id: chatId, is_typing: isTyping, timestamp: nowIso() });
  }

  // --------------------------------------------------------- delete / clear

  async deleteMessage(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const messageId = intOrNull(message.message_id);
    if (messageId === null) {
      await this.reply(userId, errorFrame("Missing required fields: message_id", { code: "not_found" }));
      return;
    }
    try {
      await this.deleteFor(db, userId, messageId, pyBool(message.for_everyone ?? false));
    } catch (err) {
      if (err instanceof ChatActionError) await this.reply(userId, err.frame());
      else await this.failed(userId, message, err, `Failed to delete message: ${errMsg(err)}`);
    }
  }

  /** Delete for me / unsend for everyone. Sends `message_deleted`; throws `ChatActionError`. */
  async deleteFor(db: Db, userId: string, messageId: number, forEveryone: boolean): Promise<Record<string, unknown>> {
    const service = this.service(db);
    const row = await service.getMessage(messageId);
    const chat = row ? await service.getChatForUser(row.chat_id, userId) : null;
    if (!row || !chat) throw new ChatActionError("Message not found", "not_found", 404);
    const payload = { type: "message_deleted", chat_id: row.chat_id, message_id: row.id, for_everyone: forEveryone };
    if (!forEveryone) {
      await service.hideMessage(userId, row.id);
      await this.hub.send(userId, payload);
      await this.hub.events.emit("chat.message_deleted", { ...payload, user_id: userId });
      return payload;
    }
    const windowSeconds = Math.trunc(this.config.unsendWindowSeconds);
    if (windowSeconds < 0) throw new ChatActionError("Deleting for everyone is disabled", "not_allowed", 403);
    if (row.sender_id !== userId) throw new ChatActionError("Only the sender can delete a message for everyone", "not_allowed", 403);
    if (row.call_id || row.message_type === SYSTEM_TYPE) {
      throw new ChatActionError("This message can't be deleted for everyone", "not_allowed", 403);
    }
    if (row.message_type !== DELETED_TYPE) {
      // unsending twice just repeats the event
      const [, urls] = await service.unsendMessage(row.id, windowSeconds);
      if (urls.length) this.hub.spawn(deleteMedia(this.feature.storage, ...urls));
    }
    await this.hub.send(userId, payload);
    await this.hub.send(otherOf(chat, userId), payload);
    await this.hub.events.emit("chat.message_deleted", { ...payload, user_id: userId });
    return payload;
  }

  async clearChat(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const { chat_id: chatId, candidate_user_id: candidate } = message;
    try {
      if (!pyBool(chatId) && !pyBool(candidate)) {
        throw new ChatActionError("Missing required fields: chat_id or candidate_user_id", "not_found", 404);
      }
      await this.clearFor(db, userId, chatId, candidate);
    } catch (err) {
      if (err instanceof ChatActionError) await this.reply(userId, err.frame());
      else await this.failed(userId, message, err, `Failed to clear chat: ${errMsg(err)}`);
    }
  }

  async clearFor(db: Db, userId: string, chatId: unknown, candidate: unknown): Promise<Record<string, unknown>> {
    const service = this.service(db);
    const chat = await this.resolveChat(service, userId, chatId, candidate);
    if (!chat) throw new ChatActionError("Chat not found", "not_found", 404);
    const clearedAt = await service.clearChat(userId, chat.id);
    const payload = { type: "chat_cleared", chat_id: chat.id, cleared_at: iso(clearedAt) };
    await this.hub.send(userId, payload);
    return payload;
  }

  // -------------------------------------------------------------- connect

  /** Flush delivery receipts for messages that arrived while the user was offline. */
  async onConnect(userId: string, _ws: SocketLike): Promise<void> {
    const rows = await this.service(this.hub.db).markDeliveredForRecipient(userId);
    const grouped = new Map<string, { chatId: number; senderId: string; ids: number[] }>();
    for (const [chatId, senderId, messageId] of rows) {
      const key = `${chatId}\u0000${senderId}`;
      if (!grouped.has(key)) grouped.set(key, { chatId, senderId, ids: [] });
      grouped.get(key)!.ids.push(messageId);
    }
    for (const { chatId, senderId, ids } of grouped.values()) {
      await this.hub.send(senderId, {
        type: "delivery_status",
        chat_id: chatId,
        message_ids: ids.sort((a, b) => a - b),
        status: "delivered",
        timestamp: nowIso(),
      });
    }
  }
}
