/**
 * Android call notifications with @notifee/react-native (optional peer — lazily required only
 * here in commskit/call-native): full-screen incoming-call notification (CATEGORY_CALL,
 * Answer / Decline), and an ongoing-call foreground-service notification (phoneCall|microphone).
 */
import type { Logger } from "../core/config";
import type { IncomingCallInfo, OngoingCallInfo } from "../call/adapters";
import { createActionQueue, type NativeCallAction, type NativeCallNotifier } from "./types";

export const loadNotifee = (): any => {
  try {
    const mod = require("@notifee/react-native");
    return mod ? { ...mod, api: mod.default ?? mod } : null;
  } catch {
    return null;
  }
};

const requireNotifee = (given?: any) => {
  const mod = given || loadNotifee();
  if (!mod) throw new Error("[comms] Android call notifications need @notifee/react-native: npx expo install @notifee/react-native");
  return mod;
};

export interface AndroidCallTexts {
  incomingAudio?: string;
  incomingVideo?: string;
  answer?: string;
  decline?: string;
  hangup?: string;
  ongoing?: string;
}

export interface AndroidCallNotificationOptions {
  /** Ringing channel (default "call_ringtone", the channel the backend pushes use). */
  channelId?: string;
  channelName?: string;
  /** Ongoing-call channel (low importance, default "call_ongoing"). */
  ongoingChannelId?: string;
  ongoingChannelName?: string;
  texts?: AndroidCallTexts;
  /** Small icon resource name (default: the app icon). */
  smallIcon?: string;
  /** Accent color of the notification. */
  color?: string;
  /** Stop ringing after this long (default 45 s = server ring timeout). */
  timeoutMs?: number;
  /** Inject the notifee module (tests): `{ api, AndroidImportance, AndroidCategory, EventType, ... }`. */
  notifee?: any;
  logger?: Logger;
}

export const CALL_NOTIFICATION_PREFIX = "commskit-call-";
export const ONGOING_NOTIFICATION_ID = "commskit-ongoing-call";
export const callNotificationId = (callId: string) => CALL_NOTIFICATION_PREFIX + callId;

const DEFAULT_TEXTS: Required<AndroidCallTexts> = {
  incomingAudio: "Incoming voice call",
  incomingVideo: "Incoming video call",
  answer: "Answer",
  decline: "Decline",
  hangup: "Hang up",
  ongoing: "Ongoing call",
};

const createdChannels = new Set<string>();
const ensureChannels = async (mod: any, o: AndroidCallNotificationOptions) => {
  const Importance = mod.AndroidImportance || {};
  const Visibility = mod.AndroidVisibility || {};
  const ringing = o.channelId || "call_ringtone";
  const ongoing = o.ongoingChannelId || "call_ongoing";
  if (!createdChannels.has(ringing)) {
    createdChannels.add(ringing);
    await mod.api.createChannel({
      id: ringing,
      name: o.channelName || "Incoming calls",
      importance: Importance.HIGH ?? 4,
      visibility: Visibility.PUBLIC ?? 1,
      sound: "default",
      vibration: true,
      vibrationPattern: [300, 1000, 300, 1000],
      bypassDnd: true,
    });
  }
  if (!createdChannels.has(ongoing)) {
    createdChannels.add(ongoing);
    await mod.api.createChannel({ id: ongoing, name: o.ongoingChannelName || "Ongoing calls", importance: Importance.LOW ?? 2, visibility: Visibility.PUBLIC ?? 1 });
  }
  return { ringing, ongoing };
};

/** Show the full-screen incoming-call notification (also used headless by the background handler). */
export const displayIncomingCallNotification = async (
  call: IncomingCallInfo,
  options: AndroidCallNotificationOptions & { fromPush?: boolean } = {},
): Promise<void> => {
  const mod = requireNotifee(options.notifee);
  const t = { ...DEFAULT_TEXTS, ...(options.texts || {}) };
  const { ringing } = await ensureChannels(mod, options);
  const data: Record<string, string> = { commskit: "incoming_call", call_id: call.callId, call_type: call.callType };
  if (call.peerId) data.caller_id = String(call.peerId);
  if (call.peerName) data.caller_name = call.peerName;
  if (options.fromPush) data.source = "push";
  await mod.api.displayNotification({
    id: callNotificationId(call.callId),
    title: call.peerName || "Unknown caller",
    body: call.callType === "video" ? t.incomingVideo : t.incomingAudio,
    data,
    android: {
      channelId: ringing,
      category: mod.AndroidCategory?.CALL ?? "call",
      importance: mod.AndroidImportance?.HIGH ?? 4,
      visibility: mod.AndroidVisibility?.PUBLIC ?? 1,
      ...(options.smallIcon ? { smallIcon: options.smallIcon } : {}),
      ...(options.color ? { color: options.color } : {}),
      ...(call.peerAvatar ? { largeIcon: call.peerAvatar, circularLargeIcon: true } : {}),
      ongoing: true,
      autoCancel: false,
      loopSound: true,
      lightUpScreen: true,
      timeoutAfter: options.timeoutMs ?? 45000,
      fullScreenAction: { id: "default", launchActivity: "default" },
      pressAction: { id: "default", launchActivity: "default" },
      actions: [
        { title: t.decline, pressAction: { id: "decline" } },
        { title: t.answer, pressAction: { id: "answer", launchActivity: "default" } },
      ],
    },
  });
};

/** Map a notifee event to a call action (null when it is not one of ours). */
export const callActionFromNotifeeEvent = (mod: any, event: any): { action: NativeCallAction; callId: string; source?: string } | null => {
  const data = event?.detail?.notification?.data || {};
  const callId = data.call_id;
  if (!callId || (data.commskit !== "incoming_call" && data.commskit !== "ongoing_call")) return null;
  const EventType = mod?.EventType || { PRESS: 1, ACTION_PRESS: 2 };
  let id: string | undefined;
  if (event.type === EventType.ACTION_PRESS) id = event.detail?.pressAction?.id;
  else if (event.type === EventType.PRESS) id = "open";
  else return null;
  const action: NativeCallAction | null =
    id === "answer" ? "answer" : id === "decline" ? "decline" : id === "hangup" ? "hangup" : id === "open" || id === "default" ? "open" : null;
  return action ? { action, callId: String(callId), source: data.source } : null;
};

// The live notifier of this JS context (background events of a running app go to it).
let liveRouter: ((action: NativeCallAction, callId: string) => void) | null = null;
/** Deliver an action to the running app's notifier. false when no app instance is listening. */
export const routeToLiveNotifier = (action: NativeCallAction, callId: string): boolean => {
  if (!liveRouter) return false;
  liveRouter(action, callId);
  return true;
};

/** `notifee.onBackgroundEvent` (module scope, index.js). */
export const onNotifeeBackgroundEvent = (handler: (event: any, mod: any) => Promise<void>, notifee?: any): void => {
  const mod = requireNotifee(notifee);
  mod.api.onBackgroundEvent((event: any) => handler(event, mod));
};

export const cancelCallNotification = async (callId: string, notifee?: any): Promise<void> => {
  const mod = requireNotifee(notifee);
  await mod.api.cancelNotification(callNotificationId(callId));
};

let foregroundServiceRegistered = false;

export const createAndroidCallNotifier = (options: AndroidCallNotificationOptions = {}): NativeCallNotifier => {
  const mod = requireNotifee(options.notifee);
  const log = options.logger;
  const t = { ...DEFAULT_TEXTS, ...(options.texts || {}) };
  const actions = createActionQueue();
  const channels = ensureChannels(mod, options).catch((e) => {
    log?.warn("notifee createChannel failed", e);
    return { ringing: options.channelId || "call_ringtone", ongoing: options.ongoingChannelId || "call_ongoing" };
  });
  const run = (what: string, p: () => Promise<unknown> | unknown): Promise<void> =>
    Promise.resolve()
      .then(p)
      .then(
        () => undefined,
        (e) => void log?.warn(`notifee ${what} failed`, e),
      );

  if (!foregroundServiceRegistered && mod.api.registerForegroundService) {
    foregroundServiceRegistered = true;
    // Keeps the ongoing-call service alive until stopForegroundService().
    mod.api.registerForegroundService(() => new Promise<void>(() => {}));
  }

  const emit = (action: NativeCallAction, callId: string) => {
    if (action === "decline" || action === "answer") void run("cancelNotification", () => mod.api.cancelNotification(callNotificationId(callId)));
    actions.emit(action, callId);
  };
  const unsubscribe = mod.api.onForegroundEvent?.((event: any) => {
    const hit = callActionFromNotifeeEvent(mod, event);
    if (hit) emit(hit.action, hit.callId);
  });
  liveRouter = emit;

  // Cold start: the app was launched from the notification (Answer / full-screen / tap).
  void run("getInitialNotification", async () => {
    const initial = await mod.api.getInitialNotification?.();
    if (!initial) return;
    const hit = callActionFromNotifeeEvent(mod, { type: (mod.EventType || { ACTION_PRESS: 2 }).ACTION_PRESS, detail: initial });
    if (hit) emit(hit.action, hit.callId);
  });

  const shown = new Set<string>();
  return {
    kind: "android",
    setActionHandler: (handler) => actions.set(handler),
    showIncoming: (call) =>
      run("displayNotification", async () => {
        shown.add(call.callId);
        await displayIncomingCallNotification(call, options);
      }),
    dismiss: (callId) =>
      run("cancelNotification", async () => {
        if (callId) {
          shown.delete(callId);
          await mod.api.cancelNotification(callNotificationId(callId));
          return;
        }
        // Leftovers shown by this app instance (headless push notifications end with their timeout).
        const ids = Array.from(shown);
        shown.clear();
        for (const id of ids) await mod.api.cancelNotification(callNotificationId(id));
      }),
    startOngoing: (call: OngoingCallInfo) =>
      run("foreground service", async () => {
        const { ongoing } = await channels;
        const types = mod.AndroidForegroundServiceType || {};
        await mod.api.displayNotification({
          id: ONGOING_NOTIFICATION_ID,
          title: call.peerName || t.ongoing,
          body: t.ongoing,
          data: { commskit: "ongoing_call", call_id: call.callId },
          android: {
            channelId: ongoing,
            category: mod.AndroidCategory?.CALL ?? "call",
            asForegroundService: true,
            foregroundServiceTypes: [types.FOREGROUND_SERVICE_TYPE_PHONE_CALL ?? 4, types.FOREGROUND_SERVICE_TYPE_MICROPHONE ?? 128],
            ongoing: true,
            autoCancel: false,
            showChronometer: true,
            timestamp: call.connectedAt,
            ...(options.smallIcon ? { smallIcon: options.smallIcon } : {}),
            ...(options.color ? { color: options.color } : {}),
            pressAction: { id: "default", launchActivity: "default" },
            actions: [{ title: t.hangup, pressAction: { id: "hangup" } }],
          },
        });
      }),
    stopOngoing: () =>
      run("stopForegroundService", async () => {
        await mod.api.stopForegroundService?.();
        await mod.api.cancelNotification(ONGOING_NOTIFICATION_ID);
      }),
    setMuted: () => {},
    dispose: () => {
      if (liveRouter === emit) liveRouter = null;
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
};
