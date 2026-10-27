/** Notification routing decisions (taps and foreground presentation). Pure. */
import { parseNotificationData, type IncomingCallPushData, type PushData } from "../core/push";
import type { UserId } from "../core/types";

export type TapTarget = { kind: "chat"; peerId: UserId } | { kind: "call"; call: IncomingCallPushData } | null;

/** What a tap on a notification should open: the chat (message / missed call) or the call. */
export const notificationTapTarget = (input: unknown): TapTarget => {
  const data: PushData | null = parseNotificationData(input);
  if (!data) return null;
  switch (data.type) {
    case "chat":
      return { kind: "chat", peerId: data.peerId };
    case "missed_call":
      return data.callerId ? { kind: "chat", peerId: data.callerId } : null;
    case "incoming_call":
      return { kind: "call", call: data };
    default:
      return null;
  }
};

export interface PresentationOptions {
  /** Peer of the chat that is open on screen (its message banners are suppressed). */
  activePeerId?: UserId | null;
  /** The host handles foreground incoming-call pushes itself (onIncomingCall): no banner. */
  handlesCalls?: boolean;
}

export interface Presentation {
  show: boolean;
  sound: boolean;
  badge: boolean;
}

/** Foreground presentation for a received notification. */
export const notificationPresentation = (input: unknown, options: PresentationOptions = {}): Presentation => {
  const data = parseNotificationData(input);
  const hide: Presentation = { show: false, sound: false, badge: false };
  if (data?.type === "chat" && options.activePeerId != null && String(options.activePeerId) === data.peerId) return hide;
  if (data?.type === "incoming_call" && options.handlesCalls) return hide;
  return { show: true, sound: true, badge: true };
};

/** expo-notifications `NotificationBehavior` (SDK 53+ banner/list fields plus the older shouldShowAlert). */
export const toNotificationBehavior = (p: Presentation) => ({
  shouldShowAlert: p.show,
  shouldShowBanner: p.show,
  shouldShowList: p.show,
  shouldPlaySound: p.sound,
  shouldSetBadge: p.badge,
});
