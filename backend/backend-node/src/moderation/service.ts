/** ModerationService: block list and reports (port of commskit.moderation.service). Never runs a query inside another's transaction. */
import { type Db, type Dialect, dbTimestamp, detectDialect } from "../core/db.js";
import { iso } from "../core/util.js";

// Suggested; free text is allowed.
export const REPORT_CATEGORIES = ["spam", "harassment", "inappropriate", "fake_profile", "scam", "underage", "other"] as const;
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export const MAX_NOTE_CHARS = 4000;
export const MAX_REASON_CHARS = 2000;
export const MAX_CATEGORY_CHARS = 64;

/** What `moderation.reported` listeners and `onReport` receive. */
export interface ReportInfo {
  id: number;
  reporter_id: string;
  reported_id: string;
  reason: string | null;
  category: string | null;
  message_id: number | null;
  status: string;
  created_at: Date;
  /** The reporter also blocked the user. */
  blocked: boolean;
}

/** Admin wire shape (PROTOCOL.md section 9). */
export interface ReportDict {
  report_id: number;
  reporter_id: string | null;
  reported_id: string | null;
  reason: string | null;
  category: string | null;
  message_id: number | null;
  status: string;
  created_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
}

export function reportDict(r: any): ReportDict {
  return {
    report_id: Number(r.id),
    reporter_id: r.reporter_id ?? null,
    reported_id: r.reported_id ?? null,
    reason: r.reason ?? null,
    category: r.category ?? null,
    message_id: r.message_id === null || r.message_id === undefined ? null : Number(r.message_id),
    status: r.status,
    created_at: iso(r.created_at),
    resolved_at: iso(r.resolved_at),
    resolved_by: r.resolved_by ?? null,
    note: r.note ?? null,
  };
}

const isUniqueViolation = (err: unknown): boolean => /unique|duplicate/i.test(String((err as Error)?.message ?? err)) || (err as any)?.code === "23505";

export class ModerationService {
  readonly dialect: Dialect;

  constructor(
    private db: Db,
    dialect?: Dialect,
  ) {
    this.dialect = dialect ?? detectDialect(db);
  }

  // --------------------------------------------------------------- blocks

  /** True if a new block was stored (blocking twice is a no-op). */
  async block(blockerId: string, blockedId: string): Promise<boolean> {
    if (await this.hasBlocked(blockerId, blockedId)) return false;
    try {
      await this.db.insertInto("comms_blocks").values({ blocker_id: blockerId, blocked_id: blockedId, created_at: dbTimestamp(this.dialect) }).execute();
    } catch (err) {
      if (isUniqueViolation(err)) return false; // concurrent duplicate
      throw err;
    }
    return true;
  }

  async unblock(blockerId: string, blockedId: string): Promise<boolean> {
    const r = await this.db.deleteFrom("comms_blocks").where("blocker_id", "=", blockerId).where("blocked_id", "=", blockedId).executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }

  async hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    const r = await this.db.selectFrom("comms_blocks").select("id").where("blocker_id", "=", blockerId).where("blocked_id", "=", blockedId).limit(1).executeTakeFirst();
    return r !== undefined;
  }

  /** Either direction. */
  async isBlockedBetween(userA: string, userB: string): Promise<boolean> {
    const r = await this.db
      .selectFrom("comms_blocks")
      .select("id")
      .where((eb) =>
        eb.or([
          eb.and([eb("blocker_id", "=", userA), eb("blocked_id", "=", userB)]),
          eb.and([eb("blocker_id", "=", userB), eb("blocked_id", "=", userA)]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return r !== undefined;
  }

  /** `{otherId: [isBlocked, blockedByOther]}` for ids with any block. */
  async blockStatus(viewerId: string, otherIds: readonly string[]): Promise<Record<string, [boolean, boolean]>> {
    const ids = [...new Set(otherIds)].filter(Boolean);
    if (!ids.length) return {};
    const rows = await this.db
      .selectFrom("comms_blocks")
      .select(["blocker_id", "blocked_id"])
      .where((eb) =>
        eb.or([
          eb.and([eb("blocker_id", "=", viewerId), eb("blocked_id", "in", ids)]),
          eb.and([eb("blocked_id", "=", viewerId), eb("blocker_id", "in", ids)]),
        ]),
      )
      .execute();
    const status: Record<string, [boolean, boolean]> = {};
    for (const { blocker_id: blocker, blocked_id: blocked } of rows) {
      if (blocker === viewerId) {
        const cur = status[blocked] ?? [false, false];
        status[blocked] = [true, cur[1]];
      } else {
        const cur = status[blocker] ?? [false, false];
        status[blocker] = [cur[0], true];
      }
    }
    return status;
  }

  /** `[blockedId, blockedAt]`, newest first. */
  async listBlocked(blockerId: string): Promise<Array<[string, unknown]>> {
    const rows = await this.db.selectFrom("comms_blocks").select(["blocked_id", "created_at"]).where("blocker_id", "=", blockerId)
      .orderBy("created_at", "desc").orderBy("id", "desc").execute();
    return rows.map((r) => [r.blocked_id as string, r.created_at]);
  }

  // -------------------------------------------------------------- reports

  async createReport(
    reporterId: string,
    reportedId: string,
    opts: { reason?: string | null; category?: string | null; messageId?: number | null } = {},
  ): Promise<ReportInfo> {
    const reason = opts.reason === null || opts.reason === undefined ? null : String(opts.reason).trim().slice(0, MAX_REASON_CHARS) || null;
    const category = opts.category === null || opts.category === undefined ? null : String(opts.category).trim().toLowerCase().slice(0, MAX_CATEGORY_CHARS) || null;
    const messageId = opts.messageId ?? null;
    const now = new Date();
    const r = await this.db
      .insertInto("comms_reports")
      .values({ reporter_id: reporterId, reported_id: reportedId, reason, category, message_id: messageId, status: "open", created_at: dbTimestamp(this.dialect, now) })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { id: Number(r.id), reporter_id: reporterId, reported_id: reportedId, reason, category, message_id: messageId, status: "open", created_at: now, blocked: false };
  }

  // --------------------------------------------------------- admin review

  async getReport(reportId: number): Promise<ReportDict | null> {
    const row = await this.db.selectFrom("comms_reports").selectAll().where("id", "=", reportId).executeTakeFirst();
    return row ? reportDict(row) : null;
  }

  /** Newest first; `status` filters (open | resolved | dismissed). */
  async listReports(status?: string | null, limit = 50, offset = 0): Promise<ReportDict[]> {
    let q = this.db.selectFrom("comms_reports").selectAll();
    if (status) q = q.where("status", "=", status);
    const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).offset(offset).execute();
    return rows.map(reportDict);
  }

  /** Set a report to resolved / dismissed (or back to open). Null if it doesn't exist; throws Error on a bad status. */
  async resolveReport(reportId: number, status: string, resolvedBy: string | null = null, note: string | null = null): Promise<ReportDict | null> {
    if (!(REPORT_STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of: ${REPORT_STATUSES.join(", ")}`);
    const row = await this.db.selectFrom("comms_reports").selectAll().where("id", "=", reportId).executeTakeFirst();
    if (!row) return null;
    const patch: Record<string, unknown> = { status };
    if (status === "open") {
      patch.resolved_at = null;
      patch.resolved_by = null;
    } else {
      patch.resolved_at = dbTimestamp(this.dialect);
      patch.resolved_by = resolvedBy === null || resolvedBy === undefined ? null : String(resolvedBy).slice(0, 50) || null;
    }
    if (note !== null && note !== undefined) patch.note = String(note).trim().slice(0, MAX_NOTE_CHARS) || null;
    await this.db.updateTable("comms_reports").set(patch).where("id", "=", reportId).execute();
    return reportDict({ ...row, ...patch });
  }

  // ------------------------------------------------------------- deletion

  /**
   * Account deletion: drop every block involving `userId`; keep reports (moderation history) but replace the user's id
   * with NULL as reporter and as reported user. Use a transaction handle (`trx`) for `db` to make it atomic.
   */
  async deleteUserData(userId: string): Promise<{ blocks: number; reports_anonymized: number }> {
    const blocks = await this.db.deleteFrom("comms_blocks").where((eb) => eb.or([eb("blocker_id", "=", userId), eb("blocked_id", "=", userId)])).executeTakeFirst();
    const asReporter = await this.db.updateTable("comms_reports").set({ reporter_id: null }).where("reporter_id", "=", userId).executeTakeFirst();
    const asReported = await this.db.updateTable("comms_reports").set({ reported_id: null }).where("reported_id", "=", userId).executeTakeFirst();
    return { blocks: Number(blocks.numDeletedRows), reports_anonymized: Number(asReporter.numUpdatedRows) + Number(asReported.numUpdatedRows) };
  }
}
