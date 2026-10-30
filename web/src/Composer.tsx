import { slot } from "./components";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { blockedComposerText, canSendText, layout, rateLimitText, type BlockedComposerKind } from "commskit/engine";
import { PopupMenu, Icon } from "./ui";
import { cx } from "./util";

/** Typing events are sent at most this often while the user types, and stopped after this idle time. */
export const TYPING_THROTTLE_MS = 3000;
export const TYPING_IDLE_MS = 2500;

export interface ComposerProps {
  onSend: (text: string) => boolean | void;
  /** Files from the attach menu, drag-and-drop or paste. Omit to hide the attach button. */
  onAttach?: (files: File[]) => void;
  onTyping?: (isTyping: boolean) => void;
  /** Reply bar content. */
  replyTo?: { sender: string; snippet: string } | null;
  onCancelReply?: () => void;
  /** Disabled with a reason ("Chat is not enabled"). */
  disabledReason?: string | null;
  /** Blocked state: "You blocked Bob. Unblock" / "You can't reply to this conversation". */
  blocked?: { kind: BlockedComposerKind; name?: string | null; onUnblock?: () => void } | null;
  /** Epoch ms until which the server rate-limits sends. */
  rateLimitedUntil?: number | null;
  placeholder?: string;
  maxLength?: number;
  /** Focus the field on mount / when this key changes (e.g. peer id). */
  focusKey?: string;
  className?: string;
}

const isApplePlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

export const DefaultComposer: React.FC<ComposerProps> = ({
  onSend,
  onAttach,
  onTyping,
  replyTo,
  onCancelReply,
  disabledReason,
  blocked,
  rateLimitedUntil,
  placeholder = "Message",
  maxLength = 4000,
  focusKey,
  className,
}) => {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; above?: boolean } | null>(null);
  const [emojiNote, setEmojiNote] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const area = useRef<HTMLTextAreaElement>(null);
  const attachBtn = useRef<HTMLButtonElement>(null);
  const inputs = { gallery: useRef<HTMLInputElement>(null), camera: useRef<HTMLInputElement>(null), video: useRef<HTMLInputElement>(null), document: useRef<HTMLInputElement>(null) };
  const typingState = useRef({ sent: false, lastSent: 0, idle: null as ReturnType<typeof setTimeout> | null });
  const typingRef = useRef(onTyping);
  typingRef.current = onTyping;

  const stopTyping = useCallback(() => {
    const t = typingState.current;
    if (t.idle) clearTimeout(t.idle);
    t.idle = null;
    if (t.sent) {
      t.sent = false;
      typingRef.current?.(false);
    }
  }, []);
  useEffect(() => () => stopTyping(), [stopTyping, focusKey]);

  const limited = rateLimitedUntil != null && rateLimitedUntil > now;
  useEffect(() => {
    if (rateLimitedUntil == null || rateLimitedUntil <= Date.now()) return;
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= rateLimitedUntil) clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  }, [rateLimitedUntil]);

  // auto-grow: 1 .. composerMaxLines lines
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const max = line * layout.composerMaxLines + pad;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    if (focusKey !== undefined && !disabledReason && !blocked) area.current?.focus({ preventScroll: true });
  }, [focusKey, disabledReason, blocked]);

  const submit = () => {
    if (!canSendText(text) || limited) return;
    const ok = onSend(text.trim());
    if (ok !== false) {
      setText("");
      stopTyping();
    }
    area.current?.focus({ preventScroll: true });
  };

  const onChange = (value: string) => {
    setText(value);
    const t = typingState.current;
    if (!value.trim()) {
      stopTyping();
      return;
    }
    const nowMs = Date.now();
    if (!t.sent || nowMs - t.lastSent >= TYPING_THROTTLE_MS) {
      t.sent = true;
      t.lastSent = nowMs;
      typingRef.current?.(true);
    }
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const pick = (files: FileList | null) => {
    if (files && files.length) onAttach?.(Array.from(files));
  };

  if (blocked) {
    return (
      <div className={cx("ck-composer ck-composer-disabled", className)} role="status">
        <span className="ck-composer-note">{blockedComposerText(blocked.kind, blocked.name)}</span>
        {blocked.kind === "blocked" && blocked.onUnblock ? (
          <button type="button" className="ck-btn" onClick={blocked.onUnblock} aria-label={`Unblock ${blocked.name || "this contact"}`}>
            Unblock
          </button>
        ) : null}
      </div>
    );
  }
  if (disabledReason) {
    return (
      <div className={cx("ck-composer ck-composer-disabled", className)} role="status">
        <span className="ck-composer-note">{disabledReason}</span>
      </div>
    );
  }

  return (
    <div className={cx("ck-composer", className)}>
      {replyTo ? (
        <div className="ck-reply-bar">
          <div className="ck-reply-text">
            <span className="ck-quote-sender">Replying to {replyTo.sender}</span>
            <span className="ck-quote-text">{replyTo.snippet}</span>
          </div>
          <button type="button" className="ck-icon-btn" aria-label="Cancel reply" onClick={onCancelReply}>
            <Icon name="close" size={18} />
          </button>
        </div>
      ) : null}
      {limited ? (
        <div className="ck-rate-note" role="status">
          {rateLimitText(Math.ceil(((rateLimitedUntil as number) - now) / 1000))}
        </div>
      ) : null}
      {emojiNote ? (
        <div className="ck-emoji-note" role="status">
          Use your system emoji picker: {isApplePlatform() ? "Ctrl + Cmd + Space" : "Windows key + . (period)"}
        </div>
      ) : null}
      <div className="ck-composer-row">
        {onAttach ? (
          <>
            <button
              ref={attachBtn}
              type="button"
              className="ck-icon-btn"
              aria-label="Attach file"
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={() => {
                const r = attachBtn.current?.getBoundingClientRect();
                setMenu(r ? { x: r.left, y: r.top - 6, above: true } : { x: 8, y: 100, above: true });
              }}
            >
              <Icon name="attach" />
            </button>
            <input ref={inputs.gallery} type="file" accept="image/*" multiple hidden data-testid="file-gallery" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
            <input ref={inputs.camera} type="file" accept="image/*" capture="environment" hidden data-testid="file-camera" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
            <input ref={inputs.video} type="file" accept="video/*" hidden data-testid="file-video" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
            <input ref={inputs.document} type="file" hidden data-testid="file-document" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
          </>
        ) : null}
        <textarea
          ref={area}
          className="ck-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          maxLength={maxLength}
          enterKeyHint="send"
          onChange={(e) => onChange(e.target.value)}
          onBlur={stopTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && replyTo) {
              e.stopPropagation();
              onCancelReply?.();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length && onAttach) {
              e.preventDefault();
              onAttach(files);
            }
          }}
        />
        <button
          type="button"
          className="ck-icon-btn ck-emoji-btn"
          aria-label="Emoji"
          onClick={() => {
            setEmojiNote((v) => !v);
            area.current?.focus();
          }}
        >
          <Icon name="smile" />
        </button>
        <button type="button" className="ck-send" aria-label="Send message" disabled={!canSendText(text) || limited} onClick={submit}>
          <Icon name="send" size={20} />
        </button>
      </div>
      {menu ? (
        <PopupMenu
          label="Attach"
          anchor={menu}
          onClose={() => {
            setMenu(null);
            attachBtn.current?.focus();
          }}
          items={[
            { key: "gallery", label: "Gallery", icon: "image", onSelect: () => inputs.gallery.current?.click() },
            { key: "camera", label: "Camera", icon: "camera", onSelect: () => inputs.camera.current?.click() },
            { key: "video", label: "Video", icon: "video", onSelect: () => inputs.video.current?.click() },
            { key: "document", label: "Document", icon: "document", onSelect: () => inputs.document.current?.click() },
          ]}
        />
      ) : null}
    </div>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const Composer = slot("Composer", DefaultComposer);
