/**
 * CommsProvider — React binding for the single CommsClient + shared UserDirectory.
 * This is the only core module that touches react-native (AppState).
 */

import React, { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { CommsClient, CommsClientOptions, ConnectionStatus, StatusInfo } from "./CommsClient";
import type { CommsConfig } from "./config";
import { UserDirectory, UserProfile } from "./userDirectory";

export interface CommsContextValue {
  client: CommsClient;
  config: CommsConfig;
  users: UserDirectory;
}

const CommsContext = createContext<CommsContextValue | null>(null);

export interface CommsProviderProps {
  config: CommsConfig;
  children?: ReactNode;
  /** Bring your own client (tests, or sharing one outside React). */
  client?: CommsClient;
  /** Bring your own directory (e.g. pre-seeded with profile names). */
  users?: UserDirectory;
  /** Connect on mount (default true). Set false and call `client.connect()` after login. */
  autoConnect?: boolean;
  offlineSendPolicy?: CommsClientOptions["offlineSendPolicy"];
  pingIntervalMs?: number;
  createWebSocket?: CommsClientOptions["createWebSocket"];
}

export const CommsProvider: React.FC<CommsProviderProps> = ({
  config,
  children,
  client: givenClient,
  users: givenUsers,
  autoConnect = true,
  offlineSendPolicy,
  pingIntervalMs,
  createWebSocket,
}) => {
  // Config callbacks may change identity every render; the client reads them through this ref.
  const configRef = useRef(config);
  configRef.current = config;

  const clientRef = useRef<CommsClient | null>(null);
  if (!clientRef.current) {
    const stableConfig: CommsConfig = {
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
      givenClient ||
      new CommsClient({ config: stableConfig, appState: AppState, offlineSendPolicy, pingIntervalMs, createWebSocket });
  }
  const usersRef = useRef<UserDirectory | null>(null);
  if (!usersRef.current) usersRef.current = givenUsers || new UserDirectory();

  const client = clientRef.current;
  useEffect(() => {
    // Children subscribe in their own effects, which run before this one.
    if (autoConnect) void client.connect();
    return () => client.disconnect();
  }, [client, autoConnect]);

  const value = useMemo<CommsContextValue>(
    () => ({ client, config: client.config, users: usersRef.current as UserDirectory }),
    [client],
  );
  return <CommsContext.Provider value={value}>{children}</CommsContext.Provider>;
};

export const useComms = (): CommsContextValue => {
  const ctx = useContext(CommsContext);
  if (!ctx) throw new Error("[comms] useComms() must be used inside <CommsProvider>");
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

export const useIsConnected = (): boolean => useConnectionStatus().status === ("open" as ConnectionStatus);

/** Name / avatar of a user from the shared directory; re-renders when it learns them. */
export const useUserProfile = (userId?: string | null): UserProfile | undefined => {
  const { users } = useComms();
  useSyncExternalStore(users.subscribe, users.getVersion, users.getVersion);
  return users.get(userId);
};
