/** MessageBubble + MessageList (grouping, date separators, sticky date, windowing, jump-to-latest). */
import { slot } from "./components";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildMessageRows,
  createStickyLabelController,
  DELETED_MINE_TEXT,
  DELETED_TEXT,
  describeCallEntry,
  documentBadge,
  documentMeta,
  formatMediaDuration,
  formatMessageTime,
  isCallMessage,
  isDeletedMessage,
  isPlaceholder,
  isSystemMessage,
  mediaKindOf,
  messageTicks,
  replySenderLabel,
  replySnippet,
  shouldTriggerReply,
  stickyDateLabel,
  swipeReplyOffset,
  TICK_GLYPHS,
  TICK_LABELS,
  type ChatMessage,
  type ClockFormat,
  type MessageListRow,
} from "commskit/engine";
import { useReducedMotion } from "./hooks";
import { Icon } from "./ui";
import { cx, resolveMediaUrl, splitLinks } from "./util";

/** Message text with clickable links (rel=noopener noreferrer, new tab). */
export const DefaultLinkified: React.FC<{ text: string }> = ({ text }) => (
  <>
    {splitLinks(text).map((p, i) =>
      p.type === "link" ? (
        <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className="ck-link" onClick={(e) => e.stopPropagation()}>
          {p.text}
        </a>
      ) : (
        <React.Fragment key={i}>{p.text}</React.Fragment>
      ),
    )}
  </>
);

export interface BubbleHandlers {
  onMenu: (message: ChatMessage, point: { x: number; y: number }) => void;
  onReply?: (message: ChatMessage) => void;
  onOpenImage: (message: ChatMessage) => void;
  onOpenFile: (message: ChatMessage) => void;
  onJumpToQuote?: (replyId: number | string) => void;
  onRetry?: (message: ChatMessage) => void;
  onCallBack?: (peerId: string) => void;
}

export interface MessageBubbleProps extends BubbleHandlers {
  message: ChatMessage;
  groupStart: boolean;
  groupEnd: boolean;
  peerId: string;
  peerName: string;
  myId?: string | null;
  baseUrl?: string;
  highlighted?: boolean;
  clock?: ClockFormat;
  swipeToReply?: boolean;
  index: number;
}

const LONG_PRESS_MS = 450;

export const DefaultMessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
  const { message: m, groupStart, groupEnd, peerId, peerName, myId, baseUrl, highlighted, clock, swipeToReply = true, index } = props;
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; id: number; active: boolean; timer: ReturnType<typeof setTimeout> | null; fired: boolean } | null>(null);

  const kind = mediaKindOf(m);
  const deleted = isDeletedMessage(m);
  const ticks = messageTicks(m);
  const time = formatMessageTime(m.timestamp, clock);
  const url = resolveMediaUrl(m.file_url, baseUrl);
  const thumb = resolveMediaUrl(m.thumbnail_url || m.file_url, baseUrl);
  const caption = (() => {
    const t = (m.content || "").trim();
    return t && !isPlaceholder(t) && t !== m.file_name ? t : "";
  })();

  // ---- touch: swipe right to reply, long press for the menu -----------------------------------------
  const clearTimer = () => {
    if (drag.current?.timer) clearTimeout(drag.current.timer);
    if (drag.current) drag.current.timer = null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || e.button > 0) return;
    const d = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, timer: null as ReturnType<typeof setTimeout> | null, fired: false };
    d.timer = setTimeout(() => {
      d.fired = true;
      props.onMenu(m, { x: d.x, y: d.y });
    }, LONG_PRESS_MS);
    drag.current = d;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.fired) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimer();
    if (!d.active) {
      if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) {
        drag.current = null; // vertical scroll wins
        return;
      }
      if (mx > 12 && Math.abs(mx) > Math.abs(my) * 1.5 && swipeToReply && props.onReply) {
        d.active = true;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    }
    if (d.active) setDx(swipeReplyOffset(mx));
  };
  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    clearTimer();
    drag.current = null;
    if (!d) return;
    if (d.active) {
      const mx = e.clientX - d.x;
      setDx(0);
      if (!cancelled && shouldTriggerReply(mx)) props.onReply?.(m);
    }
  };
  useEffect(() => () => clearTimer(), []);

  const openMenuFromButton = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    props.onMenu(m, { x: r.left, y: r.bottom + 4 });
  };

  // ---- system / call chips ----------------------------------------------------------------------------
  if (isCallMessage(m)) {
    const c = describeCallEntry(m);
    return (
      <div className={cx("ck-msg-row ck-call-row", m.isMine ? "is-mine" : "is-theirs")} data-index={index} data-msg-id={String(m.id)}>
        <div className={cx("ck-call-chip", c.danger && "is-danger")} role="group" aria-label={c.accessibilityLabel}>
          <Icon name={c.icon === "callOutgoing" ? "callOutgoing" : c.icon === "callMissed" ? "callMissed" : "callIncoming"} size={18} />
          <span className="ck-call-text">
            <span className="ck-call-title">{c.title}</span>
            <span className="ck-call-detail">
              {c.detail} · {time}
            </span>
          </span>
          {props.onCallBack && c.canCallBack ? (
            <button type="button" className="ck-btn ck-btn-small" onClick={() => props.onCallBack?.(peerId)}>
              Call back
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (isSystemMessage(m)) {
    return (
      <div className="ck-msg-row ck-system-row" data-index={index} data-msg-id={String(m.id)}>
        <div className="ck-system-chip">{m.content}</div>
      </div>
    );
  }

  const quote = m.reply_to;
  const sender = quote ? replySenderLabel({ sender_id: quote.sender_id }, peerName, myId) : "";

  return (
    <div
      ref={ref}
      className={cx("ck-msg-row", m.isMine ? "is-mine" : "is-theirs", groupStart && "is-group-start", groupEnd && "is-group-end", highlighted && "is-highlighted")}
      data-index={index}
      data-msg-id={String(m.id)}
      tabIndex={-1}
      role="article"
      aria-label={`${m.isMine ? "You" : peerName}: ${deleted ? (m.isMine ? DELETED_MINE_TEXT : DELETED_TEXT) : replySnippet(m, 80)}, ${time}${ticks ? `, ${TICK_LABELS[ticks]}` : ""}${m.failed ? ", failed to send" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(m, { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          props.onMenu(m, { x: r.left + 24, y: r.top + 24 });
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
    >
      {dx > 0 ? (
        <span className="ck-swipe-hint" style={{ opacity: Math.min(1, dx / 56) }} aria-hidden="true">
          <Icon name="reply" size={18} />
        </span>
      ) : null}
      <div
        className={cx("ck-bubble", m.isMine ? "ck-out" : "ck-in", groupStart && "ck-tail", deleted && "is-deleted", kind === "image" && !caption && !quote && "is-media-only", m.failed && "is-failed")}
        style={dx ? { transform: `translateX(${dx}px)`, transition: "none" } : reduced ? undefined : undefined}
      >
        {quote ? (
          <button
            type="button"
            className="ck-quote"
            aria-label={`Replying to ${sender}: ${replySnippet(quote, 80)}. Jump to original`}
            onClick={(e) => {
              e.stopPropagation();
              props.onJumpToQuote?.(quote.id);
            }}
          >
            <span className="ck-quote-sender">{sender}</span>
            <span className="ck-quote-text">{replySnippet(quote, 100)}</span>
          </button>
        ) : null}

        {deleted ? <span className="ck-deleted-text">{m.isMine ? DELETED_MINE_TEXT : DELETED_TEXT}</span> : null}

        {!deleted && kind === "image" ? (
          <button type="button" className="ck-thumb-btn" aria-label={`Open photo ${m.file_name || ""}`.trim()} onClick={() => props.onOpenImage(m)}>
            <img className="ck-thumb" src={thumb} alt={m.file_name || "Photo"} loading="lazy" decoding="async" />
          </button>
        ) : null}
        {!deleted && kind === "video" ? (
          <video className="ck-video" src={url} controls preload="metadata" playsInline aria-label={m.file_name || "Video"} />
        ) : null}
        {!deleted && kind === "audio" ? (
          <div className="ck-audio">
            <audio controls preload="none" src={url} aria-label={m.file_name || "Audio message"} />
            {m.duration ? <span className="ck-muted">{formatMediaDuration(m.duration)}</span> : null}
          </div>
        ) : null}
        {!deleted && kind === "file" ? <FileCard m={m} url={url} onOpen={() => props.onOpenFile(m)} /> : null}

        {!deleted && (kind === null ? !!m.content : !!caption) ? (
          <span className="ck-text">
            <Linkified text={kind === null ? m.content : caption} />
          </span>
        ) : null}

        <span className="ck-meta">
          <time className="ck-time" dateTime={m.timestamp}>
            {time}
          </time>
          {ticks ? (
            <span className="ck-ticks" data-state={ticks} role="img" aria-label={TICK_LABELS[ticks]}>
              {TICK_GLYPHS[ticks]}
            </span>
          ) : null}
        </span>
        {m.failed ? (
          <span className="ck-failed" role="alert">
            <Icon name="ban" size={14} />
            {m.failReason === "too_long" ? "Too long" : "Not sent"}
            <button type="button" className="ck-link-btn" onClick={() => props.onRetry?.(m)}>
              Retry
            </button>
          </span>
        ) : null}
      </div>
      <button type="button" className="ck-msg-more" aria-label="Message actions" aria-haspopup="menu" tabIndex={-1} onClick={openMenuFromButton}>
        <Icon name="more" size={16} />
      </button>
    </div>
  );
});

const FileCard: React.FC<{ m: ChatMessage; url: string; onOpen: () => void }> = ({ m, url, onOpen }) => {
  const badge = documentBadge(m.file_name, m.file_type);
  return (
    <div className="ck-file-card">
      <button type="button" className="ck-file-open" onClick={onOpen} aria-label={`Open ${m.file_name || "file"}`}>
        <span className="ck-doc-badge" data-color={badge.colorToken} aria-hidden="true">
          {badge.label}
        </span>
        <span className="ck-file-text">
          <span className="ck-file-name">{m.file_name || "File"}</span>
          <span className="ck-file-meta">{documentMeta(m.file_name, m.file_type, m.file_size)}</span>
        </span>
      </button>
      <a className="ck-file-dl" href={url} download={m.file_name || undefined} target="_blank" rel="noopener noreferrer" aria-label={`Download ${m.file_name || "file"}`}>
        <Icon name="download" size={18} />
      </a>
    </div>
  );
};

// ---- MessageList ------------------------------------------------------------------------------------------------

export interface MessageListProps extends BubbleHandlers {
  /** Newest first (as `useConversation` returns them). */
  messages: ChatMessage[];
  peerId: string;
  peerName: string;
  myId?: string | null;
  baseUrl?: string;
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  typing?: boolean;
  onLoadMore: () => void;
  /** Rows rendered at the bottom; grows by the same amount when scrolled to the top (default 120). */
  windowSize?: number;
  highlightId?: number | string | null;
  /** The quoted message is not in the loaded history. */
  onQuoteNotLoaded?: () => void;
  /** Called with the number of unseen incoming messages while scrolled up (for the jump button). */
  clock?: ClockFormat;
  swipeToReply?: boolean;
  /** A new incoming message arrived while the user is reading (announce hook). */
  onIncoming?: (message: ChatMessage) => void;
  emptyText?: string;
  /** Imperative handle (jump to a quoted message). */
  controlRef?: React.MutableRefObject<{ jumpTo: (id: number | string) => boolean } | null>;
}

const NEAR_BOTTOM = 80;
const NEAR_TOP = 240;

export const DefaultMessageList: React.FC<MessageListProps> = (props) => {
  const { messages, peerId, peerName, myId, baseUrl, loading, loadingMore, hasMore, typing, onLoadMore, windowSize = 120, highlightId, clock, swipeToReply } = props;
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const [windowRows, setWindowRows] = useState(windowSize);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [stickyLabel, setStickyLabel] = useState<string | null>(null);
  const [stickyVisible, setStickyVisible] = useState(false);
  const atBottomRef = useRef(true);
  /** scroll geometry at the moment older messages were requested (restores the position when they arrive) */
  const loadAnchor = useRef<{ h: number; t: number } | null>(null);
  const prev = useRef<{ firstId: string | null; lastId: string | null; len: number; scrollHeight: number; scrollTop: number }>({ firstId: null, lastId: null, len: 0, scrollHeight: 0, scrollTop: 0 });
  const rows = useMemo<MessageListRow[]>(() => buildMessageRows(messages), [messages]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Window: the newest `windowRows` rows (rows are newest first).
  const shown = rows.length > windowRows ? rows.slice(0, windowRows) : rows;
  const chron = useMemo(() => shown.map((r, i) => ({ r, i })).reverse(), [shown]);
  const hiddenOlder = rows.length - shown.length;

  const sticky = useRef(createStickyLabelController((v) => setStickyVisible(v)));
  useEffect(() => {
    const c = sticky.current;
    return () => c.dispose();
  }, []);

  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      const el = scroller.current;
      if (!el) return;
      if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
      else el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
      setNewCount(0);
    },
    [reduced],
  );

  // New / prepended messages: stick to bottom, count unseen, keep position when older pages arrive.
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = prev.current;
    const newest = messages[0];
    const oldest = messages[messages.length - 1];
    const lastId = newest ? String(newest.id) : null;
    const firstId = oldest ? String(oldest.id) : null;
    if (el) {
      if (p.len === 0 && messages.length > 0) {
        scrollToBottom(false);
      } else if (lastId !== p.lastId && p.len > 0) {
        // something new at the bottom (or an optimistic id swapped for the server id)
        const grew = messages.length > p.len;
        if (newest?.isMine || atBottomRef.current) scrollToBottom(!newest?.isMine);
        else if (grew) {
          const added = messages.length - p.len;
          const fresh = messages.slice(0, added).filter((m) => !m.isMine && !isCallMessage(m)).length;
          if (fresh) setNewCount((n) => n + fresh);
        }
      } else if (firstId !== p.firstId && p.len > 0 && messages.length > p.len) {
        // older page prepended: keep what the user is looking at in place
        const a = loadAnchor.current;
        loadAnchor.current = null;
        el.scrollTop = (a ? a.t : el.scrollTop) + (el.scrollHeight - (a ? a.h : p.scrollHeight));
      } else if (atBottomRef.current && el.scrollHeight - el.scrollTop - el.clientHeight > 2) {
        scrollToBottom(false); // layout grew (image decoded, typing bubble)
      }
    }
    prev.current = { firstId, lastId, len: messages.length, scrollHeight: el?.scrollHeight ?? 0, scrollTop: el?.scrollTop ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, scrollToBottom]);

  useLayoutEffect(() => {
    if (typing && atBottomRef.current) scrollToBottom(false);
  }, [typing, scrollToBottom]);

  // Announce incoming messages (screen readers).
  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    const newest = messages[0];
    if (!newest) return;
    const id = String(newest.id);
    if (lastAnnounced.current === null) {
      lastAnnounced.current = id;
      return;
    }
    if (lastAnnounced.current !== id) {
      lastAnnounced.current = id;
      if (!newest.isMine && !String(newest.id).startsWith("temp_")) props.onIncoming?.(newest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const updateSticky = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const nodes = el.querySelectorAll<HTMLElement>("[data-index]");
    for (const n of Array.from(nodes)) {
      if (n.getBoundingClientRect().bottom > top + 4) {
        const idx = Number(n.getAttribute("data-index"));
        setStickyLabel(stickyDateLabel(rowsRef.current, idx));
        return;
      }
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = dist < NEAR_BOTTOM;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setNewCount(0);
    sticky.current.onScroll();
    updateSticky();
    if (el.scrollTop < NEAR_TOP) {
      if (hiddenOlder > 0) {
        // reveal more rows from memory first (keeps the DOM small), then ask the server
        const before = el.scrollHeight;
        const top = el.scrollTop;
        setWindowRows((w) => w + windowSize);
        requestAnimationFrame(() => {
          if (scroller.current) scroller.current.scrollTop = top + (scroller.current.scrollHeight - before);
        });
      } else if (hasMore && !loadingMore && !loading) {
        loadAnchor.current = { h: el.scrollHeight, t: el.scrollTop };
        onLoadMore();
      }
    }
  };

  // Short histories that do not fill the viewport can't be scrolled: load more until they do.
  useEffect(() => {
    const el = scroller.current;
    if (!el || loading || loadingMore || !hasMore || hiddenOlder > 0) return;
    if (messages.length > 0 && el.scrollHeight <= el.clientHeight + 4 && typeof ResizeObserver !== "undefined") onLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, loading, loadingMore, hasMore]);

  const jumpTo = useCallback(
    (id: number | string): boolean => {
      const idx = rowsRef.current.findIndex((r) => r.kind === "message" && String(r.message.id) === String(id));
      if (idx < 0) return false;
      if (idx >= windowRows) setWindowRows(idx + 20);
      const find = () => scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(String(id))}"]`);
      const go = () => {
        const el = find();
        if (el) el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      };
      requestAnimationFrame(go);
      return true;
    },
    [windowRows, reduced],
  );
  useEffect(() => {
    if (props.controlRef) props.controlRef.current = { jumpTo };
    return () => {
      if (props.controlRef) props.controlRef.current = null;
    };
  }, [jumpTo, props.controlRef]);

  const onQuote = (id: number | string) => {
    if (jumpTo(id)) props.onJumpToQuote?.(id);
    else props.onQuoteNotLoaded?.();
  };

  // Arrow keys move between messages once one is focused; the list itself is a tab stop.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = scroller.current;
    if (!el || (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "End" && e.key !== "Home")) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-msg-id][tabindex]"));
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.target !== el && i < 0) return;
    e.preventDefault();
    let next = i;
    if (e.key === "ArrowUp") next = i < 0 ? items.length - 1 : Math.max(0, i - 1);
    else if (e.key === "ArrowDown") next = i < 0 ? items.length - 1 : Math.min(items.length - 1, i + 1);
    else if (e.key === "Home") next = 0;
    else next = items.length - 1;
    items[next]?.focus();
    items[next]?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="ck-messages-wrap">
      <div ref={scroller} className="ck-messages" role="log" aria-label={`Messages with ${peerName}`} aria-relevant="additions" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
        {loading && messages.length === 0 ? (
          <div className="ck-bubble-skeletons" aria-hidden="true">
            {[60, 40, 70, 35, 55].map((w, i) => (
              <div key={i} className={cx("ck-skeleton ck-skeleton-bubble", i % 2 ? "is-mine" : "")} style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : null}
        {!loading && messages.length === 0 ? (
          <div className="ck-empty ck-chat-empty" role="status">
            <p className="ck-empty-title">{props.emptyText ?? "Say hi 👋"}</p>
          </div>
        ) : null}
        {loadingMore ? (
          <div className="ck-loading-more" role="status">
            Loading earlier messages…
          </div>
        ) : null}
        {chron.map(({ r, i }) =>
          r.kind === "date" ? (
            <div key={r.key} className="ck-date-sep" data-index={i}>
              <span className="ck-date-chip">{r.label}</span>
            </div>
          ) : (
            <MessageBubble
              key={r.key}
              index={i}
              message={r.message}
              groupStart={r.groupStart}
              groupEnd={r.groupEnd}
              peerId={peerId}
              peerName={peerName}
              myId={myId}
              baseUrl={baseUrl}
              highlighted={highlightId != null && String(highlightId) === String(r.message.id)}
              clock={clock}
              swipeToReply={swipeToReply}
              onMenu={props.onMenu}
              onReply={props.onReply}
              onOpenImage={props.onOpenImage}
              onOpenFile={props.onOpenFile}
              onJumpToQuote={onQuote}
              onRetry={props.onRetry}
              onCallBack={props.onCallBack}
            />
          ),
        )}
        {typing ? (
          <div className="ck-msg-row is-theirs ck-typing-row" role="status" aria-label={`${peerName} is typing`}>
            <div className="ck-bubble ck-in ck-typing">
              <span className="ck-dot" />
              <span className="ck-dot" />
              <span className="ck-dot" />
            </div>
          </div>
        ) : null}
      </div>
      <div className={cx("ck-sticky-date", stickyVisible && stickyLabel && "is-visible")} aria-hidden="true">
        {stickyLabel}
      </div>
      {!atBottom ? (
        <button type="button" className="ck-jump" onClick={() => scrollToBottom(true)} aria-label={newCount ? `Jump to latest, ${newCount} new ${newCount === 1 ? "message" : "messages"}` : "Jump to latest"}>
          <Icon name="chevronDown" size={20} />
          {newCount ? <span className="ck-jump-count">{newCount > 99 ? "99+" : newCount}</span> : null}
        </button>
      ) : null}
    </div>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const Linkified = slot("Linkified", DefaultLinkified);
export const MessageBubble = slot("MessageBubble", DefaultMessageBubble);
export const MessageList = slot("MessageList", DefaultMessageList);
