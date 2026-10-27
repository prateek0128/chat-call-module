/**
 * commskit/notifications — push registration (PROTOCOL §8) and notification routing.
 * Imports core only. expo-notifications and expo-device are optional peers (lazily required).
 */
export {
  ensureNotificationChannels,
  platformFromOsName,
  registerDevice,
  unregisterDevice,
  type DevicePlatform,
  type DeviceRegistration,
  type PushPermission,
  type RegisterDeviceOptions,
  type RegisterDeviceResult,
} from "./register";
export { CALL_CHANNEL_ID, MESSAGES_CHANNEL_ID, channelDefinitions, type ChannelNames } from "./channels";
export {
  notificationPresentation,
  notificationTapTarget,
  toNotificationBehavior,
  type Presentation,
  type PresentationOptions,
  type TapTarget,
} from "./routing";
export { useNotificationRouting, type NotificationRoutingOptions } from "./hooks";
export {
  parseNotificationData,
  peerIdFromCid,
  type ChatPushData,
  type IncomingCallPushData,
  type MissedCallPushData,
  type PushData,
} from "../core/push";
