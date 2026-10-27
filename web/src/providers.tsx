/**
 * Providers and hooks: CommsWebProvider (socket + user directory), ChatProvider (+ chat hooks) and
 * ModerationProvider (+ useBlocking). Thin React bindings over the shared framework-free engine.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  CHAT_EVENT_TYPES,
  ChatStore,
  CommsClient,
  ModerationStore,
  UserDirectory,
  registerPushToken,
  removePushToken,
  startChat,
  type AppStateLike,
  type ApiConfig,
  type BlockedUser,
  type ChatError,
  type ChatId,
  type ChatMessage,
  type ChatState,
  type CommsClientOptions,
  type CommsConfig,
  type Conversation,
  type ConversationThread,
  type MediaFile,
  type PushTokenPayload,
  type ReadFileAsBase64,
  type ReportInput,
  type StatusInfo,
  type UserId,
  type UserProfile,
} from "commskit/engine";
import { readUrlAsBase64 } from "./util";

// ---- browser "app state": tab visibility -> active / background -----------------------------------

/** AppState-like adapter over `document.visibilitychange` (drives user_status online / away). */
export const createBrowserAppState = (): AppStateLike => {
  const current = () => (typeof document !== "undefined" && document.visibilityState === "hidden" ? "background" : "active");
  return {
    get currentState() {
      return current();
    },
    addEventListener(_type, listener) {
      const onChange = () => listener(current());
      document.addEventListener("visibilitychange", onChange);
      return { remove: () => document.removeEventListener("visibilitychange", onChange) };
    },
  };
};

// ---- CommsWebProvider ----------------------------------------------------------------------------

export interface CommsWebContextValue {
  client: CommsClient;
  config: CommsConfig;
  users: UserDirectory;
}

const CommsContext = createContext<CommsWebContextValue | null>(null);

export interface CommsWebProviderProps {
  /** `{baseUrl, wsUrl?, getToken, getUserId}`. Callbacks may change identity every render. */
  config: CommsConfig;
  children?: ReactNode;
  /** Bring your own client (tests) or directory (pre-seeded names). */
  client?: CommsClient;
  users?: UserDirectory;
  /** Connect on mount (default true). Set false and call `client.connect()` after login. */
  autoConnect?: boolean;
  offlineSendPolicy?: CommsClientOptions["offlineSendPolicy"];
  pingIntervalMs?: number;
  /** Replace the browser WebSocket (tests, custom subprotocols). */
  createWebSocket?: CommsClientOptions["createWebSocket"];
}

export const CommsWebProvider: React.FC<CommsWebProviderProps> = ({
  config,
  children,
  client: givenClient,
  users: givenUsers,
  autoConnect = true,
  offlineSendPolicy,
  pingIntervalMs,
  createWebSocket,
}) => {
  const configRef = useRef(config);
  configRef.current = config;
  const clientRef = useRef<CommsClient | null>(null);
  if (!clientRef.current) {
    const stable: CommsConfig = {
      get baseUrl() {
        return configRef.current.baseUrl;
      },
      get wsUrl() {
        return configRef.current.wsUrl;
      },
      get logger() {
        return configRef.current.logger;
      },
      getToken: () => configRef.current.getToken(),
      getUserId: () => configRef.current.getUserId(),
    };
    clientRef.current =
      givenClient || new CommsClient({ config: stable, appState: createBrowserAppState(), offlineSendPolicy, pingIntervalMs, createWebSocket });
  }
  const usersRef = useRef<UserDirectory | null>(null);
  if (!usersRef.current) usersRef.current = givenUsers || new UserDirectory();
  const client = clientRef.current;

  useEffect(() => {
    if (autoConnect) void client.connect();
    return () => client.disconnect();
  }, [client, autoConnect]);

  // Coming back online: reconnect now instead of waiting for the backoff timer.
  useEffect(() => {
    const onOnline = () => {
      if (!client.isOpen && client.status.status !== "idle" && client.status.status !== "unauthenticated") void client.reconnect();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [client]);

  const value = useMemo<CommsWebContextValue>(() => ({ client, config: client.config, users: usersRef.current as UserDirectory }), [client]);
  return <CommsContext.Provider value={value}>{children}</CommsContext.Provider>;
};

export const useComms = (): CommsWebContextValue => {
  const ctx = useContext(CommsContext);
  if (!ctx) throw new Error("[comms] useComms() must be used inside <CommsWebProvider>");
  return ctx;
};

/** Live connection status (`open`, `reconnecting`, ...). */
export const useConnectionStatus = (): StatusInfo => {
  const { client } = useComms();
  return useSyncExternalStore(
    (cb) => client.onStatus(cb),
    () => client.status,
    () => client.status,
  );
};

export const useIsConnected = (): boolean => useConnectionStatus().status === "open";

/** Name / avatar from the shared directory; re-renders when it learns the user. */
export const useUserProfile = (userId?: string | null): UserProfile | undefined => {
  const { users } = useComms();
  useSyncExternalStore(users.subscribe, users.getVersion, users.getVersion);
  return users.get(userId);
};

// ---- ChatProvider + hooks ----------------------------------------------------------------------------

interface ChatContextValue {
  store: ChatStore;
  /** Subscribe to the store's user-facing errors (ChatScreen shows them as toasts). */
  subscribeErrors: (listener: (e: ChatError) => void) => () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export interface ChatProviderProps {
  children?: ReactNode;
  /** Reads a picked file (blob: URL) as base64. Default: fetch + FileReader. */
  readFileAsBase64?: ReadFileAsBase64;
  /** Errors to show the user (send failed, file too large, rate limited...). */
  onError?: (error: ChatError) => void;
  pageSize?: number;
  maxUploadBytes?: number;
  autoMarkReadActive?: boolean;
  store?: ChatStore;
}

export const ChatProvider: React.FC<ChatProviderProps> = ({ children, readFileAsBase64, onError, pageSize, maxUploadBytes, autoMarkReadActive, store: givenStore }) => {
  const { client, users } = useComms();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const errorListeners = useRef(new Set<(e: ChatError) => void>());
  const storeRef = useRef<ChatStore | null>(null);
  if (!storeRef.current) {
    storeRef.current =
      givenStore ||
      new ChatStore({
        send: (type, payload) => client.send(type, payload),
        canSend: () => client.canSend(),
        getUserId: () => client.userId,
        users,
        readFileAsBase64: readFileAsBase64 || readUrlAsBase64,
        onError: (e) => {
          onErrorRef.current?.(e);
          errorListeners.current.forEach((l) => l(e));
        },
        pageSize,
        maxUploadBytes,
        autoMarkReadActive,
      });
  }
  const store = storeRef.current;
  useEffect(() => {
    store.setReadFileAsBase64(readFileAsBase64 || readUrlAsBase64);
  }, [store, readFileAsBase64]);
  useEffect(() => {
    const offs = CHAT_EVENT_TYPES.map((type) => client.on(type, (msg) => store.handle(msg)));
    const offStatus = client.onStatus((info) => {
      if (info.status === "open") store.onConnected();
      if (info.status === "unauthenticated") store.reset();
    });
    if (client.isOpen) store.onConnected();
    return () => {
      offs.forEach((off) => off());
      offStatus();
    };
  }, [client, store]);
  const value = useMemo<ChatContextValue>(
    () => ({
      store,
      subscribeErrors: (l) => {
        errorListeners.current.add(l);
        return () => {
          errorListeners.current.delete(l);
        };
      },
    }),
    [store],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChatContext = (): ChatContextValue => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("[comms] chat hooks must be used inside <ChatProvider>");
  return ctx;
};

/** Calls `handler` for every user-facing chat error (send failed, too large, rate limited...). */
export const useChatErrors = (handler: (e: ChatError) => void): void => {
  const { subscribeErrors } = useChatContext();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeErrors((e) => ref.current(e)), [subscribeErrors]);
};

const useChatSelector = <T,>(select: (s: ChatState) => T): T => {
  const { store } = useChatContext();
  const get = () => select(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, get, get);
};

export const useConversations = (): { conversations: Conversation[]; loaded: boolean; refresh: () => boolean } => {
  const { store } = useChatContext();
  const conversations = useChatSelector((s) => s.conversations);
  const loaded = useChatSelector((s) => s.conversationsLoaded);
  const refresh = useCallback(() => store.refreshConversations(), [store]);
  return { conversations, loaded, refresh };
};

export const useUnreadCount = (): number => useChatSelector((s) => s.unreadTotal);

export type ReplyTarget = Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name">;

export interface UseConversationOptions {
  chatId?: ChatId | null;
  markReadOnOpen?: boolean;
  /** Treat the conversation as on screen while mounted (suppresses unread / banners). Default true. */
  active?: boolean;
}

export interface UseConversationResult {
  messages: ChatMessage[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  typing: boolean;
  thread: ConversationThread | undefined;
  conversation: Conversation | undefined;
  send: (text: string, replyTo?: ReplyTarget | null) => boolean;
  sendMedia: (file: MediaFile, replyTo?: ReplyTarget | null) => Promise<boolean>;
  loadMore: () => boolean;
  markRead: () => boolean;
  setTyping: (isTyping: boolean) => boolean;
  refresh: () => boolean;
  deleteMessage: (messageId: ChatMessage["id"], options?: { forEveryone?: boolean }) => boolean;
  clearChat: () => boolean;
  retryMessage: (messageId: ChatMessage["id"]) => boolean | Promise<boolean>;
  rateLimitedUntil: number | null;
}

const NO_MESSAGES: ChatMessage[] = [];

export const useConversation = (peerId: UserId | null | undefined, options: UseConversationOptions = {}): UseConversationResult => {
  const { store } = useChatContext();
  const { chatId, markReadOnOpen = true, active = true } = options;
  const peer = peerId ? String(peerId) : "";
  const thread = useChatSelector((s) => (peer ? s.threads[peer] : undefined));
  const typing = useChatSelector((s) => (peer ? !!s.typing[peer] : false));
  const conversation = useChatSelector((s) => (peer ? s.conversations.find((c) => c.user_id === peer) : undefined));
  const rateLimitedUntil = useChatSelector((s) => s.rateLimitedUntil ?? null);

  useEffect(() => {
    if (!peer) return;
    return store.openConversation(peer, { chatId: chatId ?? null, markRead: markReadOnOpen });
    // chatId only matters for the first fetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, peer]);
  useEffect(() => {
    if (!peer || !active) return;
    store.setActiveChat(peer);
    return () => {
      if (store.getSnapshot().activePeerId === peer) store.setActiveChat(null);
    };
  }, [store, peer, active]);

  return useMemo<UseConversationResult>(
    () => ({
      messages: thread?.messages || NO_MESSAGES,
      loading: thread ? thread.loading && !thread.loaded : !!peer,
      loadingMore: !!thread?.loadingMore,
      hasMore: thread ? thread.hasMore : true,
      typing,
      thread,
      conversation,
      send: (text, replyTo) => (peer ? store.sendText(peer, text, replyTo) : false),
      sendMedia: (file, replyTo) => (peer ? store.sendMedia(peer, file, replyTo) : Promise.resolve(false)),
      loadMore: () => (peer ? store.loadMore(peer) : false),
      markRead: () => (peer ? store.markRead(peer) : false),
      setTyping: (isTyping) => (peer ? store.setTyping(peer, isTyping) : false),
      refresh: () => (peer ? store.fetchMessages(peer) : false),
      deleteMessage: (messageId, opts) => (peer ? store.deleteMessage(peer, messageId, opts) : false),
      clearChat: () => (peer ? store.clearChat(peer) : false),
      retryMessage: (messageId) => (peer ? store.retryMessage(peer, messageId) : false),
      rateLimitedUntil,
    }),
    [store, peer, thread, typing, conversation, rateLimitedUntil],
  );
};

/** Store-level controls: active chat, refresh, raw store. */
export const useChat = () => {
  const { store } = useChatContext();
  const activePeerId = useChatSelector((s) => s.activePeerId);
  return useMemo(
    () => ({
      store,
      activePeerId,
      setActiveChat: (peerId: UserId | null) => store.setActiveChat(peerId),
      refresh: () => store.refreshConversations(),
      isTyping: (peerId: UserId) => !!store.getSnapshot().typing[peerId],
    }),
    [store, activePeerId],
  );
};

/** REST helpers bound to the CommsWebProvider config. */
export const useChatApi = () => {
  const { config } = useComms();
  return useMemo(() => {
    const api: ApiConfig = { baseUrl: config.baseUrl, getToken: () => config.getToken() };
    return {
      startChat: (candidateId: UserId) => startChat(api, candidateId),
      registerPushToken: <T = unknown>(payload: PushTokenPayload) => registerPushToken<T>(api, payload),
      removePushToken: <T = unknown>(payload: PushTokenPayload) => removePushToken<T>(api, payload),
    };
  }, [config]);
};

// ---- Moderation ----------------------------------------------------------------------------------

const ModerationContext = createContext<ModerationStore | null>(null);

export interface ModerationProviderProps {
  children?: ReactNode;
  store?: ModerationStore;
  /** Load `GET /moderation/blocks` on mount (default false: flags arrive with res_users / res_messages). */
  loadOnMount?: boolean;
}

export const ModerationProvider: React.FC<ModerationProviderProps> = ({ children, store: given, loadOnMount = false }) => {
  const { client, config } = useComms();
  const ref = useRef<ModerationStore | null>(null);
  if (!ref.current) ref.current = given || new ModerationStore({ config, client });
  const store = ref.current;
  useEffect(() => store.attach(client), [store, client]);
  useEffect(() => {
    if (loadOnMount) void store.listBlocked().catch(() => {});
  }, [store, loadOnMount]);
  return <ModerationContext.Provider value={store}>{children}</ModerationContext.Provider>;
};

export interface BlockingApi {
  blockedIds: readonly UserId[];
  blockedUsers: readonly BlockedUser[];
  isBlocked: (peerId: UserId | null | undefined) => boolean;
  blockedByOther: (peerId: UserId | null | undefined) => boolean;
  isBlockedPair: (peerId: UserId | null | undefined) => boolean;
  block: (peerId: UserId) => Promise<void>;
  unblock: (peerId: UserId) => Promise<void>;
  report: (input: ReportInput) => Promise<{ reportId: string | null }>;
  listBlocked: () => Promise<BlockedUser[]>;
  store: ModerationStore;
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

const bind = (store: ModerationStore, snap: ReturnType<ModerationStore["getSnapshot"]>): BlockingApi => ({
  blockedIds: snap.blockedIds,
  blockedUsers: snap.blockedUsers,
  isBlocked: store.isBlocked,
  blockedByOther: store.blockedByOther,
  isBlockedPair: store.isBlockedPair,
  block: (p) => store.block(p),
  unblock: (p) => store.unblock(p),
  report: (i) => store.report(i),
  listBlocked: () => store.listBlocked(),
  store,
});

/** Same as `useBlocking`, or null outside <ModerationProvider> (moderation is opt-in in the UI). */
export const useOptionalBlocking = (): BlockingApi | null => {
  const store = useContext(ModerationContext);
  const snap = useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : nullSnapshot, store ? store.getSnapshot : nullSnapshot);
  return useMemo(() => (store && snap ? bind(store, snap) : null), [store, snap]);
};

/** Block list + report actions. Must be inside <ModerationProvider>. */
export const useBlocking = (): BlockingApi => {
  const api = useOptionalBlocking();
  if (!api) throw new Error("[comms] useBlocking() must be used inside <ModerationProvider>");
  return api;
};

/** Convenience: all three providers in the usual order. */
export const CommsStack: React.FC<{
  config: CommsConfig;
  children?: ReactNode;
  moderation?: boolean;
  onError?: (error: ChatError) => void;
  comms?: Omit<CommsWebProviderProps, "config" | "children">;
  chat?: Omit<ChatProviderProps, "children" | "onError">;
}> = ({ config, children, moderation = true, onError, comms, chat }) => {
  const inner = <ChatProvider onError={onError} {...chat}>{children}</ChatProvider>;
  return (
    <CommsWebProvider config={config} {...comms}>
      {moderation ? <ModerationProvider>{inner}</ModerationProvider> : inner}
    </CommsWebProvider>
  );
};
