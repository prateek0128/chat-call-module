/**
 * ChatProvider — binds a ChatStore to the CommsClient from <CommsProvider>.
 * - subscribes to the chat frames (PROTOCOL §3) and the call frames that become chat entries
 * - requests `req_users` on every (re)connect and re-fetches open conversations
 */
import React, { createContext, ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { useComms } from "../core/CommsProvider";
import { CHAT_EVENT_TYPES, ChatStore, ChatStoreOptions } from "./ChatStore";
import { expoReadFileAsBase64 } from "./media";
import type { ChatError, ReadFileAsBase64 } from "./types";

export interface ChatContextValue {
  store: ChatStore;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export interface ChatProviderProps {
  children?: ReactNode;
  /** Reads a picked file as base64. Default: expo-file-system/legacy (lazily required). */
  readFileAsBase64?: ReadFileAsBase64;
  /** Errors to show to the user (send failed, file too large, ...). */
  onError?: (error: ChatError) => void;
  /** Page size for get_messages (default 10, server max 100). */
  pageSize?: number;
  /** Upload limit in bytes (default 10 MB, the server's limit). */
  maxUploadBytes?: number;
  /** Mark the active open conversation read when a message arrives in it (default true). */
  autoMarkReadActive?: boolean;
  /** Bring your own store (tests / sharing state outside React). */
  store?: ChatStore;
}

export const ChatProvider: React.FC<ChatProviderProps> = ({
  children,
  readFileAsBase64,
  onError,
  pageSize,
  maxUploadBytes,
  autoMarkReadActive,
  store: givenStore,
}) => {
  const { client, users } = useComms();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const storeRef = useRef<ChatStore | null>(null);
  if (!storeRef.current) {
    const options: ChatStoreOptions = {
      send: (type, payload) => client.send(type, payload),
      canSend: () => client.canSend(),
      getUserId: () => client.userId,
      users,
      readFileAsBase64: readFileAsBase64 || expoReadFileAsBase64,
      onError: (e) => onErrorRef.current?.(e),
      pageSize,
      maxUploadBytes,
      autoMarkReadActive,
    };
    storeRef.current = givenStore || new ChatStore(options);
  }
  const store = storeRef.current;

  useEffect(() => {
    store.setReadFileAsBase64(readFileAsBase64 || expoReadFileAsBase64);
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

  const value = useMemo(() => ({ store }), [store]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChatContext = (): ChatContextValue => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("[comms] chat hooks must be used inside <ChatProvider>");
  return ctx;
};
