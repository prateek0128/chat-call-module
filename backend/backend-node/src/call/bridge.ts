/** Hook points a chat integration plugs into (`CallFeature.chatBridge`). The call feature never imports chat. */
import type { Db } from "../core/db.js";
import type { CallInfo } from "./service.js";

export interface CallChatBridge {
  /** chat_id stored on the call (null = no chat). */
  resolveChatId(db: Db, callerId: string, receiverId: string, requestedChatId: unknown): Promise<number | null>;
  /** Call row committed; e.g. insert the "[Call Initiated]" chat entry. */
  onCallCreated(db: Db, info: CallInfo): Promise<void>;
  /**
   * Inside the finalize transaction (`trx` is the transaction: never use another connection, never commit).
   * May set `info.messageId` / `info.logText`; they are committed atomically with the terminal status.
   */
  onCallFinalizing(trx: Db, info: CallInfo): Promise<void>;
}
