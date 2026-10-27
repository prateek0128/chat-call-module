import React, { useCallback, useEffect, useState } from "react";
import { decideLayout, MAX_CONTENT_WIDTH, type Conversation } from "commskit/engine";
import { ChatScreen, type ChatScreenProps } from "./ChatScreen";
import { ConversationListScreen, type ConversationListScreenProps } from "./ConversationListScreen";
import { useElementWidth } from "./hooks";
import { InAppMessageBanners, useWebNotifications, type UseWebNotificationsOptions } from "./notifications";
import { Icon } from "./ui";
import { cx } from "./util";

export interface ChatAppProps {
  /** Controlled selection. Omit for internal state. */
  selectedPeerId?: string | null;
  defaultPeerId?: string | null;
  onSelectedChange?: (peerId: string | null) => void;
  /** Props forwarded to every ChatScreen (`peerId`, `onBack` are managed here). */
  chat?: Omit<ChatScreenProps, "peerId" | "onBack">;
  list?: Omit<ConversationListScreenProps, "onSelect" | "selectedPeerId">;
  /** Desktop notifications + the bell button. `false` disables both. */
  notifications?: boolean | Omit<UseWebNotificationsOptions, "onOpenChat">;
  /** In-app banners for messages from other chats (default true). */
  banners?: boolean;
  /** Shown in the chat pane when nothing is selected (split layout). */
  placeholder?: React.ReactNode;
  className?: string;
}

/**
 * Ready-made responsive layout: phone = one pane with a back button, 700 px and up = list + chat side by side.
 * Fills its parent (give the parent a height, e.g. `100dvh`).
 */
export const ChatApp: React.FC<ChatAppProps> = ({ selectedPeerId, defaultPeerId = null, onSelectedChange, chat, list, notifications = true, banners = true, placeholder, className }) => {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const layout = decideLayout(width);
  const [own, setOwn] = useState<string | null>(defaultPeerId);
  const selected = selectedPeerId !== undefined ? selectedPeerId : own;
  const select = useCallback(
    (id: string | null) => {
      setOwn(id);
      onSelectedChange?.(id);
    },
    [onSelectedChange],
  );
  const notifOpts = typeof notifications === "object" ? notifications : {};
  const notif = useWebNotifications({ ...notifOpts, enabled: notifications !== false, onOpenChat: (id) => select(id) });

  // Esc in the single-pane chat goes back to the list (dialogs/menus handle Esc first and stop it).
  useEffect(() => {
    if (layout.mode !== "single" || !selected) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) select(null);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [layout.mode, selected, select]);

  const bell =
    notifications !== false && notif.supported && notif.permission === "default" ? (
      <button type="button" className="ck-icon-btn" aria-label="Enable desktop notifications" title="Enable desktop notifications" onClick={() => void notif.requestPermission()}>
        <Icon name="bell" />
      </button>
    ) : null;

  const listPane = (
    <div className="ck-pane ck-pane-list" style={layout.mode === "split" ? { width: layout.listWidth } : undefined}>
      <ConversationListScreen
        {...list}
        headerActions={
          <>
            {list?.headerActions}
            {bell}
          </>
        }
        selectedPeerId={selected}
        onSelect={(id: string, _c: Conversation) => select(id)}
      />
    </div>
  );
  const chatPane = (
    <div className="ck-pane ck-pane-chat">
      {selected ? (
        <ChatScreen key={selected} {...chat} showConnectionBanner={layout.mode === "split" ? false : chat?.showConnectionBanner ?? true} peerId={selected} onBack={layout.mode === "single" ? () => select(null) : undefined} />
      ) : (
        <div className="ck-empty ck-no-chat">{placeholder ?? (<><Icon name="message" size={44} /><p className="ck-empty-title">Select a chat</p><p className="ck-empty-text">Pick a conversation to start messaging.</p></>)}</div>
      )}
    </div>
  );

  return (
    <div ref={ref} className={cx("ck-app", className)} data-layout={layout.mode} style={{ maxWidth: MAX_CONTENT_WIDTH }}>
      {layout.mode === "split" ? (
        <>
          {listPane}
          {chatPane}
        </>
      ) : selected ? (
        chatPane
      ) : (
        listPane
      )}
      {banners ? <InAppMessageBanners onOpenChat={(id) => select(id)} /> : null}
    </div>
  );
};
