/**
 * commskit/engine - the framework-free engine, for non-React-Native clients (the web package
 * `commskit-web` aliases this entry). Re-exports only modules that import neither react nor
 * react-native (checked by __tests__/engineEntry.test.ts): the socket client, stores, wire types
 * and the pure chat-ui / theme helpers, so every UI formats, groups and themes identically.
 */

// core (no CommsProvider: that one binds react-native's AppState)
export { CommsClient, backoffDelay } from "../core/CommsClient";
export type {
  AppStateLike,
  CommsClientOptions,
  ConnectionStatus,
  MessageHandler,
  OfflineSendPolicy,
  StatusInfo,
  WebSocketFactory,
  WebSocketLike,
} from "../core/CommsClient";
export { authFetch, CommsHttpError, consoleLogger, deriveWsUrl, noopLogger, resolveWsUrl, restUrl, socketUrl } from "../core/config";
export type { CommsConfig, Logger, MaybePromise } from "../core/config";
export { UserDirectory } from "../core/userDirectory";
export type { UserLike, UserProfile } from "../core/userDirectory";
export { callLogText, formatCallDuration, friendlyDuration, parseCallEntry, secondsSince } from "../core/callLog";
export type { CallLogOutcome, ParsedCallEntry } from "../core/callLog";
export { parseNotificationData, peerIdFromCid } from "../core/push";
export type { ChatPushData, PushData } from "../core/push";
export * from "../core/types";

// chat store + REST
export {
  CHAT_EVENT_TYPES,
  ChatStore,
  classifyMedia,
  DEFAULT_PAGE_SIZE,
  MAX_UPLOAD_BYTES,
  mergeMessage,
  normalizeMessageType,
  timestampMs,
  toDeletedMessage,
  toReplyPreview,
  TYPING_TIMEOUT_MS,
} from "../chat/ChatStore";
export type { ChatStoreOptions } from "../chat/ChatStore";
export { registerPushToken, removePushToken, startChat } from "../chat/api";
export type { ApiConfig, PushTokenPayload, StartChatResponse } from "../chat/api";
export * from "../chat/types";

// moderation store
export { ModerationStore, MODERATION_EVENT_TYPES, REPORT_CATEGORIES, REPORT_CATEGORY_LABELS } from "../moderation/ModerationStore";
export type {
  BlockedUser,
  ModerationErrorListener,
  ModerationSnapshot,
  ModerationStoreOptions,
  ModerationTransport,
  ReportCategory,
  ReportInput,
} from "../moderation/ModerationStore";

// pure chat-ui helpers
export { dayKey, daysAgo, formatClockTime, formatDateSeparator, formatFileSize, formatListTime, formatMessageTime, formatUnreadBadge, isPlaceholder, parseTimestamp } from "../chat-ui/format";
export type { ClockFormat } from "../chat-ui/format";
export { buildMessageRows, GROUP_WINDOW_MS, messageKey, sameGroup } from "../chat-ui/grouping";
export type { MessageListRow } from "../chat-ui/grouping";
export {
  attachmentLabel,
  conversationPreview,
  DELETED_MINE_TEXT,
  DELETED_TEXT,
  filterConversations,
  mediaKindOf,
  messageTicks,
  presenceLabel,
  TICK_GLYPHS,
  TICK_LABELS,
} from "../chat-ui/preview";
export type { ConversationPreview, MediaKind, PresenceLabel, TickState } from "../chat-ui/preview";
export { describeCallEntry, isCallMessage } from "../chat-ui/callEntryModel";
export type { CallEntryInput, CallEntryModel } from "../chat-ui/callEntryModel";
export { canSendText, clampComposerLines, composerDisabledReason } from "../chat-ui/composerLayout";
export type { ComposerAvailability } from "../chat-ui/composerLayout";
export { attachmentName, checkAttachmentSize, isImageAttachment } from "../chat-ui/attachments";
export type { AttachmentCheck, PickedAttachment } from "../chat-ui/attachments";
export { blockedComposerText, canSubmitReport, moderationMenuItems, reportCategoryOptions } from "../chat-ui/moderationModel";
export type { BlockedComposerKind, ReportCategoryOption } from "../chat-ui/moderationModel";
export { connectionBannerModel, OFFLINE_AFTER_ATTEMPTS } from "../chat-ui/connection";
export type { ConnectionBannerModel } from "../chat-ui/connection";
export {
  canDeleteForEveryone,
  canDeleteForMe,
  canReplyTo,
  copyableText,
  DEFAULT_UNSEND_WINDOW_SECONDS,
  formatMediaDuration,
  messageActionList,
  rateLimitText,
  replySenderLabel,
  replySnippet,
  shouldTriggerReply,
  swipeReplyOffset,
  SWIPE_REPLY_MAX,
  SWIPE_REPLY_THRESHOLD,
  toReplyTarget,
} from "../chat-ui/messageActions";
export type { BuiltInMessageActionKey, MessageAction, MessageActionAvailability, ReplyTargetInput } from "../chat-ui/messageActions";
export { BANNER_AUTO_HIDE_MS, BANNER_MAX_AGE_MS, bannerKey, bannerSuppression, bannerText, primeSeen, scanForBanners, SeenSet } from "../chat-ui/inAppBanner";
export type { BannerCandidate } from "../chat-ui/inAppBanner";
export { formatLastSeen, headerStatus } from "../chat-ui/lastSeen";
export type { HeaderStatus, HeaderStatusInput, HeaderStatusKind } from "../chat-ui/lastSeen";
export {
  ALL_FILTER,
  applyConversationFilter,
  blockedRowLabel,
  conversationEmptyState,
  conversationFilters,
  filterChipModels,
  UNREAD_FILTER,
} from "../chat-ui/conversationFilters";
export type { ConversationFilter, FilterChipModel } from "../chat-ui/conversationFilters";
export { documentBadge, documentMeta } from "../chat-ui/documentBadge";
export type { DocumentBadge, DocumentBadgeColor } from "../chat-ui/documentBadge";
export { createStickyLabelController, STICKY_LABEL_HIDE_MS, stickyDateLabel } from "../chat-ui/stickyDate";
export { createSharedTicker, sharedTicker } from "../chat-ui/ticker";
export type { SharedTicker } from "../chat-ui/ticker";

// pure theme helpers (no appearanceStorage: it lazily requires async-storage)
export { tokens, colorTokens, avatarPalette, radius, space, font, shadow, motion, layout, themePresets, wallpapers } from "../theme/tokens";
export type { ColorName, ColorScheme, ColorTokens, PresetName, PresetColors } from "../theme/tokens";
export { createTheme, isPresetName, resolveScheme } from "../theme/createTheme";
export type { Theme, ThemeOverrides } from "../theme/createTheme";
export { decideLayout, MAX_CONTENT_WIDTH } from "../theme/layout";
export type { LayoutDecision } from "../theme/layout";
export { avatarColor, initialsOf } from "../theme/avatarColors";
export { gradientStops, mixColor, parseColor, toColorString, withAlpha } from "../theme/color";
export {
  applyWallpaper,
  clampDim,
  DEFAULT_APPEARANCE,
  DEFAULT_WALLPAPER,
  parseAppearance,
  removeWallpaperOverride,
  resolveWallpaper,
  sanitizeAppearance,
  sanitizeWallpaper,
  serializeAppearance,
  wallpaperForPeer,
} from "../theme/appearance";
export type { AppearanceMode, AppearanceState, Wallpaper, WallpaperRender } from "../theme/appearance";
