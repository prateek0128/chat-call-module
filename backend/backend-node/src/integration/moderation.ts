/**
 * Moderation wiring (port of commskit.integration.moderation): the block list in front of the chat / call policies, and
 * live calls between a pair end when one blocks the other.
 *
 * `src/moderation` never imports chat or call; it emits `moderation.blocked` on the hub's event bus and exposes policy
 * wrappers. This module connects the two sides. It only uses structural types for chat and call (so it compiles without the
 * call module), and loads the chat module lazily, only when a chat feature is linked.
 */
import type { CommsHub } from "../core/hub.js";
import {
  type CallPolicyLike, type ChatPolicyLike, type ModerationFeature, ModerationCallPolicy, ModerationChatPolicy,
} from "../moderation/index.js";

export const BLOCKED_END_REASON = "blocked";

/** The slice of `ChatFeature` the link needs. */
export interface LinkableChat {
  readonly hub: CommsHub;
  policy: ChatPolicyLike;
}

/** The slice of `CallFeature` the link needs (`CallFeature.lifecycle.endCallsBetween`). */
export interface CallLifecycleLike {
  endCallsBetween(userA: string, userB: string, reason: string, endedBy?: string | null): Promise<unknown>;
}
export interface LinkableCall {
  readonly hub: CommsHub;
  policy: CallPolicyLike;
  readonly lifecycle: CallLifecycleLike;
}

export class ModerationLink {
  constructor(
    readonly moderation: ModerationFeature,
    readonly chat: LinkableChat | null = null,
    readonly call: LinkableCall | null = null,
  ) {}

  /** `moderation.blocked` listener. */
  async endCallsOnBlock(blockerId: string, blockedId: string): Promise<void> {
    if (this.call) await this.call.lifecycle.endCallsBetween(blockerId, blockedId, BLOCKED_END_REASON, blockerId);
  }

  /**
   * `ModerationFeature.contextProvider`: MessageDtos (as the reporter sees them, newest first) around `messageId` in the
   * pair's chat, or the latest ones. Hides / clears are ignored.
   */
  async reportMessages(
    reporterId: string | null,
    reportedId: string | null,
    messageId: number | null,
    before: number,
    after: number,
  ): Promise<Array<Record<string, any>>> {
    if (!this.chat || !reporterId || !reportedId) return [];
    const { ChatService, messageDto } = await import("../chat/index.js");
    const hub = this.chat.hub;
    const service = new ChatService(hub.db, hub.dialect);
    const chat = await service.getChatBetween(reporterId, reportedId);
    if (!chat) return [];
    const rows = await service.messagesAround(chat.id, messageId, before, after);
    const previews = await service.getReplyPreviews(rows.map((m) => m.reply_to_id));
    return rows.map((m) => messageDto(m, reporterId, m.reply_to_id ? (previews.get(m.reply_to_id) ?? null) : null));
  }
}

/**
 * Install-time wiring; all given features must be installed on the same hub.
 * - `chat.policy` becomes `moderation.chatPolicy(<previous policy>)`: a blocked pair cannot send_message / media_upload
 *   (error) or typing (dropped), and `res_users` / `res_messages.info` carry `is_blocked` / `blocked_by_other`.
 * - `call.policy` becomes `moderation.callPolicy(<previous policy>)`: call_initiate to/from a blocked user is denied before
 *   the host policy runs (no credits charged).
 * - on block, live calls between the pair end with `end_reason: "blocked"`.
 * - with chat: `moderation.contextProvider` (unless the host set one) reads the chat tables for the admin
 *   `/moderation/admin/reports/:id/context` route.
 * Policies already wrapped (e.g. `new ChatFeature({ policy: moderation.chatPolicy(...) })`) are not wrapped twice.
 */
export function linkModeration(moderation: ModerationFeature, features: { chat?: LinkableChat | null; call?: LinkableCall | null } = {}): ModerationLink {
  const hub = moderation.hub;
  const { chat = null, call = null } = features;
  for (const f of [chat, call]) {
    if (f && f.hub !== hub) throw new Error("moderation, chat and call must be installed on the same CommsHub");
  }
  if (moderation.link) throw new Error("moderation is already linked");

  if (chat && !(chat.policy instanceof ModerationChatPolicy)) chat.policy = moderation.chatPolicy(chat.policy);
  if (call && !(call.policy instanceof ModerationCallPolicy)) call.policy = moderation.callPolicy(call.policy);

  const link = new ModerationLink(moderation, chat, call);
  if (chat && !moderation.contextProvider) moderation.contextProvider = (a, b, m, bf, af) => link.reportMessages(a, b, m, bf, af);
  hub.events.on("moderation.blocked", (blocker: string, blocked: string) => link.endCallsOnBlock(blocker, blocked));
  moderation.link = link;
  return link;
}
