/**
 * commskit/chat-ui — themeable React Native chat UI on top of commskit/chat.
 * Imports theme, core and chat only. Never imports call or call-ui: the call button is a
 * callback (`onCall`) / slot (`renderActions`) the host fills in combined mode.
 */

// Screens
export { ConversationListScreen, type ConversationListScreenProps } from "./ConversationListScreen";
export { ChatScreen, type ChatGateInfo, type ChatScreenProps, type FileActionEvent } from "./ChatScreen";

// Components
export { Avatar, type AvatarProps } from "../theme/Avatar";
export { ConversationList, type ConversationListProps } from "./ConversationList";
export { ConversationRow, CONVERSATION_ROW_HEIGHT, displayName, type ConversationRowProps } from "./ConversationRow";
export { ChatHeader, type ChatHeaderActionsContext, type ChatHeaderMenuItem, type ChatHeaderProps } from "./ChatHeader";
export { ChatWallpaper, type ChatWallpaperProps, type GradientRenderProps } from "./ChatWallpaper";
export { AppearanceSheet, type AppearanceSheetProps, type PickedWallpaperImage } from "./AppearanceSheet";
export { MessageList, type MessageListProps } from "./MessageList";
export { MessageBubble, type MessageBubbleProps } from "./MessageBubble";
export { CallEntry, type CallEntryProps } from "./CallEntry";
export { TypingIndicator, type TypingIndicatorProps } from "./TypingIndicator";
export { Composer, type ComposerProps } from "./Composer";
export { AttachmentPreviewSheet, type AttachmentPreviewSheetProps } from "./AttachmentPreviewSheet";
export { ConnectionBanner, ConnectionBannerView, type ConnectionBannerViewProps } from "./ConnectionBanner";
export { ImageViewer, type ImageViewerProps } from "./ImageViewer";
export { ReportSheet, type ReportSheetProps } from "./ReportSheet";
export { BlockedUsersScreen, type BlockedUsersScreenProps } from "./BlockedUsersScreen";
export { ReplyBar, type ReplyBarProps } from "./ReplyBar";
export { MessageActionsSheet, type MessageActionsSheetProps } from "./MessageActionsSheet";
export { InAppMessageBanner, type InAppMessageBannerProps } from "./InAppMessageBanner";
export { Toast, type ToastMessage, type ToastProps } from "./Toast";
export { AttachMenu, type AttachMenuProps } from "./AttachMenu";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { DocumentViewerModal, documentViewerAvailable, type DocumentViewerModalProps } from "./DocumentViewerModal";
export {
  AudioMessageRow,
  audioPlaybackAvailable,
  inAppVideoAvailable,
  VideoPlayerModal,
  type AudioMessageRowProps,
  type VideoPlayerModalProps,
} from "./MediaPlayers";
export { gesturesAvailable, SwipeToReply, SwipeUpToDismiss, type SwipeToReplyProps, type SwipeUpToDismissProps } from "./gestures";

// Hooks
export {
  useConnectionBanner,
  useInAppBanner,
  useMessageSound,
  useSharedTicker,
  useTicker,
  useTypingMap,
  type InAppBannerItem,
  type UseInAppBannerOptions,
  type UseMessageSoundOptions,
} from "./hooks";

// Pure helpers (unit-tested)
export {
  dayKey,
  daysAgo,
  formatClockTime,
  formatDateSeparator,
  formatFileSize,
  formatListTime,
  formatMessageTime,
  formatUnreadBadge,
  parseTimestamp,
  type ClockFormat,
} from "./format";
export { buildMessageRows, GROUP_WINDOW_MS, messageKey, sameGroup, type MessageListRow } from "./grouping";
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
  type ConversationPreview,
  type MediaKind,
  type PresenceLabel,
  type TickState,
} from "./preview";
export { describeCallEntry, isCallMessage, type CallEntryInput, type CallEntryModel } from "./callEntryModel";
export {
  canSendText,
  clampComposerHeight,
  clampComposerLines,
  composerDisabledReason,
  type ComposerAvailability,
  type ComposerMetrics,
  type ComposerSize,
} from "./composerLayout";
export { attachmentName, checkAttachmentSize, isImageAttachment, type AttachmentCheck, type PickedAttachment } from "./attachments";
export {
  blockedComposerText,
  canSubmitReport,
  moderationMenuItems,
  reportCategoryOptions,
  type BlockedComposerKind,
  type ModerationMenuInput,
  type ModerationMenuItem,
  type ReportCategoryOption,
} from "./moderationModel";
export { connectionBannerModel, OFFLINE_AFTER_ATTEMPTS, type ConnectionBannerModel } from "./connection";

// Rich chat features: reply, message actions, media, file actions, in-app banner (pure helpers)
export {
  canReplyTo,
  copyableText,
  formatMediaDuration,
  messageActionList,
  replySenderLabel,
  replySnippet,
  shouldTriggerReply,
  swipeReplyOffset,
  SWIPE_REPLY_MAX,
  SWIPE_REPLY_THRESHOLD,
  toReplyTarget,
  type BuiltInMessageActionKey,
  type MessageAction,
  type MessageActionAvailability,
  type ReplyTargetInput,
} from "./messageActions";
export {
  createDefaultFileActions,
  safeFileName,
  type DefaultFileActionsOptions,
  type FileActionFailure,
  type FileActionModules,
  type FileActionProgress,
  type FileActionResult,
  type FileActions,
  type FileActionTarget,
} from "./fileActions";
export {
  BANNER_AUTO_HIDE_MS,
  BANNER_MAX_AGE_MS,
  bannerKey,
  bannerSuppression,
  bannerText,
  primeSeen,
  scanForBanners,
  SeenSet,
  type BannerCandidate,
  type BannerDecisionInput,
  type BannerSuppression,
} from "./inAppBanner";
export { setOptionalPeer, type OptionalPeerName } from "./optionalPeers";

// Chat extras (PROTOCOL §9) + list / header / media polish (pure helpers)
export { formatLastSeen, headerStatus, type HeaderStatus, type HeaderStatusInput, type HeaderStatusKind } from "./lastSeen";
export {
  ALL_FILTER,
  applyConversationFilter,
  blockedRowLabel,
  conversationEmptyState,
  conversationFilters,
  filterChipModels,
  UNREAD_FILTER,
  type ConversationFilter,
  type FilterChipModel,
} from "./conversationFilters";
export { documentBadge, documentMeta, type DocumentBadge, type DocumentBadgeColor } from "./documentBadge";
export { createStickyLabelController, STICKY_LABEL_HIDE_MS, stickyDateLabel, stickyFadeDuration, type StickyLabelController } from "./stickyDate";
export { createSharedTicker, sharedTicker, type SharedTicker } from "./ticker";
export {
  createExpoPickers,
  fromDocumentPickerResult,
  fromImagePickerResult,
  type AttachPicker,
  type AttachPickerKey,
  type ExpoPickersOptions,
} from "./pickers";
export { createMessageSoundPlayer, shouldPlayMessageSound, type MessageSoundPlayer, type SoundSource } from "./messageSound";
export { canDeleteForEveryone, canDeleteForMe, DEFAULT_UNSEND_WINDOW_SECONDS, rateLimitText } from "./messageActions";
