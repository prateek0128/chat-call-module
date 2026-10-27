/** Shared types for the native call notifiers. Pure. */
import type { CallNotifier, NotificationAction } from "../call/adapters";

/** Actions coming from the system call UI (CallKit / notification buttons). */
export type NativeCallAction = NotificationAction | "mute" | "unmute";
export type NativeCallActionHandler = (action: NativeCallAction, callId: string) => void;

/**
 * A CallNotifier backed by the OS call UI. Actions are queued until a handler is attached
 * (cold start: the user answered before React mounted), then delivered in order.
 */
export interface NativeCallNotifier extends CallNotifier {
  readonly kind: "callkit" | "android" | "none";
  setActionHandler(handler: NativeCallActionHandler | null): void;
  /** Mirror the in-app mute state into the system UI (CallKit). */
  setMuted(callId: string, muted: boolean): void;
  /** Remove native listeners. */
  dispose(): void;
}

/** Action queue used by the notifiers. */
export const createActionQueue = () => {
  let handler: NativeCallActionHandler | null = null;
  const queue: Array<[NativeCallAction, string]> = [];
  return {
    set(next: NativeCallActionHandler | null) {
      handler = next;
      while (handler && queue.length) {
        const [action, callId] = queue.shift() as [NativeCallAction, string];
        handler(action, callId);
      }
    },
    emit(action: NativeCallAction, callId: string) {
      if (handler) handler(action, callId);
      else queue.push([action, callId]);
    },
  };
};

export const noopNativeNotifier = (): NativeCallNotifier => ({
  kind: "none",
  showIncoming: () => {},
  dismiss: () => {},
  startOngoing: () => {},
  stopOngoing: () => {},
  setActionHandler: () => {},
  setMuted: () => {},
  dispose: () => {},
});
