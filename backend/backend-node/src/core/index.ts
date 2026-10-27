/** Transport, presence, adapters and the hub. Imports neither chat, call nor moderation. */
export {
  type AuthAdapter, AuthError, type DeviceRegistry, JwtAuth, LocalDiskStorage, type MediaInfo, type MediaStorage,
  NoopPush, NullUserDirectory, type PushSender, StaticUserDirectory, UploadRejected, type UserDirectory, type UserProfile,
  deleteMedia, resolveUserId,
} from "./adapters.js";
export { PONG_TYPE } from "./compat.js";
export { ConnectionManager, type PresenceBridge, type SocketLike, USER_ROLE, type UserConnection } from "./connections.js";
export { type Db, type Dialect, dbBool, dbNow, dbTimestamp, detectDialect } from "./db.js";
export { type DevicesTable, devicesDdl } from "./devices.js";
export { EventBus, type Listener } from "./events.js";
export {
  type CommsHubOptions, CommsHub, type ConnectHook, type DisconnectHook, type Feature, type Handler, type HandlerErrorHook,
  type RoleResolver,
} from "./hub.js";
export { restListener } from "./http.js";
export { type Logger, setLogger, silentLogger } from "./logger.js";
export { MEDIA_TYPES, detectMediaType } from "./media.js";
export { type Limiter, RateLimit, RateLimiter, retryAfterSeconds } from "./ratelimit.js";
export {
  HttpError, type HttpMethod, type RestContext, type RestResult, type RestRoute, firstQuery, matchPath, ok, validationError,
} from "./rest.js";
export { formatIso, iso, nowIso, utcnow } from "./util.js";
