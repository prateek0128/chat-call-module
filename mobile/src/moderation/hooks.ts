/** React hooks over ModerationStore. */
import { useMemo, useSyncExternalStore } from "react";
import type { UserId } from "../core/types";
import { useModerationStore, useOptionalModerationStore } from "./ModerationProvider";
import type { BlockedUser, ModerationStore, ReportInput } from "./ModerationStore";

export interface BlockingApi {
  blockedIds: readonly UserId[];
  blockedUsers: readonly BlockedUser[];
  isBlocked: (peerId: UserId | null | undefined) => boolean;
  blockedByOther: (peerId: UserId | null | undefined) => boolean;
  /** Either direction. */
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

/** Block list + report actions. Must be inside <ModerationProvider>. */
export const useBlocking = (): BlockingApi => {
  const store = useModerationStore();
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => bind(store, snap), [store, snap]);
};

/** Same as useBlocking, or null outside <ModerationProvider> (opt-in moderation in the UI kits). */
export const useOptionalBlocking = (): BlockingApi | null => {
  const store = useOptionalModerationStore();
  const snap = useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : nullSnapshot, store ? store.getSnapshot : nullSnapshot);
  return useMemo(() => (store && snap ? bind(store, snap) : null), [store, snap]);
};
