/** Chat REST routes (PROTOCOL.md section 5), all Bearer-authenticated. Port of commskit.chat.router. */
import { HttpError, type RestContext, type RestResult, type RestRoute, firstQuery, ok, validationError } from "../core/rest.js";
import { iso } from "../core/util.js";
import { messageDto } from "./dto.js";
import type { ChatFeature } from "./feature.js";
import { ChatActionError, otherOf } from "./service.js";

function bodyObject(ctx: RestContext): Record<string, any> {
  const b = ctx.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required", input: null }]);
  }
  return b as Record<string, any>;
}

function intParam(where: "path" | "query", name: string, raw: string | undefined, def?: number, min?: number, max?: number): number {
  if (raw === undefined) {
    if (def === undefined) throw validationError(where, name, "missing", "Field required");
    return def;
  }
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    throw validationError(where, name, "int_parsing", "Input should be a valid integer, unable to parse string as an integer", raw);
  }
  const n = Number(raw);
  if (min !== undefined && n < min) {
    throw validationError(where, name, "greater_than_equal", `Input should be greater than or equal to ${min}`, raw);
  }
  if (max !== undefined && n > max) {
    throw validationError(where, name, "less_than_equal", `Input should be less than or equal to ${max}`, raw);
  }
  return n;
}

export function buildChatRoutes(feature: ChatFeature): RestRoute[] {
  const hub = feature.hub;
  const svc = () => feature.handlers.service(hub.db);
  const ensureSelf = (pathUserId: string, authUserId: string): void => {
    if (pathUserId !== authUserId) throw new HttpError(403, "Not allowed");
  };
  const actionError = (exc: ChatActionError): RestResult => {
    const { type: _type, ...body } = exc.frame();
    const headers = "retry_after" in exc.extra ? { "Retry-After": String(exc.extra.retry_after) } : undefined;
    return { status: exc.status, headers, body: { detail: body, ...body } };
  };

  const routes: RestRoute[] = [
    {
      method: "POST",
      path: "/chats/start",
      async handler(ctx) {
        const candidate = firstQuery(ctx.query, "candidate_id");
        if (candidate === undefined) throw validationError("query", "candidate_id", "missing", "Field required");
        const userId = ctx.userId!;
        if (candidate === userId) throw new HttpError(400, "Cannot start a chat with yourself");
        const chat = await svc().getOrCreateChat(userId, candidate);
        return ok({
          chat_id: chat.id,
          user1_id: chat.user1_id,
          user2_id: chat.user2_id,
          created_at: iso(chat.created_at),
          updated_at: iso(chat.updated_at),
        });
      },
    },
  ];

  // Skipped when DevicesFeature is already installed: it mounts these too.
  if (feature.devices && !("devices" in hub.features)) {
    const devices = feature.devices;
    routes.push(
      { method: "POST", path: "/chats/expo/push/token", handler: async (ctx) => ok(await devices.register(ctx.userId!, bodyObject(ctx))) },
      { method: "POST", path: "/chats/expo/push/token/remove", handler: async (ctx) => ok(await devices.remove(ctx.userId!, bodyObject(ctx))) },
    );
  }

  routes.push(
    {
      // Same rules and events as WS send_message (policy, limits, push); returns the sender's MessageDto.
      method: "POST",
      path: "/chats/send",
      async handler(ctx) {
        const payload = bodyObject(ctx);
        const recipient = payload.candidate_user_id;
        const content = payload.content;
        if (!recipient || !content) throw new HttpError(422, "Missing required fields: candidate_user_id, content");
        try {
          return ok(await feature.handlers.sendText(hub.db, ctx.userId!, String(recipient), content, { replyToId: payload.reply_to_id }));
        } catch (err) {
          if (err instanceof ChatActionError) return actionError(err);
          throw err;
        }
      },
    },
    {
      // {chat_id?} or {candidate_user_id?} (chat_id wins)
      method: "POST",
      path: "/chats/read",
      async handler(ctx) {
        const payload = bodyObject(ctx);
        const service = svc();
        const chat = await feature.handlers.resolveChat(service, ctx.userId!, payload.chat_id, payload.candidate_user_id);
        if (!chat) throw new HttpError(404, "Chat not found");
        await service.markMessagesAsRead(chat.id, ctx.userId!);
        await feature.handlers.notifyRead(chat.id, ctx.userId!, otherOf(chat, ctx.userId!));
        return ok({ message: "Messages marked as read" });
      },
    },
    {
      method: "GET",
      path: "/chats/:userId",
      async handler(ctx) {
        const userId = ctx.params.userId!;
        ensureSelf(userId, ctx.userId!);
        const convs = await svc().getConversations(userId);
        const profiles = await hub.profiles(convs.map((c) => c.other_user_id));
        return ok(
          convs.map((conv) => {
            const other = conv.other_user_id;
            const profile = profiles[other];
            return {
              id: conv.chat_id,
              other_user: { id: other, username: profile?.name ? profile.name : other, avatar: profile ? (profile.avatar ?? null) : null },
              last_message: conv.last_message,
              unread_count: conv.unread_count,
              updated_at: conv.updated_at,
            };
          }),
        );
      },
    },
    {
      method: "GET",
      path: "/chats/:chatId/messages",
      async handler(ctx) {
        const chatId = intParam("path", "chatId", ctx.params.chatId);
        const limit = intParam("query", "limit", firstQuery(ctx.query, "limit"), 50, 1, 100);
        const offset = intParam("query", "offset", firstQuery(ctx.query, "offset"), 0, 0);
        const userId = ctx.userId!;
        const service = svc();
        if (!(await service.getChatForUser(chatId, userId))) throw new HttpError(404, "Chat not found");
        const rows = await service.getMessagesPage(chatId, limit, offset, userId);
        const previews = await service.getReplyPreviews(rows.map((m) => m.reply_to_id));
        return ok(rows.map((m) => messageDto(m, userId, m.reply_to_id ? previews.get(m.reply_to_id) : null)));
      },
    },
    {
      method: "POST",
      path: "/chats/:chatId/read",
      async handler(ctx) {
        const chatId = intParam("path", "chatId", ctx.params.chatId);
        const userId = ctx.userId!;
        const service = svc();
        const chat = await service.getChatForUser(chatId, userId);
        if (!chat) throw new HttpError(404, "Chat not found");
        await service.markMessagesAsRead(chatId, userId);
        await feature.handlers.notifyRead(chatId, userId, otherOf(chat, userId));
        return ok({ message: "Messages marked as read" });
      },
    },
    {
      method: "GET",
      path: "/chats/:userId/unread-count",
      async handler(ctx) {
        ensureSelf(ctx.params.userId!, ctx.userId!);
        return ok({ unread_count: await svc().getUnreadCount(ctx.params.userId!) });
      },
    },
    {
      method: "GET",
      path: "/chats/:userId/online-status",
      async handler(ctx) {
        const userId = ctx.params.userId!;
        // Only for yourself or someone you chat with.
        if (userId !== ctx.userId && !(await svc().getChatBetween(ctx.userId!, userId))) throw new HttpError(403, "Not allowed");
        return ok({ user_id: userId, is_online: await hub.connections.isOnline(userId) });
      },
    },
  );
  return routes;
}
