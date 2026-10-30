/** Shared UI primitives: Icon, Avatar, Dialog (focus trap), PopupMenu, toasts, connection banner. */
import { slot } from "./components";
import React, { CSSProperties, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { avatarColor, connectionBannerModel, initialsOf } from "commskit/engine";
import { useTheme } from "./appearance";
import { useConnectionStatus } from "./providers";
import { useComms } from "./providers";
import { cx } from "./util";
import type { ToastItem } from "./hooks";

// ---- Icon --------------------------------------------------------------------------------------------

const ICON_PATHS = {
  back: "M15 18l-6-6 6-6",
  more: "M12 5v.01M12 12v.01M12 19v.01",
  attach: "M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  close: "M18 6L6 18M6 6l12 12",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  call: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0122 16.92z",
  check: "M20 6L9 17l-5-5",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  share: "M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13",
  retry: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15",
  palette: "M12 2a10 10 0 100 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4a4.6 4.6 0 004.6-4.6C22 5.9 17.5 2 12 2zM7.5 12h.01M10 7.5h.01M15 7.5h.01",
  camera: "M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z",
  image: "M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21",
  video: "M23 7l-7 5 7 5V7zM3 5h11a2 2 0 012 2v10a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2z",
  document: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  ban: "M12 22a10 10 0 100-20 10 10 0 000 20zM4.93 4.93l14.14 14.14",
  trash: "M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6",
  chevronDown: "M6 9l6 6 6-6",
  callIncoming: "M17 7L7 17M17 17H7V7",
  callOutgoing: "M7 17L17 7M7 7h10v10",
  callMissed: "M17 7L7 17M17 17H7V7",
  reply: "M9 17l-5-5 5-5M4 12h11a5 5 0 015 5v2",
  copy: "M9 9h11v11H9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1",
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
  smile: "M12 22a10 10 0 100-20 10 10 0 000 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  message: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
  bell: "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0",
  external: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3",
} as const;

export type WebIconName = keyof typeof ICON_PATHS;

export const DefaultIcon: React.FC<{ name: WebIconName; size?: number; className?: string; strokeWidth?: number }> = ({ name, size = 20, className, strokeWidth }) => (
  <svg
    className={cx("ck-icon", className)}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth ?? (name === "more" ? 3 : 2)}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={ICON_PATHS[name]} />
  </svg>
);

// ---- Avatar --------------------------------------------------------------------------------------------

type AvatarProps = { name?: string | null; id?: string | null; src?: string | null; size?: number; online?: boolean; className?: string };

/** The built-in avatar (a host replacement may render this). */
export const DefaultAvatar: React.FC<AvatarProps> = ({
  name,
  id,
  src,
  size = 48,
  online,
  className,
}) => {
  const theme = useTheme();
  const [broken, setBroken] = useState(false);
  const bg = avatarColor(id || name || "", theme.avatarPalette);
  const style: CSSProperties = { width: size, height: size, background: bg, fontSize: Math.round(size * 0.38) };
  return (
    <span className={cx("ck-avatar", className)} style={style} data-online={online ? "true" : undefined}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <span aria-hidden="true">{initialsOf(name)}</span>}
      {online ? <span className="ck-presence-dot" aria-hidden="true" /> : null}
    </span>
  );
};

// ---- Dialog (modal) --------------------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const DefaultDialog: React.FC<{
  label: string;
  onClose: () => void;
  children?: ReactNode;
  variant?: "sheet" | "center" | "full";
  className?: string;
  /** Close when the backdrop is clicked (default true). */
  dismissOnBackdrop?: boolean;
}> = ({ label, onClose, children, variant = "sheet", className, dismissOnBackdrop = true }) => {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current;
    if (el) {
      const first = el.querySelector<HTMLElement>("[data-autofocus]") || el.querySelector<HTMLElement>(FOCUSABLE);
      (first || el).focus();
    }
    return () => {
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.hasAttribute("hidden") && n.getAttribute("aria-hidden") !== "true");
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="ck-backdrop" data-variant={variant} onMouseDown={(e) => dismissOnBackdrop && e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={cx("ck-dialog", className)} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
};

export const DefaultConfirmDialog: React.FC<{
  title: string;
  text?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ title, text, confirmLabel, destructive, onConfirm, onCancel }) => (
  <Dialog label={title} onClose={onCancel} variant="center">
    <div className="ck-dialog-body">
      <h2 className="ck-dialog-title">{title}</h2>
      {text ? <p className="ck-dialog-text">{text}</p> : null}
    </div>
    <div className="ck-dialog-actions">
      <button type="button" className="ck-btn" onClick={onCancel} data-autofocus>
        Cancel
      </button>
      <button type="button" className={cx("ck-btn", destructive ? "ck-btn-danger" : "ck-btn-primary")} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  </Dialog>
);

// ---- PopupMenu -----------------------------------------------------------------------------------------------

export interface MenuItem {
  key: string;
  label: string;
  icon?: WebIconName;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export const DefaultPopupMenu: React.FC<{
  items: MenuItem[];
  /** Viewport coordinates to open at (a click point or the bottom-left of a button). */
  anchor: { x: number; y: number; align?: "left" | "right"; above?: boolean };
  onClose: () => void;
  label?: string;
}> = ({ items, anchor, onClose, label = "Menu" }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.align === "right" ? anchor.x - r.width : anchor.x;
    let top = anchor.above ? anchor.y - r.height : anchor.y;
    if (left + r.width > vw - 8) left = vw - r.width - 8;
    if (left < 8) left = 8;
    if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
    setPos({ left, top });
  }, [anchor.x, anchor.y, anchor.align, anchor.above]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const down = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const blur = () => closeRef.current();
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') || []);
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nodes[(i + 1) % nodes.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nodes[(i - 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      nodes[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      nodes[nodes.length - 1]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div ref={ref} className="ck-menu" role="menu" aria-label={label} style={{ left: pos.left, top: pos.top }} onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className={cx("ck-menu-item", it.destructive && "is-destructive")}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.icon ? <Icon name={it.icon} size={18} /> : null}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
};

// ---- toasts, live region, connection banner ------------------------------------------------------------------

export const DefaultToastStack: React.FC<{ toasts: ToastItem[]; onDismiss: (id: number) => void }> = ({ toasts, onDismiss }) => (
  <div className="ck-toasts" role="status" aria-live="polite">
    {toasts.map((t) => (
      <div key={t.id} className="ck-toast" data-tone={t.tone || "info"}>
        <span>{t.text}</span>
        {t.action ? (
          <button type="button" className="ck-toast-action" onClick={t.action.onClick}>
            {t.action.label}
          </button>
        ) : null}
        <button type="button" className="ck-icon-btn ck-toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
    ))}
  </div>
);

export const DefaultLiveRegion: React.FC<{ text: string }> = ({ text }) => (
  <div className="ck-sr-only" role="status" aria-live="polite" aria-atomic="true">
    {text}
  </div>
);

/** "Connecting…" / "Offline. Retrying in Ns" + Retry (hidden while connected). */
export const DefaultConnectionBanner: React.FC = () => {
  const info = useConnectionStatus();
  const { client } = useComms();
  const since = useRef(Date.now());
  const [, setNow] = useState(0);
  useEffect(() => {
    since.current = Date.now();
    setNow((n) => n + 1);
  }, [info.status, info.attempt]);
  const model = connectionBannerModel(info, Date.now() - since.current);
  useEffect(() => {
    if (!model.visible) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [model.visible]);
  if (!model.visible) return null;
  return (
    <div className="ck-connection" data-tone={model.tone} role="status" aria-live="polite">
      <span>{model.text}</span>
      {model.showRetry ? (
        <button type="button" className="ck-link-btn" onClick={() => void client.reconnect()}>
          Retry
        </button>
      ) : null}
    </div>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const Icon = slot("Icon", DefaultIcon);
export const Dialog = slot("Dialog", DefaultDialog);
export const ConfirmDialog = slot("ConfirmDialog", DefaultConfirmDialog);
export const PopupMenu = slot("PopupMenu", DefaultPopupMenu);
export const ToastStack = slot("ToastStack", DefaultToastStack);
export const LiveRegion = slot("LiveRegion", DefaultLiveRegion);
export const ConnectionBanner = slot("ConnectionBanner", DefaultConnectionBanner);
export const Avatar = slot("Avatar", DefaultAvatar);
