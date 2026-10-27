/**
 * ChatService: persistence for 1:1 chats (port of commskit.chat.service).
 * Portable queries (PostgreSQL + SQLite); methods return plain rows (`ChatRow` / `MessageRow`).
 */
import { type RawBuilder, type SqlBool, sql } from "kysely";
import type { MediaInfo } from "../core/adapters.js";
import { type Db, type Dialect, dbBool, dbNow, dbTimestamp, detectDialect } from "../core/db.js";
import { iso, parseDbDate } from "../core/util.js";
import type { MessageRow, ReplyPreview } from "./dto.js";

export const DELETED_TYPE = "deleted";
export const SYSTEM_TYPE = "system";
/** Message types only the server may create (a client sending one gets "text"). */
export const RESERVED_TYPES: ReadonlySet<string> = new Set([DELETED_TYPE, SYSTEM_TYPE]);

export interface ChatRow {
  id: number;
  user1_id: string;
  user2_id: string;
  created_at: unknown;
  updated_at: unknown;
}

export const otherOf = (chat: ChatRow, userId: string): string => (chat.user1_id === userId ? chat.user2_id : chat.user1_id);

export interface LastMessageSummary {
  content: string | null;
  sender_id: string;
  timestamp: string | null;
  message_type: string | null;
  file_url: string | null;
  file_size: number | null;
  file_type: string | null;
  file_name: string | null;
  is_read: boolean;
  is_delivered: boolean;
}

export interface Conversation {
  chat_id: number;
  other_user_id: string;
  updated_at: string | null;
  last_message: LastMessageSummary | null;
  unread_count: number;
}

/**
 * Refused chat action (PROTOCOL.md section 9). `code`: not_found | not_allowed | window_expired |
 * rate_limited | too_long (`extra` carries `retry_after` / `max`), or undefined for policy refusals.
 */
export class ChatActionError extends Error {
  constructor(
    public error: string,
    public code?: string,
    public status = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(error);
    this.name = "ChatActionError";
  }

  frame(): Record<string, unknown> {
    const payload: Record<string, unknown> = { type: "error", error: this.error };
    if (this.code) payload.code = this.code;
    return { ...payload, ...this.extra };
  }
}

const lastMessageSummary = (m: MessageRow): LastMessageSummary => ({
  content: m.content,
  sender_id: m.sender_id,
  timestamp: iso(m.created_at),
  message_type: m.message_type,
  file_url: m.file_url,
  file_size: m.file_size,
  file_type: m.file_type,
  file_name: m.file_name,
  // Additive vs. the legacy server: lets the conversation list show ticks.
  is_read: Boolean(m.is_read),
  is_delivered: Boolean(m.is_delivered),
});

const toMessageRow = (r: any): MessageRow => ({
  id: Number(r.id),
  chat_id: Number(r.chat_id),
  sender_id: String(r.sender_id),
  content: r.content ?? null,
  message_type: r.message_type ?? null,
  file_url: r.file_url ?? null,
  file_name: r.file_name ?? null,
  file_size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
  file_type: r.file_type ?? null,
  thumbnail_url: r.thumbnail_url ?? null,
  duration: r.duration === null || r.duration === undefined ? null : Number(r.duration),
  is_read: Boolean(r.is_read),
  is_delivered: Boolean(r.is_delivered),
  call_id: r.call_id ?? null,
  reply_to_id: r.reply_to_id === null || r.reply_to_id === undefined ? null : Number(r.reply_to_id),
  created_at: r.created_at ?? null,
});

const toChatRow = (r: any): ChatRow => ({
  id: Number(r.id),
  user1_id: String(r.user1_id),
  user2_id: String(r.user2_id),
  created_at: r.created_at ?? null,
  updated_at: r.updated_at ?? null,
});

/** Messages `userId` still sees: not hidden (delete for me) and newer than their clear-chat mark. */
export function visibleTo(userId: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`(messages.id > coalesce((select c.up_to_message_id from comms_chat_cleared c where c.user_id = ${userId} and c.chat_id = messages.chat_id), 0)
    and not exists (select 1 from comms_message_hidden h where h.user_id = ${userId} and h.message_id = messages.id))`;
}

const notDeleted = sql<SqlBool>`(messages.message_type is null or messages.message_type != ${DELETED_TYPE})`;
const notRead = sql<SqlBool>`coalesce(messages.is_read, false) = false`;
const notDelivered = sql<SqlBool>`coalesce(messages.is_delivered, false) = false`;

export class ChatService {
  readonly dialect: Dialect;

  constructor(
    private db: Db,
    dialect?: Dialect,
  ) {
    this.dialect = dialect ?? detectDialect(db);
  }

  private ts(): string | Date {
    return dbTimestamp(this.dialect);
  }

  // ---------------------------------------------------------------- chats

  async getChatBetween(userA: string, userB: string): Promise<ChatRow | null> {
    const [u1, u2] = [userA, userB].sort();
    const row = await this.db.selectFrom("chats").selectAll().where("user1_id", "=", u1!).where("user2_id", "=", u2!).executeTakeFirst();
    return row ? toChatRow(row) : null;
  }

  /** Idempotent per pair; survives a concurrent create (unique constraint). */
  async getOrCreateChat(userA: string, userB: string): Promise<ChatRow> {
    const existing = await this.getChatBetween(userA, userB);
    if (existing) return existing;
    const [u1, u2] = [userA, userB].sort();
    try {
      const now = this.ts();
      await this.db.insertInto("chats").values({ user1_id: u1, user2_id: u2, created_at: now, updated_at: now }).execute();
    } catch {
      // unique violation from a concurrent create: fall through to the lookup
    }
    const found = await this.getChatBetween(userA, userB);
    if (!found) throw new Error("Could not create chat");
    return found;
  }

  /** Chat only if `userId` is a participant. */
  async getChatForUser(chatId: number, userId: string): Promise<ChatRow | null> {
    const row = await this.db
      .selectFrom("chats")
      .selectAll()
      .where("id", "=", chatId)
      .where((eb) => eb.or([eb("user1_id", "=", userId), eb("user2_id", "=", userId)]))
      .executeTakeFirst();
    return row ? toChatRow(row) : null;
  }

  async partnerIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("chats")
      .select(["user1_id", "user2_id"])
      .where((eb) => eb.or([eb("user1_id", "=", userId), eb("user2_id", "=", userId)]))
      .execute();
    return rows.map((r: any) => String(r.user1_id === userId ? r.user2_id : r.user1_id));
  }

  /** Chat summaries, newest first. "Last message per chat" via MAX(id) (ids grow with time). */
  async getConversations(userId: string): Promise<Conversation[]> {
    const chats = (
      await this.db
        .selectFrom("chats")
        .selectAll()
        .where((eb) => eb.or([eb("user1_id", "=", userId), eb("user2_id", "=", userId)]))
        .execute()
    ).map(toChatRow);
    if (!chats.length) return [];
    const chatIds = chats.map((c) => c.id);

    const lastRows = await this.db
      .selectFrom("messages")
      .select(["chat_id", (eb) => eb.fn.max("id").as("last_id")])
      .where("chat_id", "in", chatIds)
      .where(visibleTo(userId))
      .groupBy("chat_id")
      .execute();
    const lastIds = lastRows.map((r: any) => Number(r.last_id));
    const lastById = new Map<number, MessageRow>();
    if (lastIds.length) {
      for (const m of await this.db.selectFrom("messages").selectAll().where("id", "in", lastIds).execute()) {
        const row = toMessageRow(m);
        lastById.set(row.chat_id, row);
      }
    }
    const unreadRows = await this.db
      .selectFrom("messages")
      .select(["chat_id", (eb) => eb.fn.countAll().as("n")])
      .where("chat_id", "in", chatIds)
      .where("sender_id", "!=", userId)
      .where(notRead)
      .where(notDeleted)
      .where(visibleTo(userId))
      .groupBy("chat_id")
      .execute();
    const unread = new Map<number, number>(unreadRows.map((r: any) => [Number(r.chat_id), Number(r.n)]));

    const convs = chats.map((c) => ({
      chat_id: c.id,
      other_user_id: otherOf(c, userId),
      updated_at: iso(c.updated_at),
      last_message: lastById.has(c.id) ? lastMessageSummary(lastById.get(c.id)!) : null,
      unread_count: unread.get(c.id) ?? 0,
    }));
    convs.sort((a, b) => {
      const ua = a.updated_at ?? "";
      const ub = b.updated_at ?? "";
      return ua === ub ? b.chat_id - a.chat_id : ua < ub ? 1 : -1;
    });
    return convs;
  }

  // ------------------------------------------------------------- messages

  /** Stores a message and bumps the chat's `updated_at` (one transaction). */
  async sendMessage(
    chatId: number,
    senderId: string,
    content: string | null,
    messageType = "text",
    opts: { media?: MediaInfo | null; callId?: string | null; replyToId?: unknown } = {},
  ): Promise<MessageRow> {
    const replyTo = await this.validReplyTarget(chatId, opts.replyToId);
    const now = this.ts();
    const media = opts.media;
    const row = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("messages")
        .values({
          chat_id: chatId,
          sender_id: senderId,
          content,
          message_type: messageType,
          reply_to_id: replyTo,
          is_read: dbBool(this.dialect, false),
          is_delivered: dbBool(this.dialect, false),
          is_call: dbBool(this.dialect, Boolean(opts.callId)),
          call_id: opts.callId || null,
          file_url: media?.file_url ?? null,
          file_name: media?.file_name ?? null,
          file_size: media?.file_size ?? null,
          file_type: media?.file_type ?? null,
          thumbnail_url: media?.thumbnail_url ?? null,
          duration: media?.duration ?? null,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.updateTable("chats").set({ updated_at: now }).where("id", "=", chatId).execute();
      return inserted;
    });
    return toMessageRow(row);
  }

  /** Only messages from the same chat can be quoted. */
  private async validReplyTarget(chatId: number, replyToId: unknown): Promise<number | null> {
    if (replyToId === null || replyToId === undefined || typeof replyToId === "boolean") return null;
    const id = typeof replyToId === "number" ? Math.trunc(replyToId) : /^\s*-?\d+\s*$/.test(String(replyToId)) ? Number(replyToId) : NaN;
    if (!Number.isFinite(id)) return null;
    const r = await this.db.selectFrom("messages").select("id").where("id", "=", id).where("chat_id", "=", chatId).executeTakeFirst();
    return r ? Number(r.id) : null;
  }

  async getReplyPreviews(messageIds: Array<number | null | undefined>): Promise<Map<number, ReplyPreview>> {
    const ids = [...new Set(messageIds.filter((i): i is number => i !== null && i !== undefined))];
    const out = new Map<number, ReplyPreview>();
    if (!ids.length) return out;
    const rows = await this.db
      .selectFrom("messages")
      .select(["id", "sender_id", "content", "message_type", "file_name"])
      .where("id", "in", ids)
      .execute();
    for (const r of rows as any[]) {
      out.set(Number(r.id), {
        id: Number(r.id),
        sender_id: r.sender_id,
        content: r.content,
        message_type: r.message_type,
        file_name: r.file_name,
      });
    }
    return out;
  }

  /** Newest first. With `viewerId`, that user's hidden / cleared messages are left out. */
  async getMessagesPage(chatId: number, limit = 50, offset = 0, viewerId?: string | null): Promise<MessageRow[]> {
    let q = this.db.selectFrom("messages").selectAll().where("chat_id", "=", chatId);
    if (viewerId) q = q.where(visibleTo(viewerId));
    const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).offset(offset).execute();
    return rows.map(toMessageRow);
  }

  async getLastMessage(chatId: number, viewerId?: string | null): Promise<MessageRow | null> {
    return (await this.getMessagesPage(chatId, 1, 0, viewerId))[0] ?? null;
  }

  async getMessage(messageId: number): Promise<MessageRow | null> {
    const row = await this.db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirst();
    return row ? toMessageRow(row) : null;
  }

  /** Read receipts are per chat: everything the other person sent becomes read + delivered. */
  async markMessagesAsRead(chatId: number, userId: string): Promise<void> {
    await this.db
      .updateTable("messages")
      .set({ is_read: dbBool(this.dialect, true), is_delivered: dbBool(this.dialect, true) })
      .where("chat_id", "=", chatId)
      .where("sender_id", "!=", userId)
      .where(notRead)
      .execute();
  }

  async markDelivered(messageIds: number[]): Promise<void> {
    if (!messageIds.length) return;
    await this.db.updateTable("messages").set({ is_delivered: dbBool(this.dialect, true) }).where("id", "in", messageIds).execute();
  }

  /** Mark everything sent to `userId` delivered; returns [chat_id, sender_id, message_id] (system messages excluded). */
  async markDeliveredForRecipient(userId: string): Promise<Array<[number, string, number]>> {
    const rows = (await this.db
      .selectFrom("messages")
      .select(["chat_id", "sender_id", "id", "message_type"])
      .where("chat_id", "in", (eb: any) =>
        eb.selectFrom("chats").select("id").where((e2: any) => e2.or([e2("user1_id", "=", userId), e2("user2_id", "=", userId)])),
      )
      .where("sender_id", "!=", userId)
      .where(notDelivered)
      .execute()) as any[];
    if (rows.length) await this.markDelivered(rows.map((r) => Number(r.id)));
    // System messages are stored under the user they are about, who never sees them: no receipt.
    return rows.filter((r) => r.message_type !== SYSTEM_TYPE).map((r) => [Number(r.chat_id), String(r.sender_id), Number(r.id)]);
  }

  async getUnreadCount(userId: string): Promise<number> {
    const r = await this.db
      .selectFrom("messages")
      .innerJoin("chats", "messages.chat_id", "chats.id")
      .select((eb) => eb.fn.count("messages.id").as("n"))
      .where((eb) => eb.or([eb("chats.user1_id", "=", userId), eb("chats.user2_id", "=", userId)]))
      .where("messages.sender_id", "!=", userId)
      .where(notRead)
      .where(notDeleted)
      .where(visibleTo(userId))
      .executeTakeFirst();
    return Number((r as any)?.n ?? 0);
  }

  // ------------------------------------------------- delete / unsend / clear

  /** Delete for me (idempotent). Does not check access; callers do. */
  async hideMessage(userId: string, messageId: number): Promise<void> {
    const existing = await this.db
      .selectFrom("comms_message_hidden")
      .select("id")
      .where("user_id", "=", userId)
      .where("message_id", "=", messageId)
      .executeTakeFirst();
    if (existing) return;
    try {
      await this.db.insertInto("comms_message_hidden").values({ user_id: userId, message_id: messageId, created_at: this.ts() }).execute();
    } catch {
      // concurrent hide: already there
    }
  }

  /**
   * Rewrite the row as `deleted` for everyone; returns the new row and the media URLs to delete.
   * `windowSeconds` > 0: throws `window_expired` for older messages.
   */
  async unsendMessage(messageId: number, windowSeconds: number): Promise<[MessageRow, string[]]> {
    const message = await this.getMessage(messageId);
    if (!message) throw new ChatActionError("Message not found", "not_found", 404);
    const created = parseDbDate(message.created_at);
    if (windowSeconds > 0 && created) {
      const age = (dbNow().getTime() - created.getTime()) / 1000;
      if (age > windowSeconds) {
        throw new ChatActionError("This message can no longer be deleted for everyone", "window_expired", 403);
      }
    }
    const urls = [message.file_url, message.thumbnail_url].filter((u): u is string => !!u);
    await this.db
      .updateTable("messages")
      .set({
        message_type: DELETED_TYPE, content: null, file_url: null, file_name: null, file_size: null,
        file_type: null, thumbnail_url: null, duration: null,
      })
      .where("id", "=", messageId)
      .execute();
    const row = await this.getMessage(messageId);
    return [row!, urls];
  }

  /** Hide every message of the chat, up to now, for `userId` only. Returns `cleared_at`. */
  async clearChat(userId: string, chatId: number): Promise<Date> {
    const maxRow = await this.db.selectFrom("messages").select((eb) => eb.fn.max("id").as("m")).where("chat_id", "=", chatId).executeTakeFirst();
    const upTo = Number((maxRow as any)?.m ?? 0);
    const now = dbNow();
    const stamp = dbTimestamp(this.dialect, now);
    const row = await this.db
      .selectFrom("comms_chat_cleared")
      .selectAll()
      .where("user_id", "=", userId)
      .where("chat_id", "=", chatId)
      .executeTakeFirst();
    if (!row) {
      await this.db.insertInto("comms_chat_cleared").values({ user_id: userId, chat_id: chatId, cleared_at: stamp, up_to_message_id: upTo }).execute();
    } else {
      await this.db
        .updateTable("comms_chat_cleared")
        .set({ cleared_at: stamp, up_to_message_id: Math.max(Number((row as any).up_to_message_id ?? 0), upTo) })
        .where("id", "=", (row as any).id)
        .execute();
    }
    // Single-message hides at or below the mark are redundant now.
    await this.db
      .deleteFrom("comms_message_hidden")
      .where("user_id", "=", userId)
      .where("message_id", "in", (eb: any) => eb.selectFrom("messages").select("id").where("chat_id", "=", chatId).where("id", "<=", upTo))
      .execute();
    return now;
  }

  // ----------------------------------------------------------- moderation

  /**
   * Newest first: up to `before` older messages, the message itself, up to `after` newer ones.
   * Without a `messageId` from this chat: the latest `before + after + 1` messages. Ignores hides / clears.
   */
  async messagesAround(chatId: number, messageId: number | null, before = 20, after = 20): Promise<MessageRow[]> {
    before = Math.max(0, before);
    after = Math.max(0, after);
    let anchor: number | null = null;
    if (messageId !== null) {
      const r = await this.db.selectFrom("messages").select("id").where("id", "=", messageId).where("chat_id", "=", chatId).executeTakeFirst();
      anchor = r ? Number(r.id) : null;
    }
    if (anchor === null) return this.getMessagesPage(chatId, before + after + 1);
    const older = await this.db.selectFrom("messages").selectAll().where("chat_id", "=", chatId).where("id", "<=", anchor).orderBy("id", "desc").limit(before + 1).execute();
    const newer = after
      ? await this.db.selectFrom("messages").selectAll().where("chat_id", "=", chatId).where("id", ">", anchor).orderBy("id", "asc").limit(after).execute()
      : [];
    return [...newer.reverse().map(toMessageRow), ...older.map(toMessageRow)];
  }

  // -------------------------------------------------------------- deletion

  /**
   * Delete every chat `userId` is in, with all its messages (a 1:1 chat has one shared copy, so the
   * partner loses that conversation too), hides and clears. Returns counts and the media URLs to delete.
   */
  async deleteUserData(userId: string): Promise<[{ chats: number; messages: number }, string[]]> {
    const chatIds = (
      await this.db.selectFrom("chats").select("id").where((eb) => eb.or([eb("user1_id", "=", userId), eb("user2_id", "=", userId)])).execute()
    ).map((r: any) => Number(r.id));
    const counts = { chats: chatIds.length, messages: 0 };
    const urls: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      if (chatIds.length) {
        for (const r of (await trx.selectFrom("messages").select(["file_url", "thumbnail_url"]).where("chat_id", "in", chatIds).execute()) as any[]) {
          for (const u of [r.file_url, r.thumbnail_url]) if (u) urls.push(u);
        }
        const messageIds = (eb: any) => eb.selectFrom("messages").select("id").where("chat_id", "in", chatIds);
        await trx.deleteFrom("comms_message_hidden").where("message_id", "in", messageIds).execute();
        await trx.deleteFrom("comms_chat_cleared").where("chat_id", "in", chatIds).execute();
        // Replies only point inside the same chat; unlink first for databases without FK cascades.
        await trx.updateTable("messages").set({ reply_to_id: null }).where("chat_id", "in", chatIds).execute();
        const res = await trx.deleteFrom("messages").where("chat_id", "in", chatIds).executeTakeFirst();
        counts.messages = Number(res.numDeletedRows ?? 0);
        await trx.deleteFrom("chats").where("id", "in", chatIds).execute();
      }
      await trx.deleteFrom("comms_message_hidden").where("user_id", "=", userId).execute();
      await trx.deleteFrom("comms_chat_cleared").where("user_id", "=", userId).execute();
    });
    return [counts, urls];
  }

  // ---------------------------------------------------------- call entries

  /** Set a call entry's text; returns its message id (null when none). Used by the call/chat link. */
  async rewriteCallMessage(callId: string, content: string): Promise<number | null> {
    const r = await this.db.selectFrom("messages").select("id").where("call_id", "=", callId).executeTakeFirst();
    if (!r) return null;
    await this.db.updateTable("messages").set({ content }).where("id", "=", r.id).execute();
    return Number(r.id);
  }
}
