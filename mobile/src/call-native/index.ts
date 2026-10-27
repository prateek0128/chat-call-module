/**
 * commskit/call-native — incoming calls while the app is closed (call add-on; imports core + call,
 * never chat). iOS: CallKit (react-native-callkeep) + PushKit VoIP pushes
 * (react-native-voip-push-notification). Android: notifee full-screen notifications + an
 * expo-notifications background task. All native libs are optional peers, lazily required.
 * Native setup: the Expo config plugin (`"plugins": ["commskit"]`, app.plugin.js).
 */
export { createCallKitNotifier, CALLKEEP_END_REASON, type CallKitNotifier, type CallKitNotifierOptions } from "./callkit";
export { registerVoipPush, type VoipPushOptions } from "./voip";
export {
  createAndroidCallNotifier,
  displayIncomingCallNotification,
  callNotificationId,
  CALL_NOTIFICATION_PREFIX,
  ONGOING_NOTIFICATION_ID,
  type AndroidCallNotificationOptions,
  type AndroidCallTexts,
} from "./android";
export { registerBackgroundCallHandler, BACKGROUND_CALL_TASK, type BackgroundCallHandler, type BackgroundCallHandlerOptions } from "./background";
export {
  saveCallSession,
  clearCallSession,
  loadCallSession,
  rejectCallWithStoredSession,
  defaultSessionStorage,
  CALL_SESSION_KEY,
  type KeyValueStorage,
  type StoredCallSession,
} from "./session";
export { createPlatformCallNotifier, useNativeCallNotifier, type PlatformCallNotifierOptions } from "./hooks";
export { callKitUuid, uuidv5, CALLKIT_UUID_NAMESPACE, CALLKIT_UUID_PREFIX } from "./uuid";
export { noopNativeNotifier, type NativeCallAction, type NativeCallActionHandler, type NativeCallNotifier } from "./types";
