/** Desktop notifications (Notification API) and in-app banners for messages from other chats. */
import { slot } from "./components";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { BANNER_AUTO_HIDE_MS, bannerText, primeSeen, scanForBanners, SeenSet, type ChatMessage } from "commskit/engine";
import { useChatContext, useConversations, useUserProfile } from "./providers";
import { useTabVisible } from "./hooks";
import { Avatar } from "./ui";

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

const currentPermission = (): NotificationPermissionState => {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotificationPermissionState;
};

export interface UseWebNotificationsOptions {
  /** Master switch (default true). The hook never asks for permission by itself: call `requestPermission()` from a click. */
  enabled?: boolean;
  /** Opens the chat when the notification is clicked (after focusing the tab). */
  onOpenChat?: (peerId: string) => void;
  /** Optional sound (URL) played for each notification, through an HTMLAudioElement. */
  soundUrl?: string;
  /** Notification icon (e.g. your logo). */
  icon?: string;
  /** Replace `new Notification(...)` (tests, service-worker notifications). */
  createNotification?: (title: string, options: NotificationOptions & { onClick: () => void }) => void;
  /** Also notify for the chat that is open (it is never "open" while the tab is hidden, so this is only for hosts that keep `active`). Default false. */
  includeOpenChat?: boolean;
}

export interface WebNotificationsApi {
  supported: boolean;
  permission: NotificationPermissionState;
  requestPermission: () => Promise<NotificationPermissionState>;
}

/**
 * Desktop notification for each new message from a chat that is not open while the tab is hidden.
 * Clicking it focuses the tab and opens the chat (`onOpenChat`).
 */
export const useWebNotifications = (options: UseWebNotificationsOptions = {}): WebNotificationsApi => {
  const { store } = useChatContext();
  const [permission, setPermission] = useState<NotificationPermissionState>(currentPermission);
  const opts = useRef(options);
  opts.current = options;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const seen = new SeenSet();
    primeSeen(store.getSnapshot(), seen);
    const audio = { el: null as HTMLAudioElement | null, url: "" };
    const onChange = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // Always scan so messages already shown elsewhere (in-app banner) are marked seen.
      const state = store.getSnapshot();
      const found = scanForBanners(state, seen, { appActive: true, activePeerId: opts.current.includeOpenChat ? null : state.activePeerId });
      if (!hidden || !found.length || currentPermission() !== "granted") return;
      for (const f of found) {
        const conversation = store.getConversation(f.peerId);
        const title = conversation?.username || `User ${f.peerId}`;
        const body = bannerText(f.message);
        const open = () => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
          opts.current.onOpenChat?.(f.peerId);
        };
        try {
          if (opts.current.createNotification) opts.current.createNotification(title, { body, tag: `ck-${f.peerId}`, icon: opts.current.icon, onClick: open });
          else {
            const n = new Notification(title, { body, tag: `ck-${f.peerId}`, icon: opts.current.icon });
            n.onclick = () => {
              open();
              n.close();
            };
          }
        } catch {
          /* some browsers throw outside a secure context */
        }
        const url = opts.current.soundUrl;
        if (url) {
          try {
            if (!audio.el || audio.url !== url) {
              audio.el = new Audio(url);
              audio.url = url;
            }
            void audio.el.play().catch(() => {});
          } catch {
            /* autoplay policy */
          }
        }
      }
    };
    return store.subscribe(onChange);
  }, [store, enabled]);

  const requestPermission = useCallback(async (): Promise<NotificationPermissionState> => {
    if (currentPermission() === "unsupported") return "unsupported";
    try {
      const p = (await Notification.requestPermission()) as NotificationPermissionState;
      setPermission(p);
      return p;
    } catch {
      setPermission(currentPermission());
      return currentPermission();
    }
  }, []);

  return { supported: permission !== "unsupported", permission, requestPermission };
};

// ---- in-app banners ---------------------------------------------------------------------------------------------

interface BannerItem {
  key: string;
  peerId: string;
  text: string;
}

/** One banner; the sender's name / avatar resolve live (the conversation list may arrive after the first message). */
const BannerButton: React.FC<{ item: BannerItem; onOpen: () => void }> = ({ item, onOpen }) => {
  const { conversations } = useConversations();
  const profile = useUserProfile(item.peerId);
  const c = conversations.find((x) => x.user_id === item.peerId);
  const name = c?.username || profile?.name || `User ${item.peerId}`;
  return (
    <button type="button" className="ck-banner" onClick={onOpen} aria-label={`New message from ${name}: ${item.text}. Open chat`}>
      <Avatar name={name} id={item.peerId} src={c?.avatar || profile?.avatar} size={36} />
      <span className="ck-banner-text">
        <span className="ck-banner-name">{name}</span>
        <span className="ck-banner-body">{item.text}</span>
      </span>
    </button>
  );
};

/** Toast-style banner for a new message in a chat that is not open (tab visible). Click opens the chat. */
export const DefaultInAppMessageBanners: React.FC<{ onOpenChat: (peerId: string) => void; enabled?: boolean }> = ({ onOpenChat, enabled = true }) => {
  const { store } = useChatContext();
  const visible = useTabVisible();
  const [items, setItems] = useState<BannerItem[]>([]);
  const seen = useRef<SeenSet | null>(null);
  if (!seen.current) {
    seen.current = new SeenSet();
    primeSeen(store.getSnapshot(), seen.current);
  }
  useEffect(() => {
    return store.subscribe(() => {
      const state = store.getSnapshot();
      const found = scanForBanners(state, seen.current as SeenSet, { appActive: visible, enabled });
      if (!found.length) return;
      const next: BannerItem[] = found.map((f: { key: string; peerId: string; message: ChatMessage }) => ({ key: f.key, peerId: f.peerId, text: bannerText(f.message) }));
      setItems((cur) => [...cur.filter((i) => !next.some((n) => n.peerId === i.peerId)), ...next].slice(-3));
      for (const n of next) setTimeout(() => setItems((cur) => cur.filter((i) => i.key !== n.key)), BANNER_AUTO_HIDE_MS);
    });
  }, [store, visible, enabled]);
  if (!items.length) return null;
  return (
    <div className="ck-banners" role="status" aria-live="polite">
      {items.map((b) => (
        <BannerButton
          key={b.key}
          item={b}
          onOpen={() => {
            setItems((cur) => cur.filter((i) => i.key !== b.key));
            onOpenChat(b.peerId);
          }}
        />
      ))}
    </div>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const InAppMessageBanners = slot("InAppMessageBanners", DefaultInAppMessageBanners);
