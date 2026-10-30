import { slot } from "./components";
import React, { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  checkAttachmentSize,
  copyableText,
  DEFAULT_UNSEND_WINDOW_SECONDS,
  headerStatus,
  messageActionList,
  replySenderLabel,
  replySnippet,
  toReplyTarget,
  MAX_UPLOAD_BYTES,
  mediaKindOf,
  type ChatError,
  type ChatMessage,
  type ClockFormat,
  type Conversation,
  type ConversationInfoDto,
  type MessageAction,
} from "commskit/engine";
import { ChatWallpaper, useAppearance } from "./appearance";
import { Composer } from "./Composer";
import { displayName } from "./ConversationListScreen";
import { useAnnouncer, useKeyboardInset, useTabVisible, useTicker, useToasts } from "./hooks";
import { MessageList } from "./messages";
import { useChatErrors, useComms, useConversation, useOptionalBlocking, useUserProfile } from "./providers";
import {
  AppearanceSheet,
  AttachmentPreviewSheet,
  canShareFiles,
  DocumentViewer,
  ImageLightbox,
  ReportSheet,
  shareUrl,
  type PendingAttachment,
} from "./sheets";
import { Avatar, ConfirmDialog, ConnectionBanner, Icon, LiveRegion, PopupMenu, ToastStack, type MenuItem, type WebIconName } from "./ui";
import { cx, downloadFile, resolveMediaUrl } from "./util";

/** What a pre-chat gate (ChatScreen `gate`) gets to decide whether to show itself. */
export interface ChatGateInfo {
  peerId: string;
  name: string;
  info: ConversationInfoDto | null;
  conversation: Conversation | undefined;
  messages: ChatMessage[];
  loaded: boolean;
  isBlocked: boolean;
  blockedByOther: boolean;
}

export interface ChatHeaderMenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export interface ChatHeaderProps {
  peerId: string;
  name: string;
  avatar?: string | null;
  status?: string | null;
  lastSeen?: string | null;
  typing?: boolean;
  isBlocked?: boolean;
  blockedByOther?: boolean;
  onBack?: () => void;
  onCall?: (peerId: string) => void;
  actions?: ReactNode;
  menuItems?: MenuItem[];
  clock?: ClockFormat;
}

export const DefaultChatHeader: React.FC<ChatHeaderProps> = ({ peerId, name, avatar, status, lastSeen, typing, isBlocked, blockedByOther, onBack, onCall, actions, menuItems, clock }) => {
  // One shared 60 s timer refreshes "last seen 5 min ago".
  useTicker(60000);
  const presence = headerStatus({ typing, status, lastSeen, isBlocked, blockedByOther, clock, now: new Date() });
  const [menu, setMenu] = useState<{ x: number; y: number; align: "right" } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <header className="ck-chat-header">
      {onBack ? (
        <button type="button" className="ck-icon-btn ck-back" aria-label="Back to chats" onClick={onBack}>
          <Icon name="back" />
        </button>
      ) : null}
      <Avatar name={name} id={peerId} src={avatar} size={40} online={presence.showOnlineDot} />
      <div className="ck-header-text">
        <h2 className="ck-header-name">{name}</h2>
        <p className="ck-header-status" data-kind={presence.kind} data-tone={presence.tone} aria-live="polite">
          {presence.text}
        </p>
      </div>
      <div className="ck-header-actions">
        {actions}
        {onCall && presence.canCall ? (
          <button type="button" className="ck-icon-btn" aria-label={`Call ${name}`} onClick={() => onCall(peerId)}>
            <Icon name="call" />
          </button>
        ) : null}
        {menuItems && menuItems.length ? (
          <button
            ref={btn}
            type="button"
            className="ck-icon-btn"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={() => {
              const r = btn.current?.getBoundingClientRect();
              setMenu(r ? { x: r.right, y: r.bottom + 4, align: "right" } : { x: 200, y: 56, align: "right" });
            }}
          >
            <Icon name="more" />
          </button>
        ) : null}
      </div>
      {menu && menuItems ? <PopupMenu label="Chat options" anchor={menu} items={menuItems} onClose={() => setMenu(null)} /> : null}
    </header>
  );
};

export interface ChatScreenProps {
  peerId: string;
  chatId?: number | null;
  /** Back button (single-pane layout). Omit in split layouts. */
  onBack?: () => void;
  /** Shows a call button in the header and "Call back" on call entries. The web package has no calling: wire your own. */
  onCall?: (peerId: string) => void;
  /** Extra header buttons (before the call button). */
  renderActions?: (ctx: { peerId: string; name: string }) => ReactNode;
  /** Name shown until the conversation / directory knows it. */
  peerName?: string;
  /** Disables the composer with this reason ("Chat is not enabled"). */
  disabledReason?: string | null;
  /** Pre-chat gate rendered over the messages + composer while it returns a node. */
  gate?: (info: ChatGateInfo) => ReactNode | null;
  /** Optional document preview: return an iframe URL for a file (e.g. a Google Docs viewer / your own). */
  documentViewerUrl?: (message: ChatMessage, fileUrl: string) => string | null | undefined;
  /** Mirrors the server's `ChatConfig.unsend_window_seconds` (default 3600; 0 = no limit, -1 = off). */
  unsendWindowSeconds?: number;
  maxUploadBytes?: number;
  clock?: ClockFormat;
  /** "Wallpaper" in the overflow menu (default: when an AppearanceProvider is present). */
  appearanceMenu?: boolean;
  /** Report / Block / Unblock (default: when a ModerationProvider is present). */
  moderationMenu?: boolean;
  menuItems?: ChatHeaderMenuItem[];
  /** Extra items in the message actions menu. */
  messageActions?: MessageAction[] | ((message: ChatMessage) => MessageAction[]);
  /** Reply UI: menu item, swipe, reply bar, quote jump (default true). */
  replies?: boolean;
  swipeToReply?: boolean;
  showConnectionBanner?: boolean;
  /** Media base URL for relative `file_url`s. Default: the CommsWebProvider baseUrl. */
  mediaBaseUrl?: string;
  /** Treat the chat as on screen (default true). Pass false if the screen stays mounted while hidden. */
  active?: boolean;
  placeholder?: string;
  className?: string;
}

const ICONS: Record<string, WebIconName> = { reply: "reply", copy: "copy", download: "download", share: "share", report: "flag", retry: "retry", deleteForMe: "trash", deleteForEveryone: "trash" };

export const DefaultChatScreen: React.FC<ChatScreenProps> = ({
  peerId,
  chatId,
  onBack,
  onCall,
  renderActions,
  peerName,
  disabledReason,
  gate,
  documentViewerUrl,
  unsendWindowSeconds = DEFAULT_UNSEND_WINDOW_SECONDS,
  maxUploadBytes = MAX_UPLOAD_BYTES,
  clock,
  appearanceMenu,
  moderationMenu,
  menuItems: extraMenuItems,
  messageActions: extraActions,
  replies = true,
  swipeToReply = true,
  showConnectionBanner = true,
  mediaBaseUrl,
  active = true,
  placeholder,
  className,
}) => {
  const { client, config } = useComms();
  const baseUrl = mediaBaseUrl ?? config.baseUrl;
  const tabVisible = useTabVisible();
  const conv = useConversation(peerId, { chatId, active: active && tabVisible });
  const appearance = useAppearance();
  const moderation = useOptionalBlocking();
  const profile = useUserProfile(peerId);
  const toasts = useToasts();
  const live = useAnnouncer();
  const keyboardInset = useKeyboardInset();
  const myId = client.userId;

  const c = conv.conversation;
  const info = conv.thread?.info ?? null;
  const name = peerName || profile?.name || (c ? displayName(c) : info?.username || `User ${peerId}`);
  const avatar = profile?.avatar || c?.avatar || info?.avatar || null;
  const status = info?.status ?? c?.status;
  const lastSeen = info?.last_seen ?? c?.last_seen;
  const isBlocked = !!(moderation?.isBlocked(peerId) || info?.is_blocked || c?.is_blocked);
  const blockedByOther = !!(moderation?.blockedByOther(peerId) || info?.blocked_by_other || c?.blocked_by_other);

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [menu, setMenu] = useState<{ message: ChatMessage; x: number; y: number } | null>(null);
  const [image, setImage] = useState<ChatMessage | null>(null);
  const [doc, setDoc] = useState<ChatMessage | null>(null);
  const [report, setReport] = useState<{ messageId?: string | number } | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "block" | "clear" | "unsend"; message?: ChatMessage }>(null);
  const [showAppearance, setShowAppearance] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [highlight, setHighlight] = useState<number | string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const listCtl = useRef<{ jumpTo: (id: number | string) => boolean } | null>(null);
  const dragDepth = useRef(0);

  // new peer -> reset local UI state
  useEffect(() => {
    setReplyTo(null);
    setMenu(null);
    setPending([]);
  }, [peerId]);

  // coming back to the tab: the messages that arrived meanwhile are now seen
  const wasHidden = useRef(false);
  useEffect(() => {
    if (!tabVisible) wasHidden.current = true;
    else if (wasHidden.current) {
      wasHidden.current = false;
      conv.markRead();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabVisible]);

  // store errors (send failed, too large, rate limited, ...) -> toasts
  const showToast = toasts.show;
  useChatErrors(
    useCallback(
      (e: ChatError) => {
        if (e.peerId && String(e.peerId) !== String(peerId)) return;
        if (e.kind === "rate_limited") return; // the composer shows its own countdown notice
        showToast(e.message, { tone: "error" });
      },
      [peerId, showToast],
    ),
  );

  const fileUrl = (m: ChatMessage) => resolveMediaUrl(m.file_url, baseUrl);

  // ---- attachments ---------------------------------------------------------------------------------------
  const addFiles = useCallback(
    (files: File[]) => {
      const ok: PendingAttachment[] = [];
      for (const f of files) {
        const check = checkAttachmentSize(f.size, maxUploadBytes);
        if (!check.ok) showToast(`${f.name}: ${check.message}`, { tone: "error" });
        else ok.push({ file: f, url: URL.createObjectURL(f) });
      }
      if (ok.length) setPending((p) => [...p, ...ok]);
    },
    [maxUploadBytes, showToast],
  );
  const sendPending = () => {
    const [first, ...rest] = pending;
    if (!first) return;
    const f = first.file;
    void conv.sendMedia({ uri: first.url, name: f.name, type: f.type || "application/octet-stream", size: f.size }, replyTo ? toReplyTarget(replyTo) : null);
    setReplyTo(null);
    setPending(rest);
    setTimeout(() => URL.revokeObjectURL(first.url), 120000);
  };
  const cancelPending = () => {
    const [first, ...rest] = pending;
    if (first) URL.revokeObjectURL(first.url);
    setPending(rest);
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!blockedByOther && !isBlocked && !disabledReason) addFiles(Array.from(e.dataTransfer.files));
    },
  };

  // ---- message actions -----------------------------------------------------------------------------------
  const messageMenuItems = (m: ChatMessage): MenuItem[] => {
    const extra = typeof extraActions === "function" ? extraActions(m) : extraActions || [];
    const list = messageActionList(
      m,
      {
        reply: replies && !isBlocked && !blockedByOther,
        copy: true,
        download: true,
        share: canShareFiles(),
        report: !!moderation && moderationMenu !== false,
        deleteForMe: true,
        deleteForEveryone: true,
        unsendWindowSeconds,
        retry: true,
      },
      extra,
    );
    return list.map((a) => ({
      key: a.key,
      label: a.label,
      icon: ICONS[a.key],
      destructive: a.destructive,
      onSelect: () => runAction(a, m),
    }));
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      ta.remove();
      showToast(ok ? "Copied" : "Couldn't copy", ok ? {} : { tone: "error" });
    }
  };

  const runAction = (a: MessageAction, m: ChatMessage) => {
    switch (a.key) {
      case "reply":
        setReplyTo(m);
        setFocusTick((n) => n + 1);
        break;
      case "copy": {
        const t = copyableText(m);
        if (t) void copy(t);
        break;
      }
      case "download":
        void downloadFile(fileUrl(m), m.file_name);
        break;
      case "share":
        void shareUrl(fileUrl(m), m.file_name).then((ok) => !ok && showToast("Sharing was cancelled"));
        break;
      case "report":
        setReport({ messageId: m.id });
        break;
      case "retry":
        void conv.retryMessage(m.id);
        break;
      case "deleteForMe":
        conv.deleteMessage(m.id);
        break;
      case "deleteForEveryone":
        setConfirm({ kind: "unsend", message: m });
        break;
      default:
        a.onPress?.(m);
    }
  };

  // ---- header menu ---------------------------------------------------------------------------------------
  const headerItems: MenuItem[] = [];
  if (appearanceMenu ?? appearance.available) headerItems.push({ key: "wallpaper", label: "Wallpaper", icon: "palette", onSelect: () => setShowAppearance(true) });
  if (moderation && moderationMenu !== false) {
    headerItems.push({ key: "report", label: "Report", icon: "flag", destructive: true, onSelect: () => setReport({}) });
    if (isBlocked) headerItems.push({ key: "unblock", label: "Unblock", icon: "ban", onSelect: () => void unblock() });
    else headerItems.push({ key: "block", label: "Block", icon: "ban", destructive: true, onSelect: () => setConfirm({ kind: "block" }) });
  }
  headerItems.push({ key: "clear", label: "Clear chat", icon: "trash", destructive: true, onSelect: () => setConfirm({ kind: "clear" }) });
  for (const it of extraMenuItems || []) headerItems.push({ key: `x:${it.label}`, label: it.label, destructive: it.destructive, onSelect: it.onSelect });

  const block = async () => {
    try {
      await moderation?.block(peerId);
      showToast(`Blocked ${name}`);
    } catch (e) {
      showToast((e as Error)?.message || "Couldn't block", { tone: "error" });
    }
  };
  async function unblock() {
    try {
      await moderation?.unblock(peerId);
      showToast(`Unblocked ${name}`);
    } catch (e) {
      showToast((e as Error)?.message || "Couldn't unblock", { tone: "error" });
    }
  }

  // ---- gate -------------------------------------------------------------------------------------------------
  const gateNode = gate
    ? gate({ peerId, name, info, conversation: c, messages: conv.messages, loaded: !!conv.thread?.loaded, isBlocked, blockedByOther })
    : null;
  const gated = gateNode != null && gateNode !== false;

  const wallpaper = appearance.wallpaperFor(peerId);
  const viewerUrl = doc ? documentViewerUrl?.(doc, fileUrl(doc)) ?? null : null;

  const onJump = (id: number | string) => {
    setHighlight(id);
    setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1800);
  };

  return (
    <section className={cx("ck-chat", className)} aria-label={`Chat with ${name}`} style={keyboardInset ? { paddingBottom: keyboardInset } : undefined} {...dropHandlers}>
      <ChatHeader
        peerId={peerId}
        name={name}
        avatar={avatar}
        status={status}
        lastSeen={lastSeen}
        typing={conv.typing}
        isBlocked={isBlocked}
        blockedByOther={blockedByOther}
        onBack={onBack}
        onCall={onCall}
        actions={renderActions?.({ peerId, name })}
        menuItems={headerItems}
        clock={clock}
      />
      {showConnectionBanner ? <ConnectionBanner /> : null}
      <div className="ck-chat-body">
        <ChatWallpaper wallpaper={wallpaper} />
        {gated ? (
          <div className="ck-gate">{gateNode}</div>
        ) : (
          <MessageList
            messages={conv.messages}
            peerId={peerId}
            peerName={name}
            myId={myId}
            baseUrl={baseUrl}
            loading={conv.loading}
            loadingMore={conv.loadingMore}
            hasMore={conv.hasMore}
            typing={conv.typing && !isBlocked && !blockedByOther}
            onLoadMore={conv.loadMore}
            highlightId={highlight}
            clock={clock}
            swipeToReply={swipeToReply && replies}
            controlRef={listCtl}
            onIncoming={(m) => live.announce(`${name}: ${replySnippet(m, 120)}`)}
            onQuoteNotLoaded={() => showToast("The original message isn't loaded yet. Scroll up to load older messages.")}
            onMenu={(message, p) => setMenu({ message, x: p.x, y: p.y })}
            onReply={replies && !isBlocked && !blockedByOther ? (m) => (setReplyTo(m), setFocusTick((n) => n + 1)) : undefined}
            onOpenImage={setImage}
            onOpenFile={setDoc}
            onJumpToQuote={(id) => {
              if (listCtl.current?.jumpTo(id)) onJump(id);
            }}
            onRetry={(m) => void conv.retryMessage(m.id)}
            onCallBack={onCall}
          />
        )}
        {dragging ? (
          <div className="ck-drop" role="status">
            <Icon name="attach" size={32} />
            <span>Drop to send</span>
          </div>
        ) : null}
        <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
      </div>
      {gated ? null : (
        <Composer
          onSend={(text) => {
            const ok = conv.send(text, replyTo ? toReplyTarget(replyTo) : null);
            if (ok) setReplyTo(null);
            return ok;
          }}
          onAttach={addFiles}
          onTyping={(t) => conv.setTyping(t)}
          replyTo={replyTo ? { sender: replySenderLabel(replyTo, name, myId), snippet: replySnippet(replyTo, 100) } : null}
          onCancelReply={() => setReplyTo(null)}
          disabledReason={disabledReason}
          blocked={isBlocked ? { kind: "blocked", name, onUnblock: moderation ? () => void unblock() : undefined } : blockedByOther ? { kind: "blocked_by_other", name } : null}
          rateLimitedUntil={conv.rateLimitedUntil}
          placeholder={placeholder}
          focusKey={`${peerId}:${focusTick}`}
        />
      )}
      <LiveRegion text={live.text} />

      {menu ? (
        <PopupMenu
          label="Message actions"
          anchor={{ x: menu.x, y: menu.y }}
          items={messageMenuItems(menu.message)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {image ? <ImageLightbox url={fileUrl(image)} name={image.file_name} onClose={() => setImage(null)} /> : null}
      {doc ? <DocumentViewer url={fileUrl(doc)} name={doc.file_name} type={doc.file_type} size={doc.file_size} viewerUrl={viewerUrl} onClose={() => setDoc(null)} /> : null}
      {pending.length ? <AttachmentPreviewSheet attachment={pending[0]} maxBytes={maxUploadBytes} onSend={sendPending} onCancel={cancelPending} /> : null}
      {report ? (
        <ReportSheet peerId={peerId} name={name} messageId={report.messageId} onClose={() => setReport(null)} onDone={(t) => showToast(t)} />
      ) : null}
      {showAppearance ? <AppearanceSheet peerId={peerId} peerName={name} onClose={() => setShowAppearance(false)} onNotice={(t) => showToast(t, { tone: "error" })} /> : null}
      {confirm?.kind === "block" ? (
        <ConfirmDialog
          title={`Block ${name}?`}
          text="They won't be able to message you, and you won't see each other's presence."
          confirmLabel="Block"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => (setConfirm(null), void block())}
        />
      ) : null}
      {confirm?.kind === "clear" ? (
        <ConfirmDialog
          title="Clear this chat?"
          text="This removes the messages for you only. The other person keeps theirs."
          confirmLabel="Clear chat"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => (setConfirm(null), conv.clearChat())}
        />
      ) : null}
      {confirm?.kind === "unsend" && confirm.message ? (
        <ConfirmDialog
          title="Delete for everyone?"
          text={`${mediaKindOf(confirm.message) ? "This file" : "This message"} will be removed for both of you.`}
          confirmLabel="Delete for everyone"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const m = confirm.message as ChatMessage;
            setConfirm(null);
            conv.deleteMessage(m.id, { forEveryone: true });
          }}
        />
      ) : null}
    </section>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const ChatHeader = slot("ChatHeader", DefaultChatHeader);
export const ChatScreen = slot("ChatScreen", DefaultChatScreen);
