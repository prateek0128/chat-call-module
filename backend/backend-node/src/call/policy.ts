/** CallPolicy: host gate for starting a call (blocking, credits...). */
import type { Db } from "../core/db.js";

export interface CallDecision {
  allowed: boolean;
  /** On deny, sent as {"type":"error", ...error, "context":"call"}; e.g. {error, status: 402, message, info}. */
  error?: Record<string, unknown> | null;
}

export const allow = (): CallDecision => ({ allowed: true });
export const deny = (error: string, fields: Record<string, unknown> = {}): CallDecision => ({
  allowed: false,
  error: { error, ...fields },
});

export interface CallPolicy {
  /**
   * Runs after busy detection, right before the call row is created. `message` is the raw `call_initiate`
   * frame (host fields such as `credit_acknowledged` are available). Charging here is safe: busy receivers
   * never reach this point.
   */
  authorize(db: Db, callerId: string, receiverId: string, message: Record<string, any>): Promise<CallDecision> | CallDecision;
}

export class AllowAllCallPolicy implements CallPolicy {
  authorize(): CallDecision {
    return allow();
  }
}
