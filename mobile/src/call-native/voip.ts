/**
 * iOS PushKit token + VoIP pushes (react-native-voip-push-notification, optional peer — lazily
 * required only here). The push itself is reported to CallKit natively in AppDelegate (iOS 13+
 * kills apps that don't do it synchronously; app.plugin.js adds that code). JS learns the
 * token (-> `POST /devices` voip_token) and the payload (-> call id <-> CallKit UUID mapping).
 */
import type { Logger } from "../core/config";
import { parseNotificationData, type IncomingCallPushData } from "../core/push";

export const loadVoipPush = (): any => {
  try {
    const mod = require("react-native-voip-push-notification");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
};

export interface VoipPushOptions {
  /** A VoIP push arrived (already shown by CallKit). */
  onIncomingCall?: (call: IncomingCallPushData) => void;
  /** Usually the CallKit notifier: learns the call id <-> UUID mapping from each push. */
  notifier?: { rememberCall(callId: string, uuid?: string): void };
  /** Call `registerVoipToken()` from JS too (default true; harmless when AppDelegate registered). */
  register?: boolean;
  /** Inject the module (tests). */
  voipPush?: any;
  logger?: Logger;
}

const REGISTERED = "RNVoipPushRemoteNotificationsRegisteredEvent";
const RECEIVED = "RNVoipPushRemoteNotificationReceivedEvent";

/**
 * Listen for the PushKit token (`onToken`, also replayed from cold-start events) and VoIP pushes.
 * Pass the token to `registerDevice({ getVoipToken })` from commskit/notifications.
 * Returns an unsubscribe function.
 */
export const registerVoipPush = (onToken: (token: string) => void, options: VoipPushOptions = {}): (() => void) => {
  const Voip = options.voipPush || loadVoipPush();
  if (!Voip) throw new Error("[comms] registerVoipPush needs react-native-voip-push-notification: npx expo install react-native-voip-push-notification");
  let lastToken: string | null = null;
  const token = (t: unknown) => {
    if (typeof t !== "string" || !t || t === lastToken) return;
    lastToken = t;
    onToken(t);
  };
  const notification = (payload: any) => {
    const data = parseNotificationData(payload);
    if (data?.type === "incoming_call") {
      options.notifier?.rememberCall(data.callId, data.uuid);
      options.onIncomingCall?.(data);
    }
    // Tell PushKit we are done (the completion handler was also passed to CallKit natively).
    const uuid = payload?.uuid ?? data?.raw?.uuid;
    if (uuid) {
      try {
        Voip.onVoipNotificationCompleted?.(uuid);
      } catch {
        /* not registered natively */
      }
    }
  };
  Voip.addEventListener("register", token);
  Voip.addEventListener("notification", notification);
  Voip.addEventListener("didLoadWithEvents", (events: any) => {
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      if (ev?.name === REGISTERED) token(ev.data);
      else if (ev?.name === RECEIVED) notification(ev.data);
    }
  });
  if (options.register !== false) {
    try {
      Voip.registerVoipToken();
    } catch (e) {
      options.logger?.warn("registerVoipToken failed", e);
    }
  }
  return () => {
    for (const name of ["register", "notification", "didLoadWithEvents"]) {
      try {
        Voip.removeEventListener(name);
      } catch {
        /* ignore */
      }
    }
  };
};
