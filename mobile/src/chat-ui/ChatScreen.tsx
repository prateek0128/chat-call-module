import { slot } from "../theme";
import { memo, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useUserProfile } from "../core";
import { useConversation } from "../chat";
import type { ChatId, ConversationInfoDto } from "../core/types";
import type { ChatMessage, Conversation } from "../chat/types";
import { announce, useSafeInsets, useTheme, type EdgeInsets } from "../theme";
import { AppearanceSheet, type AppearanceSheetProps } from "./AppearanceSheet";
import { AttachmentPreviewSheet } from "./AttachmentPreviewSheet";
import { AttachMenu } from "./AttachMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { DocumentViewerModal, documentViewerAvailable } from "./DocumentViewerModal";
import type { AttachPicker } from "./pickers";
import type { PickedAttachment } from "./attachments";
import { ChatHeader, type ChatHeaderActionsContext, type ChatHeaderMenuItem } from "./ChatHeader";
import type { GradientRenderProps } from "./ChatWallpaper";
import { Composer } from "./Composer";
import { composerDisabledReason } from "./composerLayout";
import { ConnectionBanner } from "./ConnectionBanner";
import type { ClockFormat } from "./format";
import { ImageViewer } from "./ImageViewer";
import { MessageList } from "./MessageList";
import { moderationMenuItems } from "./moderationModel";
import { ReportSheet } from "./ReportSheet";
import { useOptionalBlocking } from "../moderation/hooks";
import { attachmentLabel, mediaKindOf } from "./preview";
import { createDefaultFileActions, type FileActionResult, type FileActions } from "./fileActions";
import { inAppVideoAvailable, VideoPlayerModal } from "./MediaPlayers";
import {
  canReplyTo,
  copyableText,
  DEFAULT_UNSEND_WINDOW_SECONDS,
  messageActionList,
  rateLimitText,
  replySenderLabel,
  replySnippet,
  toReplyTarget,
  type MessageAction,
} from "./messageActions";
import { MessageActionsSheet } from "./MessageActionsSheet";
import { copyText, getClipboard } from "./optionalPeers";
import { Toast, type ToastMessage } from "./Toast";

/** Progress / result of a long-press file action or copy (ChatScreen `onFileActionEvent`). */
export interface FileActionEvent {
  action: "download" | "share" | "save" | "copy";
  status: "progress" | "success" | "error";
  message: ChatMessage;
  /** 0..1 while downloading. */
  progress?: number;
  result?: FileActionResult;
  /** Human-readable status ("Downloading… 40%", "Saved to gallery", the error). */
  text: string;
}

/** What a pre-chat gate (ChatScreen `gate`) gets to decide whether to show itself. */
export interface ChatGateInfo {
  peerId: string;
  name: string;
  /** `res_messages.info` (host extras such as consent flags live here). */
  info: ConversationInfoDto | null;
  conversation: Conversation | undefined;
  messages: ChatMessage[];
  /** First history page arrived. */
  loaded: boolean;
  isBlocked: boolean;
  blockedByOther: boolean;
}

export interface ChatScreenProps {
  peerId: string;
  /** Known chat id (from startChat / a push). Optional. */
  chatId?: ChatId | null;
  /** Back button (single-pane). Omit in split-pane layouts. */
  onBack?: () => void;
  /**
   * Adds a call button to the header and "Call back" on call entries. chat-ui never imports
   * call: pass `(peerId) => startCall(peerId)` from `useCall()` in combined mode.
   */
  onCall?: (peerId: string) => void;
  /** Extra header actions (rendered before the call button). */
  renderActions?: (ctx: ChatHeaderActionsContext) => ReactNode;
  onPressTitle?: () => void;
  /**
   * Pick a file to send (e.g. expo-image-picker / expo-document-picker). Shows the attach button.
   * Resolve null when the user cancels.
   */
  pickAttachment?: () => Promise<PickedAttachment | null>;
  /** Open a non-image attachment. Default: `Linking.openURL(file_url)`. */
  onOpenFile?: (message: ChatMessage) => void;
  onLongPressMessage?: (message: ChatMessage) => void;
  /** Name shown until the conversation / user directory knows it. */
  peerName?: string;
  /** Disables the composer with this reason (e.g. "Chat is not enabled"). */
  disabledReason?: string | null;
  /** Explicit insets; otherwise react-native-safe-area-context (optional) or zero. */
  insets?: Partial<EdgeInsets>;
  /** Offset for KeyboardAvoidingView when a navigator header sits above this screen. */
  keyboardVerticalOffset?: number;
  /** Override the per-platform KeyboardAvoidingView behaviour (default: iOS padding, Android none / adjustResize). */
  keyboardBehavior?: "height" | "position" | "padding";
  /** Pass false if the screen stays mounted while hidden (see useConversation `active`). */
  active?: boolean;
  showConnectionBanner?: boolean;
  /** Upload limit (default 10 MB). */
  maxUploadBytes?: number;
  clock?: ClockFormat;
  /**
   * Adds "Wallpaper" to the header's overflow menu, opening the built-in AppearanceSheet for this
   * chat ("This chat" / "All chats"). Needs an <AppearanceProvider>. Default false.
   */
  appearanceMenu?: boolean;
  /** Image picker for the wallpaper sheet's "Choose image..." tile (see AppearanceSheet). */
  pickWallpaperImage?: AppearanceSheetProps["pickImage"];
  /** Gradient renderer for gradient wallpapers (default: expo-linear-gradient if installed). */
  renderGradient?: (props: GradientRenderProps) => ReactNode;
  /** Extra items for the header's overflow menu. */
  menuItems?: ChatHeaderMenuItem[];
  /**
   * Adds "Report" and "Block" / "Unblock" to the overflow menu and the blocked composer state
   * ("You blocked {name}. Unblock"). Needs <ModerationProvider> (commskit/moderation). Default false.
   */
  moderationMenu?: boolean;
  /**
   * Reply UI: "Reply" in the message menu, swipe-right-to-reply, the reply bar above the
   * composer (sends `replyTo`), and quote taps that jump to the original. Default true.
   */
  replies?: boolean;
  /** Swipe right on a bubble to reply (needs react-native-gesture-handler). Default true. */
  swipeToReply?: boolean;
  /**
   * Built-in long-press sheet (Reply, Copy text, Save to gallery / Download, Share, Report message,
   * plus `messageActions`). Default true. `onLongPressMessage`, when given, replaces it.
   */
  messageActionsSheet?: boolean;
  /** Extra long-press actions (appended after the built-ins). */
  messageActions?: MessageAction[] | ((message: ChatMessage) => MessageAction[]);
  /** Download / share / save adapter. Default `createDefaultFileActions({ openURL: Linking.openURL })`. */
  fileActions?: FileActions;
  /** Progress and results of file actions / copy (e.g. your own toast). */
  onFileActionEvent?: (event: FileActionEvent) => void;
  /** Built-in toast for copy / file action progress and errors. Default true. */
  showToasts?: boolean;
  /** Tap on a video. Default: in-app player (expo-video), else `onOpenFile` / Linking. */
  onOpenVideo?: (message: ChatMessage) => void;
  /**
   * Attach menu items (Photo, Camera, Video, Record video, Document, custom…), e.g.
   * `createExpoPickers()`. The attach button opens the AttachMenu sheet; wins over `pickAttachment`.
   */
  pickers?: AttachPicker[];
  /**
   * Pre-chat gate: rendered over the message list + composer while it returns a node (e.g. a consent
   * card whose button sends your own WS frame and then updates the info); return null to open the chat.
   */
  gate?: (info: ChatGateInfo) => ReactNode | null;
  /** Disables the composer with this reason (alias of `disabledReason`; wins when both are set). */
  composerDisabledReason?: string | null;
  /** Long-press "Delete for me" / "Delete for everyone" (PROTOCOL §9). Default true. */
  deleteActions?: boolean;
  /** Unsend window in seconds (mirror the server's `unsend_window_seconds`; 0 = no limit, -1 = off). Default 3600. */
  unsendWindowSeconds?: number;
  /** "Clear chat" in the header menu (with a confirm dialog). Default true. */
  clearChatMenu?: boolean;
  /** Open documents in the in-app viewer when react-native-webview is installed. Default true. */
  documentViewer?: boolean;
  /** URL the in-app viewer loads for a file (default: the file URL itself). See DocumentViewerModal. */
  documentViewerUrl?: (fileUrl: string) => string;
}

const LOAD_TIMEOUT_MS = 12000;

/** Ready-made conversation screen wired to `useConversation` (header, messages, composer, attachments). */
export const DefaultChatScreen = memo(function ChatScreen({
  peerId,
  chatId,
  onBack,
  onCall,
  renderActions,
  onPressTitle,
  pickAttachment,
  onOpenFile,
  onLongPressMessage,
  peerName,
  disabledReason,
  insets,
  keyboardVerticalOffset = 0,
  keyboardBehavior,
  active = true,
  showConnectionBanner = true,
  maxUploadBytes,
  clock,
  appearanceMenu = false,
  pickWallpaperImage,
  renderGradient,
  menuItems,
  moderationMenu = false,
  replies = true,
  swipeToReply = true,
  messageActionsSheet = true,
  messageActions,
  fileActions,
  onFileActionEvent,
  showToasts = true,
  onOpenVideo,
  pickers,
  gate,
  composerDisabledReason: composerReasonProp,
  deleteActions = true,
  unsendWindowSeconds = DEFAULT_UNSEND_WINDOW_SECONDS,
  clearChatMenu = true,
  documentViewer = true,
  documentViewerUrl,
}: ChatScreenProps) {
  const theme = useTheme();
  const safe = useSafeInsets(insets);
  const convo = useConversation(peerId, { chatId, active });
  const { messages, loading, loadingMore, hasMore, typing, thread, conversation } = convo;
  const profile = useUserProfile(peerId);
  const info = thread?.info;
  const name = conversation?.username || info?.username || profile?.name || peerName || "Unknown";
  const avatar = conversation?.avatar || info?.avatar || profile?.avatar || null;
  const status = conversation?.status || info?.status || null;
  const lastSeen = conversation?.last_seen || info?.last_seen || null;
  const hostReason = composerReasonProp !== undefined ? composerReasonProp : disabledReason;
  // Offline, the store doesn't send get_messages (loading stays false) and re-fetches on
  // reconnect: keep showing the loading state until the first page arrives, not "Say hi".
  const historyPending = loading || !thread || !thread.loaded;

  // ---- width -> bubble max width ----------------------------------------------
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  const bubbleMaxWidth = width
    ? Math.round(width < theme.layout.breakpointTablet ? width * 0.85 : (width * theme.layout.bubbleMaxWidthPct) / 100)
    : undefined;

  // ---- announcements for new incoming messages ----------------------------------
  const newestId = messages.length ? `${peerId}:${String(messages[0].id)}` : null;
  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastAnnounced.current;
    lastAnnounced.current = newestId;
    if (!previous || !newestId || previous === newestId || !previous.startsWith(`${peerId}:`)) return;
    const m = messages[0];
    if (m.isMine || m.message_type === "call") return;
    announce(`New message from ${name}: ${attachmentLabel(m) || m.content}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId]);

  // ---- history load timeout -> inline error with Retry ---------------------------
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    setLoadFailed(false);
    if (!historyPending) return;
    const t = setTimeout(() => setLoadFailed(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [historyPending, peerId]);
  const retryLoad = useCallback(() => {
    setLoadFailed(false);
    convo.refresh();
  }, [convo]);

  // ---- reply -------------------------------------------------------------------
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  useEffect(() => setReplyTo(null), [peerId]);
  const startReply = useMemo(() => (replies ? (m: ChatMessage) => canReplyTo(m) && setReplyTo(m) : undefined), [replies]);
  const cancelReply = useCallback(() => setReplyTo(null), []);
  const replyBar = useMemo(
    () => (replyTo ? { senderName: replySenderLabel(replyTo, name), snippet: replySnippet(replyTo) } : null),
    [replyTo, name],
  );

  // ---- composer ----------------------------------------------------------------
  const onSend = useCallback(
    (text: string) => {
      const ok = replyTo ? convo.send(text, toReplyTarget(replyTo)) : convo.send(text);
      if (!ok) announce("Message not sent. You're offline.");
      else if (replyTo) setReplyTo(null);
      return ok;
    },
    [convo, replyTo],
  );
  const onTypingChange = useCallback((v: boolean) => void convo.setTyping(v), [convo]);
  // ---- moderation (opt-in) -----------------------------------------------------------
  const blocking = useOptionalBlocking();
  const moderation = moderationMenu && blocking ? blocking : null;
  const isBlocked = moderation ? moderation.isBlocked(peerId) : !!info?.is_blocked;
  const blockedByOther = moderation ? moderation.blockedByOther(peerId) : !!info?.blocked_by_other;
  const [reportOpen, setReportOpen] = useState(false);
  const toggleBlock = useCallback(
    (block: boolean) => {
      if (!moderation) return;
      void (block ? moderation.block(peerId) : moderation.unblock(peerId))
        .then(() => announce(block ? `${name} blocked` : `${name} unblocked`))
        .catch(() => announce(block ? "Couldn't block. Try again." : "Couldn't unblock. Try again."));
    },
    [moderation, peerId, name],
  );
  const [clearOpen, setClearOpen] = useState(false);
  const allMenuItems = useMemo(
    () => [
      ...(menuItems || []),
      ...(clearChatMenu ? [{ label: "Clear chat", onPress: () => setClearOpen(true), destructive: true }] : []),
      ...(moderation
        ? moderationMenuItems({ isBlocked, onReport: () => setReportOpen(true), onBlock: () => toggleBlock(true), onUnblock: () => toggleBlock(false) })
        : []),
    ],
    [menuItems, moderation, isBlocked, toggleBlock, clearChatMenu],
  );
  const blockedState = moderation && !hostReason
    ? isBlocked
      ? { kind: "blocked" as const, name, onUnblock: () => toggleBlock(false) }
      : blockedByOther
        ? { kind: "blocked_by_other" as const, name }
        : null
    : null;
  const reason = composerDisabledReason({ hostReason, isBlocked, blockedByOther });

  // ---- attachments -----------------------------------------------------------------
  const [picked, setPicked] = useState<PickedAttachment | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const onAttach = useMemo(
    () =>
      pickers && pickers.length
        ? () => setAttachOpen(true)
        : pickAttachment
        ? async () => {
            try {
              const file = await pickAttachment();
              if (file) setPicked(file);
            } catch {
              announce("Couldn't open the file picker");
            }
          }
        : undefined,
    [pickAttachment, pickers],
  );
  const sendAttachment = useCallback(
    async (file: PickedAttachment) => {
      const ok = replyTo ? await convo.sendMedia(file, toReplyTarget(replyTo)) : await convo.sendMedia(file);
      if (ok) {
        setPicked(null);
        if (replyTo) setReplyTo(null);
      }
      return ok;
    },
    [convo, replyTo],
  );

  // ---- viewers / actions -----------------------------------------------------------
  const [viewer, setViewer] = useState<{ uri: string; message: ChatMessage | null } | null>(null);
  const openImage = useCallback((uri: string, m?: ChatMessage) => setViewer({ uri, message: m ?? null }), []);
  const [docMessage, setDocMessage] = useState<ChatMessage | null>(null);
  const openFile = useCallback(
    (m: ChatMessage) => {
      if (onOpenFile) return onOpenFile(m);
      if (!m.file_url) return;
      if (documentViewer && mediaKindOf(m) === "file" && documentViewerAvailable()) return setDocMessage(m);
      void Linking.openURL(m.file_url).catch(() => announce("Couldn't open the file"));
    },
    [onOpenFile, documentViewer],
  );
  const onCallBack = useMemo(() => (onCall ? () => onCall(peerId) : undefined), [onCall, peerId]);

  // ---- video -------------------------------------------------------------------------
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const openVideo = useCallback(
    (m: ChatMessage) => {
      if (onOpenVideo) return onOpenVideo(m);
      if (m.file_url && inAppVideoAvailable()) return setVideoUri(m.file_url);
      openFile(m);
    },
    [onOpenVideo, openFile],
  );

  // ---- toast + file actions ----------------------------------------------------------
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimer = useRef<any>(null);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const emit = useCallback(
    (e: FileActionEvent) => {
      onFileActionEvent?.(e);
      if (!showToasts) return;
      clearTimeout(toastTimer.current);
      setToast({ text: e.text, tone: e.status === "error" ? "error" : "info", progress: e.status === "progress" ? e.progress ?? null : null });
      if (e.status !== "progress") toastTimer.current = setTimeout(() => setToast(null), e.status === "error" ? 4000 : 2500);
    },
    [onFileActionEvent, showToasts],
  );
  const files = useMemo(() => fileActions || createDefaultFileActions({ openURL: (url) => Linking.openURL(url) }), [fileActions]);
  const runFileAction = useCallback(
    async (action: "download" | "share" | "save", m: ChatMessage) => {
      if (!m.file_url) return;
      const target = { url: m.file_url, name: m.file_name, mimeType: m.file_type, kind: mediaKindOf(m) };
      const busy = action === "save" ? "Saving" : action === "share" ? "Preparing" : "Downloading";
      const onProgress = (p: number) => emit({ action, status: "progress", message: m, progress: p, text: `${busy}… ${Math.round(p * 100)}%` });
      emit({ action, status: "progress", message: m, progress: 0, text: `${busy}…` });
      let result: FileActionResult;
      try {
        result =
          action === "save" ? await files.saveToGallery(target, onProgress) : action === "share" ? await files.share(target, onProgress) : await files.download(target, onProgress);
      } catch (e) {
        result = { ok: false, reason: "failed", error: String((e as Error)?.message || e) };
      }
      if (!result.ok) {
        const text = result.reason === "permission_denied" ? "Allow photo access in Settings to save" : result.error || "Something went wrong";
        return emit({ action, status: "error", message: m, result, text });
      }
      const done = result.fallback ? "Opened" : action === "save" ? "Saved to gallery" : action === "share" ? "Shared" : "Downloaded";
      emit({ action, status: "success", message: m, result, text: done });
    },
    [emit, files],
  );

  // ---- long-press message actions ----------------------------------------------------
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);
  const [reportMessageId, setReportMessageId] = useState<ChatMessage["id"] | null>(null);
  const longPress = useMemo(
    () => onLongPressMessage || (messageActionsSheet ? (m: ChatMessage) => setActionMessage(m) : undefined),
    [onLongPressMessage, messageActionsSheet],
  );
  const sheetActions = useMemo(() => {
    if (!actionMessage) return [];
    const caps = files.capabilities();
    const extra = typeof messageActions === "function" ? messageActions(actionMessage) : messageActions || [];
    return messageActionList(
      actionMessage,
      {
        reply: replies,
        copy: !!getClipboard(),
        saveToGallery: caps.saveToGallery,
        download: caps.download,
        share: caps.share,
        report: !!blocking,
        deleteForMe: deleteActions,
        deleteForEveryone: deleteActions,
        unsendWindowSeconds,
        retry: true,
      },
      extra,
    );
  }, [actionMessage, files, messageActions, replies, blocking, deleteActions, unsendWindowSeconds]);
  const onSelectAction = useCallback(
    (a: MessageAction, m: ChatMessage) => {
      setActionMessage(null);
      if (a.onPress) return a.onPress(m);
      switch (a.key) {
        case "reply":
          return void startReply?.(m);
        case "copy": {
          const text = copyableText(m);
          if (!text) return;
          return void copyText(text).then((ok) =>
            emit({ action: "copy", status: ok ? "success" : "error", message: m, text: ok ? "Copied" : "Couldn't copy" }),
          );
        }
        case "save":
        case "download":
        case "share":
          return void runFileAction(a.key as "save" | "download" | "share", m);
        case "report":
          setReportMessageId(m.id);
          return setReportOpen(true);
        case "retry":
          return void convo.retryMessage(m.id);
        case "deleteForMe":
          if (!convo.deleteMessage(m.id)) announce("Couldn't delete. You're offline.");
          return;
        case "deleteForEveryone":
          if (!convo.deleteMessage(m.id, { forEveryone: true })) announce("Couldn't delete. You're offline.");
          return;
      }
    },
    [startReply, emit, runFileAction, convo],
  );
  const retryMessage = useCallback((m: ChatMessage) => void convo.retryMessage(m.id), [convo]);

  // ---- rate limit toast ----------------------------------------------------------------
  const rateLimitedUntil = convo.rateLimitedUntil;
  useEffect(() => {
    if (!rateLimitedUntil || !showToasts) return;
    const secs = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    if (secs <= 0) return;
    clearTimeout(toastTimer.current);
    setToast({ text: rateLimitText(secs), tone: "error" });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, [rateLimitedUntil, showToasts]);

  // ---- pre-chat gate -------------------------------------------------------------------
  const gateNode = gate
    ? gate({ peerId, name, info: info ?? null, conversation, messages, loaded: !!thread?.loaded, isBlocked, blockedByOther })
    : null;

  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const openAppearance = useMemo(() => (appearanceMenu ? () => setAppearanceOpen(true) : undefined), [appearanceMenu]);

  const behavior = keyboardBehavior ?? (Platform.OS === "ios" ? "padding" : undefined);

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.surface }]} onLayout={onLayout}>
      <ChatHeader
        peerId={peerId}
        name={name}
        avatarUri={avatar}
        status={status}
        typing={typing}
        lastSeen={lastSeen}
        isBlocked={isBlocked}
        blockedByOther={blockedByOther}
        clock={clock}
        onBack={onBack}
        onCall={onCall}
        renderActions={renderActions}
        onPressTitle={onPressTitle}
        insetTop={safe.top}
        onOpenAppearance={openAppearance}
        menuItems={allMenuItems.length ? allMenuItems : undefined}
      />
      {showConnectionBanner ? <ConnectionBanner /> : null}
      <KeyboardAvoidingView style={styles.fill} behavior={behavior} keyboardVerticalOffset={keyboardVerticalOffset}>
        <View style={styles.fill}>
        <View style={[styles.fill, { paddingLeft: safe.left, paddingRight: safe.right, backgroundColor: theme.colors.wallpaper }]}>
          <MessageList
            key={peerId}
            messages={messages}
            loading={historyPending}
            loadingMore={loadingMore}
            hasMore={hasMore}
            typing={typing}
            onLoadMore={convo.loadMore}
            peerName={name}
            bubbleMaxWidth={bubbleMaxWidth}
            onOpenImage={openImage}
            onOpenFile={openFile}
            onCallBack={onCallBack}
            onLongPressMessage={longPress}
            onReplyMessage={startReply}
            swipeToReply={swipeToReply}
            onOpenVideo={openVideo}
            error={loadFailed && !messages.length ? { message: "Couldn't load messages.", onRetry: retryLoad } : null}
            clock={clock}
            peerId={peerId}
            renderGradient={renderGradient}
            onRetryMessage={retryMessage}
          />
          <Toast toast={toast} />
        </View>
        <Composer
          key={peerId}
          onSend={onSend}
          onAttach={onAttach}
          onTypingChange={onTypingChange}
          disabledReason={reason}
          blockedState={blockedState}
          insetBottom={safe.bottom}
          replyTo={replyBar}
          onCancelReply={cancelReply}
        />
        {gateNode != null && gateNode !== false ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.wallpaper }]} accessibilityViewIsModal>
            {gateNode}
          </View>
        ) : null}
        </View>
      </KeyboardAvoidingView>
      <AttachmentPreviewSheet file={picked} onCancel={() => setPicked(null)} onSend={sendAttachment} maxBytes={maxUploadBytes} insetBottom={safe.bottom} />
      {moderation || blocking ? (
        <ReportSheet
          visible={reportOpen}
          peerId={peerId}
          name={name}
          messageId={reportMessageId ?? undefined}
          onClose={() => {
            setReportOpen(false);
            setReportMessageId(null);
          }}
          insetBottom={safe.bottom}
        />
      ) : null}
      <ImageViewer
        uri={viewer?.uri ?? null}
        onClose={() => setViewer(null)}
        insets={insets}
        downloadLabel={files.capabilities().saveToGallery ? "Save" : "Download"}
        onDownload={
          viewer?.message && (files.capabilities().saveToGallery || files.capabilities().download)
            ? () => void runFileAction(files.capabilities().saveToGallery ? "save" : "download", viewer.message as ChatMessage)
            : undefined
        }
        onShare={viewer?.message && files.capabilities().share ? () => void runFileAction("share", viewer.message as ChatMessage) : undefined}
      />
      <DocumentViewerModal
        uri={docMessage?.file_url ?? null}
        name={docMessage?.file_name}
        onClose={() => setDocMessage(null)}
        documentViewerUrl={documentViewerUrl}
        onShare={docMessage && files.capabilities().share ? () => void runFileAction("share", docMessage) : undefined}
        insets={insets}
      />
      {pickers && pickers.length ? (
        <AttachMenu
          visible={attachOpen}
          pickers={pickers}
          onPicked={(file) => setPicked(file)}
          onClose={() => setAttachOpen(false)}
          onError={() => announce("Couldn't open the picker")}
          insetBottom={safe.bottom}
        />
      ) : null}
      <ConfirmDialog
        visible={clearOpen}
        title={`Clear this chat?`}
        message="Messages are removed for you only. The other person keeps their copy."
        confirmLabel="Clear chat"
        destructive
        onCancel={() => setClearOpen(false)}
        onConfirm={() => {
          setClearOpen(false);
          if (!convo.clearChat()) announce("Couldn't clear the chat. You're offline.");
        }}
      />
      <VideoPlayerModal uri={videoUri} onClose={() => setVideoUri(null)} insets={insets} />
      {!onLongPressMessage && messageActionsSheet ? (
        <MessageActionsSheet message={actionMessage} actions={sheetActions} onSelect={onSelectAction} onClose={() => setActionMessage(null)} insetBottom={safe.bottom} />
      ) : null}
      {appearanceMenu ? (
        <AppearanceSheet
          visible={appearanceOpen}
          onClose={() => setAppearanceOpen(false)}
          peerId={peerId}
          pickImage={pickWallpaperImage}
          renderGradient={renderGradient}
          insetBottom={safe.bottom}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({ fill: { flex: 1 } });

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const ChatScreen = slot("ChatScreen", DefaultChatScreen);
