/**
 * ModerationStore — block list + reports (PROTOCOL §7). Framework-free: plain subscribe /
 * getSnapshot (works with useSyncExternalStore or outside React).
 *
 * Writes go over REST (definite result, works while the socket reconnects) with optimistic
 * updates that roll back on failure; the server's WS events (`user_blocked`, `blocked_by_user`,
 * `user_unblocked`, `unblocked_by_user`) and the `is_blocked` / `blocked_by_other` flags in
 * `res_users` / `res_messages.info` keep the state in sync across devices.
 */
import { authFetch, type CommsConfig, type Logger } from "../core/config";
import type { UserId } from "../core/types";

/** Suggested report categories (§7). Free text is allowed too. */
export const REPORT_CATEGORIES = ["spam", "harassment", "inappropriate", "fake_profile", "scam", "underage", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  spam: "Spam",
  harassment: "Harassment or bullying",
  inappropriate: "Inappropriate content",
  fake_profile: "Fake profile",
  scam: "Scam or fraud",
  underage: "Underage user",
  other: "Something else",
};

export interface BlockedUser {
  userId: UserId;
  username?: string | null;
  avatar?: string | null;
  blockedAt?: string | null;
}

export interface ReportInput {
  peerId: UserId;
  /** Free-text reason (optional in the UI; sent as "" when empty). */
  reason?: string;
  category?: ReportCategory | string;
  messageId?: string | number;
  /** Also block (default true, like the Smart Matrimony app). */
  block?: boolean;
}

export interface ModerationSnapshot {
  /** Users I blocked. */
  blockedIds: readonly UserId[];
  /** Users who blocked me (only when the server notifies, §7). */
  blockedByIds: readonly UserId[];
  /** Last list from `GET /moderation/blocks` (names / avatars), kept in sync with blockedIds. */
  blockedUsers: readonly BlockedUser[];
  version: number;
}

/** The subset of CommsClient the store needs. */
export interface ModerationTransport {
  on(type: string, handler: (message: any) => void): () => void;
  /** Deliver a frame locally (CommsClient.dispatchLocal) so ChatStore etc. see block changes immediately. */
  dispatchLocal?(message: { type: string; [key: string]: unknown }): void;
}

export interface ModerationStoreOptions {
  config: Pick<CommsConfig, "baseUrl" | "getToken" | "logger">;
  /** The CommsClient (optional: without it the store is REST-only). */
  client?: ModerationTransport;
  logger?: Logger;
}

export type ModerationErrorListener = (error: { message: string; peerId?: UserId; raw?: unknown }) => void;

export const MODERATION_EVENT_TYPES = ["user_blocked", "user_unblocked", "blocked_by_user", "unblocked_by_user", "report_received", "res_users", "res_messages", "error"] as const;

const id = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export class ModerationStore {
  private blocked = new Set<string>();
  private blockedBy = new Set<string>();
  private users = new Map<string, BlockedUser>();
  private listeners = new Set<() => void>();
  private errorListeners = new Set<ModerationErrorListener>();
  private snapshot: ModerationSnapshot = { blockedIds: [], blockedByIds: [], blockedUsers: [], version: 0 };
  private readonly options: ModerationStoreOptions;

  constructor(options: ModerationStoreOptions) {
    this.options = options;
  }

  // ---- subscription ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ModerationSnapshot => this.snapshot;

  onError(listener: ModerationErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Subscribe to the client's moderation-related frames. Returns a detach function. */
  attach(client: ModerationTransport | undefined = this.options.client): () => void {
    if (!client) return () => {};
    const offs = MODERATION_EVENT_TYPES.map((type) => client.on(type, (msg) => this.handle(msg)));
    return () => offs.forEach((off) => off());
  }

  // ---- queries ---------------------------------------------------------------

  isBlocked = (peerId: UserId | null | undefined): boolean => peerId != null && this.blocked.has(String(peerId));
  blockedByOther = (peerId: UserId | null | undefined): boolean => peerId != null && this.blockedBy.has(String(peerId));
  /** Either direction: no messages or calls between the pair. */
  isBlockedPair = (peerId: UserId | null | undefined): boolean => this.isBlocked(peerId) || this.blockedByOther(peerId);

  // ---- server events ---------------------------------------------------------

  handle(message: { type: string; [key: string]: unknown }): void {
    const m = message as any;
    const peer = id(m.candidate_user_id ?? m.user_id);
    switch (m.type) {
      case "user_blocked":
        if (peer && !m.local) this.set(peer, { blocked: true });
        return;
      case "user_unblocked":
        if (peer && !m.local) this.set(peer, { blocked: false });
        return;
      case "blocked_by_user":
        if (peer && !m.local) this.set(peer, { blockedBy: true });
        return;
      case "unblocked_by_user":
        if (peer && !m.local) this.set(peer, { blockedBy: false });
        return;
      case "res_users":
        if (Array.isArray(m.users)) for (const u of m.users) this.applyFlags(id(u?.user_id), u);
        return;
      case "res_messages":
        if (m.info) this.applyFlags(id(m.info.user_id), m.info);
        return;
      case "error":
        if (m.context === "moderation") this.emitError({ message: String(m.error || "Moderation request failed"), raw: m });
        return;
    }
  }

  // ---- commands --------------------------------------------------------------

  /** `POST /moderation/blocks` (optimistic). */
  async block(peerId: UserId): Promise<void> {
    const peer = String(peerId);
    await this.optimistic(peer, { blocked: true }, () => authFetch(this.options.config, "/moderation/blocks", { method: "POST", body: { user_id: peer } }));
  }

  /** `DELETE /moderation/blocks/{user_id}` (optimistic). */
  async unblock(peerId: UserId): Promise<void> {
    const peer = String(peerId);
    await this.optimistic(peer, { blocked: false }, () =>
      authFetch(this.options.config, `/moderation/blocks/${encodeURIComponent(peer)}`, { method: "DELETE" }),
    );
  }

  /** `POST /moderation/reports`; blocks too unless `block: false`. Resolves with the report id. */
  async report(input: ReportInput): Promise<{ reportId: string | null }> {
    const peer = String(input.peerId);
    const block = input.block !== false;
    const body: Record<string, unknown> = { user_id: peer, reason: (input.reason || "").trim(), block };
    if (input.category) body.category = input.category;
    if (input.messageId !== undefined && input.messageId !== null) body.message_id = input.messageId;
    const send = () => authFetch<{ report_id?: unknown }>(this.options.config, "/moderation/reports", { method: "POST", body });
    const res = block ? await this.optimistic(peer, { blocked: true }, send) : await send();
    return { reportId: id(res?.report_id) };
  }

  /** `GET /moderation/blocks` — replaces the local block list. */
  async listBlocked(): Promise<BlockedUser[]> {
    const rows = await authFetch<any[]>(this.options.config, "/moderation/blocks");
    const list: BlockedUser[] = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ userId: id(r?.user_id) as string, username: r?.username ?? null, avatar: r?.avatar ?? null, blockedAt: r?.blocked_at ?? null }))
      .filter((u) => !!u.userId);
    this.blocked = new Set(list.map((u) => u.userId));
    this.users = new Map(list.map((u) => [u.userId, u]));
    this.commit();
    return list;
  }

  // ---- internals ---------------------------------------------------------------

  private applyFlags(peer: string | null, flags: { is_blocked?: unknown; blocked_by_other?: unknown }): void {
    if (!peer) return;
    const patch: { blocked?: boolean; blockedBy?: boolean } = {};
    if (flags.is_blocked !== undefined && flags.is_blocked !== null) patch.blocked = !!flags.is_blocked;
    if (flags.blocked_by_other !== undefined && flags.blocked_by_other !== null) patch.blockedBy = !!flags.blocked_by_other;
    if (Object.keys(patch).length) this.set(peer, patch);
  }

  private set(peer: string, patch: { blocked?: boolean; blockedBy?: boolean }, notifyLocal = false): void {
    let changed = false;
    if (patch.blocked !== undefined && patch.blocked !== this.blocked.has(peer)) {
      changed = true;
      if (patch.blocked) this.blocked.add(peer);
      else {
        this.blocked.delete(peer);
        this.users.delete(peer);
      }
      if (notifyLocal)
        this.options.client?.dispatchLocal?.({ type: patch.blocked ? "user_blocked" : "user_unblocked", candidate_user_id: peer, local: true });
    }
    if (patch.blockedBy !== undefined && patch.blockedBy !== this.blockedBy.has(peer)) {
      changed = true;
      if (patch.blockedBy) this.blockedBy.add(peer);
      else this.blockedBy.delete(peer);
    }
    if (changed) this.commit();
  }

  private async optimistic<T>(peer: string, patch: { blocked: boolean }, request: () => Promise<T>): Promise<T> {
    const before = this.blocked.has(peer);
    this.set(peer, patch, true);
    try {
      return await request();
    } catch (e) {
      this.set(peer, { blocked: before }, true);
      this.emitError({ message: e instanceof Error ? e.message : String(e), peerId: peer, raw: e });
      throw e;
    }
  }

  private emitError(error: { message: string; peerId?: UserId; raw?: unknown }): void {
    (this.options.logger || this.options.config.logger)?.warn("moderation", error.message);
    this.errorListeners.forEach((l) => l(error));
  }

  private commit(): void {
    const blockedIds = Array.from(this.blocked);
    this.snapshot = {
      blockedIds,
      blockedByIds: Array.from(this.blockedBy),
      blockedUsers: blockedIds.map((u) => this.users.get(u) || { userId: u }),
      version: this.snapshot.version + 1,
    };
    this.listeners.forEach((l) => l());
  }
}
