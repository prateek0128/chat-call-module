/**
 * Android: incoming calls while the app is killed. Data-only `incoming_call` pushes (backend
 * `android_call_style = "data"`) wake an expo-notifications background task (expo-task-manager),
 * which shows the notifee full-screen call notification. Decline while killed ->
 * `POST /call/{call_id}/reject` with the stored session (saveCallSession).
 *
 * expo-notifications / expo-task-manager are optional peers, lazily required only here in call-native.
 * Call `registerBackgroundCallHandler()` at module scope in your entry file (index.js), before
 * registerRootComponent — background tasks must be defined before the app renders.
 */
import type { Logger } from "../core/config";
import { parseNotificationData } from "../core/push";
import {
  callActionFromNotifeeEvent,
  cancelCallNotification,
  displayIncomingCallNotification,
  onNotifeeBackgroundEvent,
  routeToLiveNotifier,
  type AndroidCallNotificationOptions,
} from "./android";
import { defaultSessionStorage, rejectCallWithStoredSession, type KeyValueStorage } from "./session";

export const BACKGROUND_CALL_TASK = "commskit-background-call";

const loadTaskManager = (): any => {
  try {
    return require("expo-task-manager");
  } catch {
    return null;
  }
};
const loadExpoNotifications = (): any => {
  try {
    return require("expo-notifications");
  } catch {
    return null;
  }
};

export interface BackgroundCallHandlerOptions {
  /** Where saveCallSession() stored `{baseUrl, token}` (default: async-storage). */
  storage?: KeyValueStorage;
  taskName?: string;
  /** Look of the call notification (channel, texts, icon). */
  notification?: AndroidCallNotificationOptions;
  /** Inject modules (tests). */
  taskManager?: any;
  notifications?: any;
  notifee?: any;
  logger?: Logger;
}

export interface BackgroundCallHandler {
  taskName: string;
  /** What the background task does with one payload (exposed for tests). */
  handlePush(payload: unknown): Promise<void>;
  /** What notifee's background event handler does (exposed for tests). */
  handleNotifeeEvent(event: unknown): Promise<void>;
}

export const registerBackgroundCallHandler = (options: BackgroundCallHandlerOptions = {}): BackgroundCallHandler => {
  const TaskManager = options.taskManager || loadTaskManager();
  const Notifications = options.notifications || loadExpoNotifications();
  if (!TaskManager || !Notifications) {
    throw new Error("[comms] registerBackgroundCallHandler needs expo-task-manager and expo-notifications: npx expo install expo-task-manager expo-notifications");
  }
  const taskName = options.taskName || BACKGROUND_CALL_TASK;
  const storage = options.storage || defaultSessionStorage();
  const notifee = options.notification?.notifee || options.notifee;
  const log = options.logger;

  const handlePush = async (payload: unknown) => {
    const data = parseNotificationData(payload);
    if (data?.type === "incoming_call") {
      await displayIncomingCallNotification(
        { callId: data.callId, peerId: data.callerId, peerName: data.callerName, peerAvatar: data.callerAvatar, callType: data.callType },
        { ...(options.notification || {}), notifee, fromPush: true },
      );
    } else if (data?.type === "missed_call" && data.callId) {
      await cancelCallNotification(data.callId, notifee); // caller gave up / timed out
    }
  };

  const handleNotifeeEvent = async (event: unknown) => {
    const hit = callActionFromNotifeeEvent(notifee || { EventType: undefined }, event);
    if (!hit) return;
    if (hit.action === "decline" || hit.action === "answer") await cancelCallNotification(hit.callId, notifee).catch(() => {});
    if (routeToLiveNotifier(hit.action, hit.callId)) return; // app is running: the CallProvider handles it
    if (hit.action === "decline") {
      const ok = await rejectCallWithStoredSession(hit.callId, storage);
      if (!ok) log?.warn("background decline: no stored session or request failed", hit.callId);
    }
    // "answer" / "open" launch the app (launchActivity); the notifier picks them up via getInitialNotification.
  };

  TaskManager.defineTask(taskName, async ({ data, error }: { data?: unknown; error?: unknown }) => {
    if (error) return log?.warn("background notification task error", error);
    try {
      await handlePush(data);
    } catch (e) {
      log?.warn("background call notification failed", e);
    }
  });
  void Promise.resolve(Notifications.registerTaskAsync?.(taskName)).catch((e: unknown) => log?.warn("registerTaskAsync failed", e));
  onNotifeeBackgroundEvent((event) => handleNotifeeEvent(event), notifee);

  return { taskName, handlePush, handleNotifeeEvent };
};
