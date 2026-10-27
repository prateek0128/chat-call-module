/**
 * Chat / call policy wrappers that put the block list in front of the host's own policy (port of commskit.moderation.policy).
 *
 * They match the chat `ChatPolicy` and the call `CallPolicy` structurally, so this package never imports chat or call:
 *
 *   new ChatFeature({ policy: moderation.chatPolicy(myChatPolicy) })
 *   new CallFeature({ policy: moderation.callPolicy(myCreditPolicy) })
 *
 * or let `linkModeration` (src/integration) wrap the installed features' policies. A blocked pair (either direction) is refused
 * BEFORE the inner policy runs, so e.g. a credit-charging call policy never charges for a call that would be refused anyway.
 */
import type { Db } from "../core/db.js";
import { ModerationService } from "./service.js";

export const CHAT_REFUSAL = "Cannot send message. User is blocked.";
export const CALL_REFUSAL = "Cannot call. User is blocked.";

/** Same shape as the call feature's decision (`allowed`, `error`). */
export interface ModerationDecision {
  allowed: boolean;
  error?: Record<string, unknown> | null;
}

/** Structural view of a host chat policy. */
export interface ChatPolicyLike {
  refusalMessage?: string;
  canMessage(db: Db, senderId: string, recipientId: string): Promise<boolean>;
  blockStatus(db: Db, viewerId: string, otherIds: readonly string[]): Promise<Record<string, [boolean, boolean]>>;
  extraConversationInfo(db: Db, viewerId: string, otherId: string): Promise<Record<string, unknown>>;
}

/** Structural view of a host call policy. */
export interface CallPolicyLike {
  authorize(db: Db, callerId: string, receiverId: string, message: Record<string, any>): Promise<any> | any;
}

export class ModerationChatPolicy implements ChatPolicyLike {
  /**
   * The chat feature reads `refusalMessage` right after `canMessage` returned false; `lastRefusal` remembers whose refusal
   * it was (the block list or the inner policy). Both messages are constant per policy, so concurrent frames cannot mix
   * up different texts except when the host policy's message differs from the block text.
   */
  private lastRefusal: string | null = null;

  constructor(
    public inner: ChatPolicyLike | null = null,
    public blockedMessage: string = CHAT_REFUSAL,
  ) {}

  get refusalMessage(): string {
    return this.lastRefusal ?? this.inner?.refusalMessage ?? this.blockedMessage;
  }

  async canMessage(db: Db, senderId: string, recipientId: string): Promise<boolean> {
    if (await new ModerationService(db).isBlockedBetween(senderId, recipientId)) {
      this.lastRefusal = this.blockedMessage;
      return false;
    }
    if (this.inner && !(await this.inner.canMessage(db, senderId, recipientId))) {
      this.lastRefusal = this.inner.refusalMessage || this.blockedMessage;
      return false;
    }
    this.lastRefusal = null;
    return true;
  }

  /** Kit block list OR the inner policy's (e.g. a legacy host block table). */
  async blockStatus(db: Db, viewerId: string, otherIds: readonly string[]): Promise<Record<string, [boolean, boolean]>> {
    const merged: Record<string, [boolean, boolean]> = { ...(await new ModerationService(db).blockStatus(viewerId, otherIds)) };
    if (this.inner) {
      for (const [other, [blocked, byOther]] of Object.entries(await this.inner.blockStatus(db, viewerId, otherIds))) {
        const mine = merged[other] ?? [false, false];
        merged[other] = [mine[0] || Boolean(blocked), mine[1] || Boolean(byOther)];
      }
    }
    return merged;
  }

  async extraConversationInfo(db: Db, viewerId: string, otherId: string): Promise<Record<string, unknown>> {
    if (this.inner) return this.inner.extraConversationInfo(db, viewerId, otherId);
    return { chat_consent_given: true };
  }
}

export class ModerationCallPolicy implements CallPolicyLike {
  constructor(
    public inner: CallPolicyLike | null = null,
    public blockedMessage: string = CALL_REFUSAL,
  ) {}

  async authorize(db: Db, callerId: string, receiverId: string, message: Record<string, any>): Promise<ModerationDecision> {
    if (await new ModerationService(db).isBlockedBetween(callerId, receiverId)) {
      return { allowed: false, error: { error: this.blockedMessage, reason: "blocked" } };
    }
    if (this.inner) return this.inner.authorize(db, callerId, receiverId, message);
    return { allowed: true };
  }
}
