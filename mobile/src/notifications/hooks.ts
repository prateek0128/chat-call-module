/** React hook for notification taps and foreground presentation. */
import { useEffect, useRef } from "react";
import { parseNotificationData, type IncomingCallPushData } from "../core/push";
import type { UserId } from "../core/types";
import { requireExpoNotifications } from "./expo";
import { notificationPresentation, notificationTapTarget, toNotificationBehavior } from "./routing";

export interface NotificationRoutingOptions {
  /** A message / missed-call notification was tapped (also on cold start): open that chat. */
  onOpenChat: (peerId: UserId) => void;
  /**
   * An incoming-call push was tapped, or arrived while the app is in the foreground.
   * When set, foreground incoming-call banners are suppressed (show your call UI instead).
   */
  onIncomingCall?: (call: IncomingCallPushData) => void;
  /** Peer of the chat currently on screen: its message banners are not shown. */
  suppressFor?: () => UserId | null | undefined;
  /** Install the foreground handler (`setNotificationHandler`). Default true. */
  handleForeground?: boolean;
}

/**
 * Routes notification taps (warm and cold start) and decides foreground presentation.
 * Mount once, inside your navigator (so `onOpenChat` can navigate).
 */
export const useNotificationRouting = (options: NotificationRoutingOptions): void => {
  const ref = useRef(options);
  ref.current = options;
  const handleForeground = options.handleForeground !== false;

  useEffect(() => {
    const Notifications = requireExpoNotifications();
    const seen = new Set<string>();
    let alive = true;

    const onResponse = (response: any) => {
      const id = response?.notification?.request?.identifier;
      if (id) {
        if (seen.has(id)) return; // cold-start response also delivered to the listener
        seen.add(id);
      }
      const target = notificationTapTarget(response);
      if (!target) return;
      if (target.kind === "chat") ref.current.onOpenChat(target.peerId);
      else ref.current.onIncomingCall?.(target.call);
    };

    const sub = Notifications.addNotificationResponseReceivedListener(onResponse);
    void Promise.resolve(Notifications.getLastNotificationResponseAsync?.())
      .then((last: any) => alive && last && onResponse(last))
      .catch(() => {});

    if (handleForeground) {
      Notifications.setNotificationHandler({
        handleNotification: async (notification: any) => {
          const data = parseNotificationData(notification);
          const handlesCalls = !!ref.current.onIncomingCall;
          if (data?.type === "incoming_call" && handlesCalls) ref.current.onIncomingCall?.(data);
          return toNotificationBehavior(
            notificationPresentation(data ? data.raw : notification, { activePeerId: ref.current.suppressFor?.(), handlesCalls }),
          );
        },
      });
    }
    return () => {
      alive = false;
      sub?.remove?.();
      if (handleForeground) Notifications.setNotificationHandler(null);
    };
  }, [handleForeground]);
};
