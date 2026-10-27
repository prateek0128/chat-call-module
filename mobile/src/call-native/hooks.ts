/** Platform selection + the React glue between a native notifier and <CallProvider>. */
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useCall } from "../call/hooks";
import { createAndroidCallNotifier, type AndroidCallNotificationOptions } from "./android";
import { createCallKitNotifier, type CallKitNotifierOptions } from "./callkit";
import { noopNativeNotifier, type NativeCallNotifier } from "./types";

export interface PlatformCallNotifierOptions {
  ios: CallKitNotifierOptions;
  android?: AndroidCallNotificationOptions;
  /** Override the platform (tests). Default Platform.OS. */
  os?: string;
}

/** CallKit on iOS, notifee on Android, a no-op elsewhere. Create once (module scope) and pass to <CallProvider notifier>. */
export const createPlatformCallNotifier = (options: PlatformCallNotifierOptions): NativeCallNotifier => {
  const os = options.os || Platform.OS;
  if (os === "ios") return createCallKitNotifier(options.ios);
  if (os === "android") return createAndroidCallNotifier(options.android);
  return noopNativeNotifier();
};

/**
 * Feeds the notifier's actions (CallKit answer/end/mute, notification buttons) into useCall(),
 * and mirrors the mute state back to CallKit. Render once inside <CallProvider>.
 */
export const useNativeCallNotifier = (notifier: NativeCallNotifier): void => {
  const call = useCall();
  const ref = useRef(call);
  ref.current = call;

  useEffect(() => {
    notifier.setActionHandler((action, callId) => {
      const c = ref.current;
      const current = c.state.callId === callId;
      if (action === "mute" || action === "unmute") {
        if (current && c.isMuted !== (action === "mute")) c.toggleMute();
        return;
      }
      // CallKit owns the audio session: answering works with the app in the background / locked.
      if (action === "answer" && current && notifier.kind === "callkit") {
        void c.accept();
        return;
      }
      c.handleNotificationAction(action, callId);
    });
    return () => notifier.setActionHandler(null);
  }, [notifier]);

  const connectedCallId = call.state.status === "connected" ? call.state.callId : undefined;
  useEffect(() => {
    if (connectedCallId) notifier.setMuted(connectedCallId, call.isMuted);
  }, [notifier, connectedCallId, call.isMuted]);
};
