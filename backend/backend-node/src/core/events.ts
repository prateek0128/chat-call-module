/**
 * Tiny in-process async event bus.
 *
 * Events emitted by the kit: user.connected(userId), user.disconnected(userId),
 * user.came_online(userId), user.deleted(userId), chat.message_sent(message),
 * chat.system_message_sent(message), chat.message_deleted({chat_id, message_id, for_everyone, user_id}),
 * call.finalized(info), moderation.blocked / unblocked(blockerId, blockedId),
 * moderation.reported(report), moderation.report_resolved(report).
 */
import { logger } from "./logger.js";

export type Listener = (...args: any[]) => unknown | Promise<unknown>;

export class EventBus {
  private listeners = new Map<string, Listener[]>();

  on(name: string, listener: Listener): Listener {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
    return listener;
  }

  off(name: string, listener: Listener): void {
    const list = this.listeners.get(name);
    if (!list) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }

  /** Run listeners in registration order; a failing listener is logged, not thrown. */
  async emit(name: string, ...args: unknown[]): Promise<void> {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try {
        await listener(...args);
      } catch (err) {
        logger.error(`Listener for ${name} failed`, err);
      }
    }
  }
}
