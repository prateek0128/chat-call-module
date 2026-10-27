/** In-app new-message banner: which messages get a banner (dedupe + suppression). Pure. */
import type { ChatMessage, ChatState } from "../chat/types";
import { isCallMessage } from "./callEntryModel";
import { replySnippet } from "./messageActions";
import { parseTimestamp } from "./format";

export const BANNER_AUTO_HIDE_MS = 4000;
/** Messages older than this (history / reconnect catch-up) never get a banner. */
export const BANNER_MAX_AGE_MS = 2 * 60 * 1000;
const SEEN_LIMIT = 500;

export type BannerSuppression = "mine" | "call" | "pending" | "duplicate" | "active_chat" | "background" | "disabled" | "stale";

export interface BannerDecisionInput {
  peerId: string;
  message: Pick<ChatMessage, "id" | "isMine" | "message_type" | "timestamp"> & Partial<Pick<ChatMessage, "pending">>;
  /** Chat currently on screen (no banner for it). */
  activePeerId?: string | null;
  /** App in the foreground. */
  appActive?: boolean;
  enabled?: boolean;
  /** Keys already bannered / seen. */
  seen?: { has(key: string): boolean };
  now?: number;
  maxAgeMs?: number;
}

export const bannerKey = (peerId: string, m: Pick<ChatMessage, "id">): string => `${peerId}:${String(m.id)}`;

/** Why no banner is shown for this message, or null when it should be shown. */
export const bannerSuppression = (i: BannerDecisionInput): BannerSuppression | null => {
  const m = i.message;
  if (i.enabled === false) return "disabled";
  if (i.seen?.has(bannerKey(i.peerId, m))) return "duplicate";
  if (m.isMine) return "mine";
  if (isCallMessage(m)) return "call";
  if (m.pending || String(m.id).startsWith("temp_")) return "pending";
  if (i.activePeerId != null && String(i.activePeerId) === String(i.peerId)) return "active_chat";
  if (i.appActive === false) return "background";
  const ts = parseTimestamp(m.timestamp);
  if (ts && (i.now ?? Date.now()) - ts.getTime() > (i.maxAgeMs ?? BANNER_MAX_AGE_MS)) return "stale";
  return null;
};

export interface BannerCandidate {
  key: string;
  peerId: string;
  message: ChatMessage;
}

/** Bounded insertion-ordered set of seen keys (dedupe across store updates). */
export class SeenSet {
  private keys = new Set<string>();
  constructor(private limit: number = SEEN_LIMIT) {}
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);
    while (this.keys.size > this.limit) {
      const first = this.keys.values().next().value as string;
      this.keys.delete(first);
    }
  }
  get size(): number {
    return this.keys.size;
  }
}

/** Marks every thread's newest message as seen (call on mount so history never banners). */
export const primeSeen = (state: Pick<ChatState, "threads">, seen: SeenSet): void => {
  for (const peerId of Object.keys(state.threads)) {
    const m = state.threads[peerId]?.messages[0];
    if (m) seen.add(bannerKey(peerId, m));
  }
};

/**
 * New banner candidates in a store snapshot: each thread's newest message that is not seen
 * yet and not suppressed. Every newest message is marked seen (so it is decided once).
 */
export const scanForBanners = (
  state: Pick<ChatState, "threads" | "activePeerId">,
  seen: SeenSet,
  opts: { activePeerId?: string | null; appActive?: boolean; enabled?: boolean; now?: number; maxAgeMs?: number } = {},
): BannerCandidate[] => {
  const out: BannerCandidate[] = [];
  const active = opts.activePeerId !== undefined ? opts.activePeerId : state.activePeerId;
  for (const peerId of Object.keys(state.threads)) {
    const m = state.threads[peerId]?.messages[0];
    if (!m) continue;
    const key = bannerKey(peerId, m);
    const reason = bannerSuppression({ peerId, message: m, activePeerId: active, appActive: opts.appActive, enabled: opts.enabled, seen, now: opts.now, maxAgeMs: opts.maxAgeMs });
    if (reason === "duplicate" || reason === "pending") continue; // pending: decide once confirmed
    seen.add(key);
    if (!reason) out.push({ key, peerId, message: m });
  }
  return out;
};

/** Banner body text: message text or attachment label. */
export const bannerText = (m: ChatMessage): string => replySnippet(m, 160);
