/**
 * The OS call UI notifier (CallKit on iOS, notifee full-screen notifications on Android), created
 * once and only when the call feature is used (chat-only mode never touches the native call libs).
 */
import { createPlatformCallNotifier, type NativeCallNotifier } from "commskit/call-native";

let notifier: NativeCallNotifier | null = null;

export const getCallNotifier = (): NativeCallNotifier => {
  if (!notifier) {
    notifier = createPlatformCallNotifier({
      ios: { appName: "Commskit Demo" },
      android: { texts: { answer: "Answer", decline: "Decline" } },
    });
  }
  return notifier;
};
