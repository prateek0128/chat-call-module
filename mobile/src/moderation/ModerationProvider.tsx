/** ModerationProvider — one ModerationStore bound to the CommsClient from <CommsProvider>. */
import React, { createContext, ReactNode, useContext, useEffect, useRef } from "react";
import { useComms } from "../core/CommsProvider";
import { ModerationStore } from "./ModerationStore";

const ModerationContext = createContext<ModerationStore | null>(null);

export interface ModerationProviderProps {
  children?: ReactNode;
  /** Bring your own store (tests, or sharing one outside React). */
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

/** The store, or null outside <ModerationProvider> (UI kits use this to make moderation opt-in). */
export const useOptionalModerationStore = (): ModerationStore | null => useContext(ModerationContext);

export const useModerationStore = (): ModerationStore => {
  const store = useContext(ModerationContext);
  if (!store) throw new Error("[comms] useBlocking() must be used inside <ModerationProvider>");
  return store;
};
