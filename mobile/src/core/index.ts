/** commskit/core — single socket, config, shared user directory, wire types. */

export {
  CommsClient,
  backoffDelay,
  type AppStateLike,
  type CommsClientOptions,
  type ConnectionStatus,
  type MessageHandler,
  type OfflineSendPolicy,
  type StatusInfo,
  type WebSocketFactory,
  type WebSocketLike,
} from "./CommsClient";
export {
  CommsProvider,
  useComms,
  useConnectionStatus,
  useIsConnected,
  useUserProfile,
  type CommsContextValue,
  type CommsProviderProps,
} from "./CommsProvider";
export {
  authFetch,
  CommsHttpError,
  consoleLogger,
  deriveWsUrl,
  noopLogger,
  resolveWsUrl,
  restUrl,
  socketUrl,
  type CommsConfig,
  type Logger,
  type MaybePromise,
} from "./config";
export { UserDirectory, type UserLike, type UserProfile } from "./userDirectory";
export {
  callLogText,
  formatCallDuration,
  friendlyDuration,
  parseCallEntry,
  secondsSince,
  type CallLogOutcome,
  type ParsedCallEntry,
} from "./callLog";
export * from "./types";
export {
  parseNotificationData,
  peerIdFromCid,
  type ChatPushData,
  type IncomingCallPushData,
  type MissedCallPushData,
  type PushData,
  type UnknownPushData,
} from "./push";
