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

// Built-in implementations, for host replacements that wrap them (see `components` on ThemeProvider / AppearanceProvider).
export { DefaultAppearanceSheet } from "./AppearanceSheet";
export { DefaultAttachMenu } from "./AttachMenu";
export { DefaultAttachmentPreviewSheet } from "./AttachmentPreviewSheet";
export { DefaultBlockedUsersScreen } from "./BlockedUsersScreen";
export { DefaultCallEntry } from "./CallEntry";
export { DefaultChatHeader } from "./ChatHeader";
export { DefaultChatScreen } from "./ChatScreen";
export { DefaultChatWallpaper } from "./ChatWallpaper";
export { DefaultComposer } from "./Composer";
export { DefaultConfirmDialog } from "./ConfirmDialog";
export { DefaultConnectionBanner } from "./ConnectionBanner";
export { DefaultConversationList } from "./ConversationList";
export { DefaultConversationListScreen } from "./ConversationListScreen";
export { DefaultConversationRow } from "./ConversationRow";
export { DefaultDocumentViewerModal } from "./DocumentViewerModal";
export { DefaultImageViewer } from "./ImageViewer";
export { DefaultInAppMessageBanner } from "./InAppMessageBanner";
export { DefaultAudioMessageRow, DefaultVideoPlayerModal } from "./MediaPlayers";
export { DefaultMessageActionsSheet } from "./MessageActionsSheet";
export { DefaultMessageBubble } from "./MessageBubble";
export { DefaultMessageList } from "./MessageList";
export { DefaultReplyBar } from "./ReplyBar";
export { DefaultReportSheet } from "./ReportSheet";
export { DefaultToast } from "./Toast";
export { DefaultTypingIndicator } from "./TypingIndicator";
export { DefaultSwipeToReply, DefaultSwipeUpToDismiss } from "./gestures";
export { DefaultSkeletonBox } from "./primitives";

import type { ComponentProps, ComponentType } from "react";
import type { AppearanceSheet } from "./AppearanceSheet";
import type { AttachMenu } from "./AttachMenu";
import type { AttachmentPreviewSheet } from "./AttachmentPreviewSheet";
import type { AudioMessageRow } from "./MediaPlayers";
import type { BlockedUsersScreen } from "./BlockedUsersScreen";
import type { CallEntry } from "./CallEntry";
import type { ChatHeader } from "./ChatHeader";
import type { ChatScreen } from "./ChatScreen";
import type { ChatWallpaper } from "./ChatWallpaper";
import type { Composer } from "./Composer";
import type { ConfirmDialog } from "./ConfirmDialog";
import type { ConnectionBanner } from "./ConnectionBanner";
import type { ConversationList } from "./ConversationList";
import type { ConversationListScreen } from "./ConversationListScreen";
import type { ConversationRow } from "./ConversationRow";
import type { DocumentViewerModal } from "./DocumentViewerModal";
import type { ImageViewer } from "./ImageViewer";
import type { InAppMessageBanner } from "./InAppMessageBanner";
import type { MessageActionsSheet } from "./MessageActionsSheet";
import type { MessageBubble } from "./MessageBubble";
import type { MessageList } from "./MessageList";
import type { ReplyBar } from "./ReplyBar";
import type { ReportSheet } from "./ReportSheet";
import type { SkeletonBox } from "./primitives";
import type { SwipeToReply } from "./gestures";
import type { SwipeUpToDismiss } from "./gestures";
import type { Toast } from "./Toast";
import type { TypingIndicator } from "./TypingIndicator";
import type { VideoPlayerModal } from "./MediaPlayers";

/** Every chat-ui component a host can replace (`satisfies ChatUiSlots` on your `components` object). Avatar, Icon, ScalePressable: theme. */
export interface ChatUiSlots {
  AppearanceSheet?: ComponentType<ComponentProps<typeof AppearanceSheet>>;
  AttachMenu?: ComponentType<ComponentProps<typeof AttachMenu>>;
  AttachmentPreviewSheet?: ComponentType<ComponentProps<typeof AttachmentPreviewSheet>>;
  AudioMessageRow?: ComponentType<ComponentProps<typeof AudioMessageRow>>;
  BlockedUsersScreen?: ComponentType<ComponentProps<typeof BlockedUsersScreen>>;
  CallEntry?: ComponentType<ComponentProps<typeof CallEntry>>;
  ChatHeader?: ComponentType<ComponentProps<typeof ChatHeader>>;
  ChatScreen?: ComponentType<ComponentProps<typeof ChatScreen>>;
  ChatWallpaper?: ComponentType<ComponentProps<typeof ChatWallpaper>>;
  Composer?: ComponentType<ComponentProps<typeof Composer>>;
  ConfirmDialog?: ComponentType<ComponentProps<typeof ConfirmDialog>>;
  ConnectionBanner?: ComponentType<ComponentProps<typeof ConnectionBanner>>;
  ConversationList?: ComponentType<ComponentProps<typeof ConversationList>>;
  ConversationListScreen?: ComponentType<ComponentProps<typeof ConversationListScreen>>;
  ConversationRow?: ComponentType<ComponentProps<typeof ConversationRow>>;
  DocumentViewerModal?: ComponentType<ComponentProps<typeof DocumentViewerModal>>;
  ImageViewer?: ComponentType<ComponentProps<typeof ImageViewer>>;
  InAppMessageBanner?: ComponentType<ComponentProps<typeof InAppMessageBanner>>;
  MessageActionsSheet?: ComponentType<ComponentProps<typeof MessageActionsSheet>>;
  MessageBubble?: ComponentType<ComponentProps<typeof MessageBubble>>;
  MessageList?: ComponentType<ComponentProps<typeof MessageList>>;
  ReplyBar?: ComponentType<ComponentProps<typeof ReplyBar>>;
  ReportSheet?: ComponentType<ComponentProps<typeof ReportSheet>>;
  SkeletonBox?: ComponentType<ComponentProps<typeof SkeletonBox>>;
  SwipeToReply?: ComponentType<ComponentProps<typeof SwipeToReply>>;
  SwipeUpToDismiss?: ComponentType<ComponentProps<typeof SwipeUpToDismiss>>;
  Toast?: ComponentType<ComponentProps<typeof Toast>>;
  TypingIndicator?: ComponentType<ComponentProps<typeof TypingIndicator>>;
  VideoPlayerModal?: ComponentType<ComponentProps<typeof VideoPlayerModal>>;
}
