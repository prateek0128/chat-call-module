/** Moderation WebSocket handlers and the shared block/report actions (also used by REST). Port of commskit.moderation.handlers. */
import type { Db } from "../core/db.js";
import { logger } from "../core/logger.js";
import type { ModerationFeature } from "./feature.js";
import { ModerationService, type ReportInfo } from "./service.js";

export const BLOCKED_TEXT = "User blocked successfully";
export const BLOCKED_BY_TEXT = "You have been blocked by this user";
export const UNBLOCKED_TEXT = "User unblocked successfully";
export const UNBLOCKED_BY_TEXT = "You have been unblocked by this user";

export const moderationError = (error: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "error",
  error,
  ...extra,
  context: "moderation",
});

/** Bad request (missing / self target ...). */
export class ModerationError extends Error {}

export function targetId(userId: string, value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new ModerationError("Missing required fields: candidate_user_id");
  }
  const target = String(value).trim();
  if (target === userId) throw new ModerationError("You cannot block or report yourself.");
  return target;
}

function messageIdOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new ModerationError("message_id must be an integer");
  return Number(s);
}

/** Block / unblock / report + their frames and events. */
export class ModerationActions {
  constructor(private feature: ModerationFeature) {}

  private get hub() {
    return this.feature.hub;
  }

  async block(db: Db, userId: string, target: string): Promise<boolean> {
    const created = await new ModerationService(db, this.hub.dialect).block(userId, target);
    await this.hub.send(userId, { type: "user_blocked", candidate_user_id: target, message: BLOCKED_TEXT });
    if (this.feature.notifyBlockedUser) {
      await this.hub.send(target, { type: "blocked_by_user", candidate_user_id: userId, message: BLOCKED_BY_TEXT });
    }
    // Always emitted (also for a repeated block): listeners such as linkModeration end live calls between the pair,
    // which must happen even if a call slipped through.
    await this.hub.events.emit("moderation.blocked", userId, target);
    return created;
  }

  async unblock(db: Db, userId: string, target: string): Promise<boolean> {
    const removed = await new ModerationService(db, this.hub.dialect).unblock(userId, target);
    await this.hub.send(userId, { type: "user_unblocked", candidate_user_id: target, message: UNBLOCKED_TEXT });
    if (this.feature.notifyBlockedUser && removed) {
      await this.hub.send(target, { type: "unblocked_by_user", candidate_user_id: userId, message: UNBLOCKED_BY_TEXT });
    }
    if (removed) await this.hub.events.emit("moderation.unblocked", userId, target);
    return removed;
  }

  async report(
    db: Db,
    userId: string,
    target: string,
    opts: { reason?: unknown; category?: unknown; messageId?: unknown; block?: boolean } = {},
  ): Promise<ReportInfo> {
    let info = await new ModerationService(db, this.hub.dialect).createReport(userId, target, {
      reason: opts.reason === null || opts.reason === undefined ? null : String(opts.reason),
      category: opts.category === null || opts.category === undefined ? null : String(opts.category),
      messageId: messageIdOf(opts.messageId),
    });
    if (opts.block ?? true) {
      await this.block(db, userId, target);
      info = { ...info, blocked: true };
    }
    await this.hub.send(userId, { type: "report_received", report_id: info.id, candidate_user_id: target });
    await this.hub.events.emit("moderation.reported", info);
    const hook = this.feature.onReport;
    if (hook) {
      const reported = info;
      this.hub.spawn(async () => {
        try {
          await hook(reported);
        } catch (err) {
          logger.error(`onReport hook failed for report ${reported.id}`, err);
        }
      });
    }
    return info;
  }
}

export class ModerationHandlers {
  constructor(private feature: ModerationFeature) {}

  private get hub() {
    return this.feature.hub;
  }

  register(): void {
    this.hub.on("report_and_block", this.guard((u, m, db) => this.reportAndBlock(u, m, db), "Failed to report user"));
    this.hub.on("block", this.guard((u, m, db) => this.block(u, m, db), "Failed to block user"));
    this.hub.on("unblock", this.guard((u, m, db) => this.unblock(u, m, db), "Failed to unblock user"));
  }

  private guard(fn: (userId: string, message: Record<string, any>, db: Db) => Promise<void>, label: string) {
    return async (userId: string, message: Record<string, any>, db: Db): Promise<void> => {
      try {
        await fn(userId, message, db);
      } catch (err) {
        if (err instanceof ModerationError) {
          await this.hub.send(userId, moderationError(err.message));
          return;
        }
        logger.error(`${message.type} handler failed`, err);
        await this.hub.reportHandlerError(userId, message, err);
        await this.hub.send(userId, moderationError(`${label}: ${(err as Error)?.message ?? err}`));
      }
    };
  }

  async reportAndBlock(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const target = targetId(userId, message.candidate_user_id);
    await this.feature.actions.report(db, userId, target, {
      reason: message.reason,
      category: message.category,
      messageId: message.message_id,
      block: message.block !== false,
    });
  }

  async block(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    await this.feature.actions.block(db, userId, targetId(userId, message.candidate_user_id));
  }

  async unblock(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    await this.feature.actions.unblock(db, userId, targetId(userId, message.candidate_user_id));
  }
}
