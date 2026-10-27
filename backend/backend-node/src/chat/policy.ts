/** ChatPolicy: host rules for who may message whom (blocking, consent...). */
import type { Db } from "../core/db.js";

export interface ChatPolicy {
  /** Sent as `{"type":"error","error": refusalMessage}` when `canMessage` is false. */
  refusalMessage: string;
  /** False refuses send_message / media_upload and silently drops typing. */
  canMessage(db: Db, senderId: string, recipientId: string): Promise<boolean>;
  /** `{otherId: [isBlocked, blockedByOther]}`; missing ids = [false, false]. */
  blockStatus(db: Db, viewerId: string, otherIds: readonly string[]): Promise<Record<string, [boolean, boolean]>>;
  /** Merged into `res_messages.info` (e.g. `chat_consent_given`). */
  extraConversationInfo(db: Db, viewerId: string, otherId: string): Promise<Record<string, unknown>>;
}

/** Default: everyone may message everyone, nobody is blocked. */
export class AllowAllChatPolicy implements ChatPolicy {
  refusalMessage = "Cannot send message. User is blocked.";
  async canMessage(): Promise<boolean> {
    return true;
  }
  async blockStatus(): Promise<Record<string, [boolean, boolean]>> {
    return {};
  }
  async extraConversationInfo(): Promise<Record<string, unknown>> {
    return { chat_consent_given: true };
  }
}
