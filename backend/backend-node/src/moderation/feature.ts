/** `hub.install(new ModerationFeature({...}))` (port of commskit.moderation.feature). Imports only core. */
import type { Db } from "../core/db.js";
import type { CommsHub, Feature } from "../core/hub.js";
import type { RestContext } from "../core/rest.js";
import { ModerationActions, ModerationHandlers } from "./handlers.js";
import { type CallPolicyLike, type ChatPolicyLike, ModerationCallPolicy, ModerationChatPolicy } from "./policy.js";
import { buildModerationRoutes } from "./router.js";
import { ModerationService, type ReportDict, type ReportInfo } from "./service.js";

export type ReportHook = (report: ReportInfo) => Promise<void> | void;
/** `contextProvider(reporterId, reportedId, messageId, before, after)` -> MessageDto list (newest first). Set by linkModeration. */
export type ContextProvider = (
  reporterId: string | null,
  reportedId: string | null,
  messageId: number | null,
  before: number,
  after: number,
) => Promise<Array<Record<string, any>>>;
/** Authenticates a moderator for the admin routes: return their id, or throw an `HttpError` (401 / 403). */
export type AdminDependency = (ctx: RestContext) => Promise<string | number | null | undefined> | string | number | null | undefined;

export interface ModerationFeatureOptions {
  onReport?: ReportHook;
  /** Send `blocked_by_user` / `unblocked_by_user` to the other user (default true, for compatibility). */
  notifyBlockedUser?: boolean;
  /** When set, mounts `/moderation/admin/reports...`. */
  adminDependency?: AdminDependency;
  contextProvider?: ContextProvider;
}

/**
 * Block list + reports. Installs WS handlers `report_and_block` / `block` / `unblock` and `/moderation/...` REST routes.
 * It does not touch chat or call by itself: wrap your policies (`chatPolicy(inner)` / `callPolicy(inner)`) or use
 * `linkModeration(moderation, { chat, call })`, which also ends a live call between the pair on block.
 *
 * Events on `hub.events`: `moderation.blocked(blockerId, blockedId)`, `moderation.unblocked(blockerId, blockedId)`,
 * `moderation.reported(ReportInfo)`, `moderation.report_resolved(report)`.
 */
export class ModerationFeature implements Feature {
  readonly name = "moderation";
  onReport?: ReportHook;
  notifyBlockedUser: boolean;
  adminDependency?: AdminDependency;
  contextProvider?: ContextProvider;
  actions!: ModerationActions;
  handlers!: ModerationHandlers;
  /** Set by linkModeration. */
  link: unknown = null;
  private _hub: CommsHub | null = null;

  constructor(opts: ModerationFeatureOptions = {}) {
    this.onReport = opts.onReport;
    this.notifyBlockedUser = opts.notifyBlockedUser ?? true;
    this.adminDependency = opts.adminDependency;
    this.contextProvider = opts.contextProvider;
  }

  get hub(): CommsHub {
    if (!this._hub) throw new Error("ModerationFeature is not installed; call hub.install(feature) first");
    return this._hub;
  }

  install(hub: CommsHub): this {
    hub.registerFeature(this.name, this);
    this._hub = hub;
    this.actions = new ModerationActions(this);
    this.handlers = new ModerationHandlers(this);
    this.handlers.register();
    hub.includeRoutes(buildModerationRoutes(this));
    return this;
  }

  private service(db?: Db): ModerationService {
    return new ModerationService(db ?? this.hub.db, this.hub.dialect);
  }

  // ------------------------------------------------------------ policies

  /** ChatPolicy: refuses a blocked pair, otherwise asks `inner` (allow-all if null). */
  chatPolicy(inner: ChatPolicyLike | null = null): ModerationChatPolicy {
    return new ModerationChatPolicy(inner);
  }

  /** CallPolicy: denies a blocked pair (`reason: "blocked"`), otherwise `inner`. */
  callPolicy(inner: CallPolicyLike | null = null): ModerationCallPolicy {
    return new ModerationCallPolicy(inner);
  }

  // -------------------------------------------------------------- queries

  /** `{otherId: [isBlocked, blockedByOther]}` for `res_users` / `res_messages.info`. */
  blockStatus(viewerId: string, otherIds: readonly string[], db?: Db): Promise<Record<string, [boolean, boolean]>> {
    return this.service(db).blockStatus(viewerId, otherIds);
  }

  isBlockedBetween(userA: string, userB: string, db?: Db): Promise<boolean> {
    return this.service(db).isBlockedBetween(userA, userB);
  }

  // --------------------------------------------------------- admin review

  listReports(status: string | null = null, opts: { limit?: number; offset?: number } = {}): Promise<ReportDict[]> {
    return this.service().listReports(status, opts.limit ?? 50, opts.offset ?? 0);
  }

  /** `status`: resolved | dismissed (| open). Null if the report doesn't exist. */
  async resolveReport(reportId: number, status: string, opts: { resolvedBy?: string | null; note?: string | null } = {}): Promise<ReportDict | null> {
    const report = await this.service().resolveReport(reportId, status, opts.resolvedBy ?? null, opts.note ?? null);
    if (report) await this.hub.events.emit("moderation.report_resolved", report);
    return report;
  }

  /**
   * `{report, messages}`: messages around the reported message (or the latest between the pair), newest first, from
   * `contextProvider` (empty without one, e.g. call-only apps).
   */
  async reportContext(reportId: number, opts: { before?: number; after?: number } = {}): Promise<{ report: ReportDict; messages: Array<Record<string, any>> } | null> {
    const report = await this.service().getReport(reportId);
    if (!report) return null;
    let messages: Array<Record<string, any>> = [];
    if (this.contextProvider && report.reporter_id && report.reported_id) {
      messages = [...(await this.contextProvider(report.reporter_id, report.reported_id, report.message_id, Math.max(0, opts.before ?? 20), Math.max(0, opts.after ?? 20)))];
    }
    return { report, messages };
  }

  // ------------------------------------------------------------- deletion

  /**
   * Account deletion: blocks involving the user are deleted; reports are kept for the moderation history with the user's
   * id set to NULL (as reporter and as reported user).
   */
  async deleteUserData(userId: string): Promise<{ blocks: number; reports_anonymized: number }> {
    const hub = this.hub;
    return hub.db.transaction().execute((trx) => new ModerationService(trx, hub.dialect).deleteUserData(String(userId)));
  }
}
