/** Chat-UI hooks over the existing chat/core hooks (no engine changes). */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useComms, useConnectionStatus } from "../core";
import { useChatContext } from "../chat";
import type { ChatMessage } from "../chat/types";
import { connectionBannerModel, type ConnectionBannerModel } from "./connection";
import { BANNER_AUTO_HIDE_MS, bannerText, primeSeen, scanForBanners, SeenSet } from "./inAppBanner";
import { createMessageSoundPlayer, shouldPlayMessageSound, type SoundSource } from "./messageSound";
import { sharedTicker } from "./ticker";

const NO_TYPING: Record<string, boolean> = {};

/** Peer id -> typing, for every conversation (the list shows "typing…" per row). */
export const useTypingMap = (): Record<string, boolean> => {
  const { store } = useChatContext();
  const get = () => store.getSnapshot().typing || NO_TYPING;
  return useSyncExternalStore(store.subscribe, get, get);
};

/** Re-renders every `intervalMs` while `enabled` (countdowns, "Today" rollover). */
export const useTicker = (enabled: boolean, intervalMs = 1000): number => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return tick;
};

/**
 * Re-renders on a ticker SHARED by every caller with the same period (default 60 s: one interval
 * for every "last seen 5 min ago" label on screen). Returns the tick count.
 */
export const useSharedTicker = (intervalMs = 60000, enabled = true): number => {
  const ticker = sharedTicker(intervalMs);
  const subscribe = useCallback((cb: () => void) => (enabled ? ticker.subscribe(cb) : () => undefined), [ticker, enabled]);
  return useSyncExternalStore(subscribe, ticker.getTick, ticker.getTick);
};

export interface UseMessageSoundOptions {
  /** `require("./assets/message.mp3")`, `{ uri }` or a URL. Null / undefined = silent. */
  source?: SoundSource | null;
  /** Default true. */
  enabled?: boolean;
  /** Host mute setting (e.g. from your notification preferences). */
  muted?: boolean;
  /** Chat on screen (no sound for it). Default: the store's active chat. */
  activePeerId?: string | null;
}

/**
 * Plays `source` for new incoming messages in chats other than the open one while the app is in the
 * foreground (same rules as the in-app banner: no history, my own messages or call entries).
 * expo-audio if installed, else expo-av, else silent. Needs <ChatProvider>.
 */
export const useMessageSound = (options: UseMessageSoundOptions = {}): void => {
  const { store } = useChatContext();
  const optsRef = useRef(options);
  optsRef.current = options;
  const appActive = useRef(AppState.currentState === "active" || AppState.currentState === "unknown" || !AppState.currentState);
  const source = options.source ?? null;
  const sourceKey = typeof source === "object" && source ? source.uri : source;

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      appActive.current = s === "active";
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (source == null) return;
    const player = createMessageSoundPlayer(source);
    if (player.backend === "none") return;
    const seen = new SeenSet();
    primeSeen(store.getSnapshot(), seen);
    const unsubscribe = store.subscribe(() => {
      const o = optsRef.current;
      const found = scanForBanners(store.getSnapshot(), seen, { activePeerId: o.activePeerId, appActive: appActive.current, enabled: o.enabled !== false });
      if (found.length && shouldPlayMessageSound({ enabled: o.enabled, muted: o.muted, appActive: appActive.current })) player.play();
    });
    return () => {
      unsubscribe();
      player.release();
    };
    // the source identity is its key (require id / uri)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sourceKey]);
};

/** Banner model for the shared socket + a `retry()` that reconnects now. */
export const useConnectionBanner = (): ConnectionBannerModel & { retry: () => void } => {
  const info = useConnectionStatus();
  const { client } = useComms();
  const sinceRef = useRef<{ info: typeof info; at: number }>({ info, at: Date.now() });
  if (sinceRef.current.info !== info) sinceRef.current = { info, at: Date.now() };
  const counting = info.status === "reconnecting";
  useTicker(counting, 1000);
  const model = connectionBannerModel(info, Date.now() - sinceRef.current.at);
  return { ...model, retry: () => void client.reconnect() };
};

export interface InAppBannerItem {
  /** Dedupe key (`peerId:messageId`). */
  key: string;
  peerId: string;
  chatId: ChatMessage["chat_id"];
  name: string;
  avatar: string | null;
  /** Message text or attachment label. */
  text: string;
  message: ChatMessage;
}

export interface UseInAppBannerOptions {
  /** Chat on screen (no banners for it). Default: the store's active chat (set by an open ChatScreen). */
  activePeerId?: string | null;
  /** Default true. */
  enabled?: boolean;
  /** Auto-hide after this many ms (default 4000; 0 = stay until dismissed). */
  autoHideMs?: number;
  /** Ignore messages older than this (history catch-up). Default 2 min. */
  maxAgeMs?: number;
}

/**
 * Latest new incoming message from a chat other than the open one, for an in-app banner.
 * Listens to the chat store (`new_message`), dedupes per message, ignores history, my own
 * messages and call entries, and is suppressed while that chat is open or the app is in the
 * background. Needs <ChatProvider>.
 */
export const useInAppBanner = (options: UseInAppBannerOptions = {}): { banner: InAppBannerItem | null; dismiss: () => void } => {
  const { store } = useChatContext();
  const { users } = useComms();
  const [banner, setBanner] = useState<InAppBannerItem | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;
  const appActive = useRef(AppState.currentState === "active" || AppState.currentState === "unknown" || !AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      appActive.current = s === "active";
      if (s !== "active") setBanner(null);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const seen = new SeenSet();
    primeSeen(store.getSnapshot(), seen);
    const check = () => {
      const o = optsRef.current;
      const state = store.getSnapshot();
      const found = scanForBanners(state, seen, { activePeerId: o.activePeerId, appActive: appActive.current, enabled: o.enabled !== false, maxAgeMs: o.maxAgeMs });
      const c = found[found.length - 1];
      if (!c) return;
      const conv = state.conversations.find((x) => String(x.user_id) === c.peerId);
      const info = state.threads[c.peerId]?.info;
      const profile = users.get(c.peerId);
      setBanner({
        key: c.key,
        peerId: c.peerId,
        chatId: c.message.chat_id ?? conv?.chat_id ?? null,
        name: conv?.username || info?.username || profile?.name || "New message",
        avatar: conv?.avatar || info?.avatar || profile?.avatar || null,
        text: bannerText(c.message),
        message: c.message,
      });
    };
    return store.subscribe(check);
  }, [store, users]);

  // Hide when its chat opens or banners are turned off.
  const storeActive = useSyncExternalStore(store.subscribe, () => store.getSnapshot().activePeerId, () => store.getSnapshot().activePeerId);
  const active = options.activePeerId !== undefined ? options.activePeerId : storeActive;
  const enabled = options.enabled !== false;
  useEffect(() => {
    if (banner && (!enabled || (active != null && String(active) === banner.peerId))) setBanner(null);
  }, [active, banner, enabled]);

  const autoHideMs = options.autoHideMs ?? BANNER_AUTO_HIDE_MS;
  useEffect(() => {
    if (!banner || autoHideMs <= 0) return;
    const key = banner.key;
    const t = setTimeout(() => setBanner((b) => (b && b.key === key ? null : b)), autoHideMs);
    return () => clearTimeout(t);
  }, [banner, autoHideMs]);

  const dismiss = useCallback(() => setBanner(null), []);
  return { banner, dismiss };
};
