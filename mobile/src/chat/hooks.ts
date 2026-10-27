/** React hooks over the ChatStore (useSyncExternalStore). */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useComms } from "../core/CommsProvider";
import type { ChatId, UserId } from "../core/types";
import { ApiConfig, registerPushToken, removePushToken, startChat, PushTokenPayload } from "./api";
import { useChatContext } from "./ChatProvider";
import type { ChatMessage, ChatState, Conversation, ConversationThread, MediaFile } from "./types";

const useChatSelector = <T,>(select: (s: ChatState) => T): T => {
  const { store } = useChatContext();
  const get = () => select(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, get, get);
};

/** Conversation list (newest activity first) from `res_users`, kept live. */
export const useConversations = (): { conversations: Conversation[]; loaded: boolean; refresh: () => boolean } => {
  const { store } = useChatContext();
  const conversations = useChatSelector((s) => s.conversations);
  const loaded = useChatSelector((s) => s.conversationsLoaded);
  const refresh = useCallback(() => store.refreshConversations(), [store]);
  return { conversations, loaded, refresh };
};

/** Total unread messages across conversations. */
export const useUnreadCount = (): number => useChatSelector((s) => s.unreadTotal);

export type ReplyTarget = Pick<ChatMessage, "id" | "sender_id" | "content" | "message_type" | "file_name">;

export interface UseConversationOptions {
  /** Known chat id (e.g. from startChat / a push). Optional. */
  chatId?: ChatId | null;
  /** Mark read when opened (default true). */
  markReadOnOpen?: boolean;
  /**
   * Treat this conversation as the active (on-screen) one while mounted, which
   * suppresses unread increments / in-app banners for it (default true).
   * Pass false and call `useChat().setActiveChat` from your focus handler instead
   * if the screen stays mounted while hidden.
   */
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
  /** PROTOCOL §9: delete for me (default) or unsend for everyone (own messages, within the server window). */
  deleteMessage: (messageId: ChatMessage["id"], options?: { forEveryone?: boolean }) => boolean;
  /** PROTOCOL §9: clear this chat for me (applied when the server confirms with `chat_cleared`). */
  clearChat: () => boolean;
  /** Resend a `failed` message (rate limited / too long). */
  retryMessage: (messageId: ChatMessage["id"]) => boolean | Promise<boolean>;
  /** Epoch ms until which the server rate-limits sends (null = not limited). */
  rateLimitedUntil: number | null;
}

const NO_MESSAGES: ChatMessage[] = [];

/** One conversation (1:1 with `peerId`). Fetches the first page on mount. */
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

/** Store-level controls: active chat (notification suppression), refresh, raw store. */
export const useChat = () => {
  const { store } = useChatContext();
  const activePeerId = useChatSelector((s) => s.activePeerId);
  return useMemo(
    () => ({
      store,
      activePeerId,
      /** Peer whose conversation is on screen; null when none. Use it to suppress in-app banners too. */
      setActiveChat: (peerId: UserId | null) => store.setActiveChat(peerId),
      /** Re-request the conversation list. */
      refresh: () => store.refreshConversations(),
      /** Is someone typing to me (any conversation)? */
      isTyping: (peerId: UserId) => !!store.getSnapshot().typing[peerId],
    }),
    [store, activePeerId],
  );
};

/** REST helpers bound to the CommsProvider config. */
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
