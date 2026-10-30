/** commskit-web: React chat UI for the browser, on the framework-free commskit engine. */

// providers + hooks
export {
  ChatProvider,
  CommsStack,
  CommsWebProvider,
  ModerationProvider,
  createBrowserAppState,
  useBlocking,
  useChat,
  useChatApi,
  useChatContext,
  useChatErrors,
  useComms,
  useConnectionStatus,
  useConversation,
  useConversations,
  useIsConnected,
  useOptionalBlocking,
  useUnreadCount,
  useUserProfile,
  type BlockingApi,
  type ChatProviderProps,
  type CommsWebContextValue,
  type CommsWebProviderProps,
  type ModerationProviderProps,
  type ReplyTarget,
  type UseConversationOptions,
  type UseConversationResult,
} from "./providers";
export {
  APPEARANCE_STORAGE_KEY,
  AppearanceProvider,
  ChatWallpaper,
  themeCssVars,
  useAppearance,
  useTheme,
  type AppearanceController,
  type AppearanceProviderProps,
  type SyncStorage,
} from "./appearance";
export { useWebNotifications, InAppMessageBanners, type NotificationPermissionState, type UseWebNotificationsOptions, type WebNotificationsApi } from "./notifications";

// screens + components
export { ComponentsProvider, slot, type CommsComponents } from "./components";
export { ChatApp, type ChatAppProps } from "./ChatApp";
export { ConversationListScreen, ConversationRow, displayName, type ConversationListScreenProps, type ConversationRowProps } from "./ConversationListScreen";
export { ChatHeader, ChatScreen, type ChatGateInfo, type ChatHeaderMenuItem, type ChatHeaderProps, type ChatScreenProps } from "./ChatScreen";
export { Linkified, MessageBubble, MessageList, type MessageBubbleProps, type MessageListProps } from "./messages";
export { Composer, TYPING_IDLE_MS, TYPING_THROTTLE_MS, type ComposerProps } from "./Composer";
export {
  AppearanceSheet,
  AttachmentPreviewSheet,
  BlockedUsersScreen,
  DocumentViewer,
  ImageLightbox,
  ReportSheet,
  type PendingAttachment,
} from "./sheets";
export { Avatar, ConfirmDialog, ConnectionBanner, Dialog, Icon, LiveRegion, PopupMenu, ToastStack, type MenuItem, type WebIconName } from "./ui";
export { useAnnouncer, useElementWidth, useKeyboardInset, useReducedMotion, useTabVisible, useTicker, useToasts, type ToastItem } from "./hooks";
export { downscaleImageFile, readUrlAsBase64, resolveMediaUrl, splitLinks, type TextPart } from "./util";

// engine pieces hosts commonly need (shared with the React Native UI)
export {
  CommsClient,
  ChatStore,
  ModerationStore,
  UserDirectory,
  DEFAULT_UNSEND_WINDOW_SECONDS,
  MAX_UPLOAD_BYTES,
  REPORT_CATEGORIES,
  themePresets,
  tokens,
  wallpapers,
  type AppearanceMode,
  type AppearanceState,
  type ChatError,
  type ChatMessage,
  type CommsConfig,
  type Conversation,
  type ConversationFilter,
  type MessageAction,
  type PresetName,
  type Wallpaper,
} from "commskit/engine";

// Built-in implementations, for host replacements that wrap them (see `components` on AppearanceProvider).
export { DefaultAvatar } from "./ui";
export { DefaultChatApp } from "./ChatApp";
export { DefaultChatHeader, DefaultChatScreen } from "./ChatScreen";
export { DefaultComposer } from "./Composer";
export { DefaultConversationListScreen, DefaultConversationRow } from "./ConversationListScreen";
export { DefaultChatWallpaper } from "./appearance";
export { DefaultLinkified, DefaultMessageBubble, DefaultMessageList } from "./messages";
export { DefaultInAppMessageBanners } from "./notifications";
export { DefaultAppearanceSheet, DefaultAttachmentPreviewSheet, DefaultBlockedUsersScreen, DefaultDocumentViewer, DefaultImageLightbox, DefaultReportSheet } from "./sheets";
export { DefaultConfirmDialog, DefaultConnectionBanner, DefaultDialog, DefaultIcon, DefaultLiveRegion, DefaultPopupMenu, DefaultToastStack } from "./ui";
