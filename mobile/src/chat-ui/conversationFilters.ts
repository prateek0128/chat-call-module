/** Conversation list filter chips (All / Unread N / host filters), empty states, blocked rows. Pure. */
import type { Conversation } from "../chat/types";

export interface ConversationFilter {
  /** "all" and "unread" are built in; hosts add their own keys ("favourites", "matches"…). */
  key: string;
  label: string;
  /** Which conversations the chip shows. */
  predicate: (conversation: Conversation) => boolean;
  /** Show the match count after the label ("Unread 3"). Default: false (true for "unread"). */
  showCount?: boolean;
  /** Empty state when the filter matches nothing. */
  emptyTitle?: string;
  emptyText?: string;
}

export const ALL_FILTER: ConversationFilter = { key: "all", label: "All", predicate: () => true };
export const UNREAD_FILTER: ConversationFilter = {
  key: "unread",
  label: "Unread",
  predicate: (c) => (c.unread_count || 0) > 0,
  showCount: true,
  emptyTitle: "No unread chats",
  emptyText: "You're all caught up",
};

/** Built-ins first, then host filters (a host filter with a built-in key replaces it). */
export const conversationFilters = (extra: readonly ConversationFilter[] = []): ConversationFilter[] => {
  const extraKeys = new Set(extra.map((f) => f.key));
  return [...[ALL_FILTER, UNREAD_FILTER].filter((f) => !extraKeys.has(f.key)), ...extra];
};

export interface FilterChipModel {
  key: string;
  /** "All", "Unread 3" (count hidden when 0). */
  label: string;
  count: number;
  selected: boolean;
  accessibilityLabel: string;
}

export const filterChipModels = (conversations: readonly Conversation[], filters: readonly ConversationFilter[], selectedKey: string): FilterChipModel[] =>
  filters.map((f) => {
    const count = f.showCount ? conversations.filter(f.predicate).length : 0;
    const label = f.showCount && count > 0 ? `${f.label} ${count > 99 ? "99+" : count}` : f.label;
    return {
      key: f.key,
      label,
      count,
      selected: f.key === selectedKey,
      accessibilityLabel: f.showCount ? `${f.label}, ${count} ${count === 1 ? "chat" : "chats"}` : f.label,
    };
  });

/** Applies the selected filter (unknown key -> everything). */
export const applyConversationFilter = <T extends Conversation>(conversations: T[], filters: readonly ConversationFilter[], key: string): T[] => {
  const f = filters.find((x) => x.key === key);
  if (!f || f.key === "all") return conversations;
  return conversations.filter((c) => f.predicate(c));
};

/** Empty-state copy for the list, aware of search and the selected filter. */
export const conversationEmptyState = (input: {
  query?: string;
  filter?: ConversationFilter | null;
  emptyTitle?: string;
  emptyText?: string;
}): { title: string; text: string } => {
  if (input.query && input.query.trim()) return { title: "No chats match", text: "" };
  const f = input.filter;
  if (f && f.key !== "all") return { title: f.emptyTitle || `No ${f.label.toLowerCase()} chats`, text: f.emptyText ?? "" };
  return { title: input.emptyTitle ?? "No chats yet", text: input.emptyText ?? "Conversations you start will show up here." };
};

/** Row text replacing the preview when blocked: "You blocked this contact" / "Blocked by {name}". */
export const blockedRowLabel = (c: Pick<Conversation, "is_blocked" | "blocked_by_other">, name: string): string | null => {
  if (c.is_blocked) return "You blocked this contact";
  if (c.blocked_by_other) return `Blocked by ${name}`;
  return null;
};
