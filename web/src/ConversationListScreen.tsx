import React, { memo, ReactNode, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  applyConversationFilter,
  blockedRowLabel,
  conversationEmptyState,
  conversationFilters,
  conversationPreview,
  filterChipModels,
  filterConversations,
  formatListTime,
  formatUnreadBadge,
  headerStatus,
  TICK_GLYPHS,
  TICK_LABELS,
  type ClockFormat,
  type Conversation,
  type ConversationFilter,
} from "commskit/engine";
import { useAppearance } from "./appearance";
import { useChatContext, useConversations, useOptionalBlocking } from "./providers";
import { AppearanceSheet, BlockedUsersScreen } from "./sheets";
import { Avatar, ConnectionBanner, Icon } from "./ui";
import { cx } from "./util";

export const displayName = (c: Pick<Conversation, "username" | "user_id">): string => (c.username && c.username.trim()) || `User ${c.user_id}`;

export interface ConversationRowProps {
  conversation: Conversation;
  typing?: boolean;
  selected?: boolean;
  tabbable?: boolean;
  onSelect: (peerId: string, conversation: Conversation) => void;
  clock?: ClockFormat;
}

export const ConversationRow = memo(function ConversationRow({ conversation: c, typing = false, selected = false, tabbable = false, onSelect, clock }: ConversationRowProps) {
  const name = displayName(c);
  const blocked = blockedRowLabel(c, name);
  const preview = conversationPreview(c, typing && !blocked);
  const unread = formatUnreadBadge(c.unread_count);
  const time = formatListTime(c.last_message?.timestamp || c.updated_at, new Date(), clock);
  const online = headerStatus({ status: c.status, isBlocked: c.is_blocked, blockedByOther: c.blocked_by_other }).showOnlineDot;
  const previewText = blocked ?? `${preview.prefix}${preview.text}`;
  const label = `${name}${unread ? `, ${unread} unread` : ""}${previewText ? `, ${previewText}` : ""}`;
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      className={cx("ck-row", selected && "is-selected", unread && "is-unread", blocked && "is-blocked")}
      data-peer={c.user_id}
      onClick={() => onSelect(String(c.user_id), c)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(String(c.user_id), c);
        }
      }}
    >
      <Avatar name={name} id={String(c.user_id)} src={c.avatar} online={online} size={48} />
      <div className="ck-row-main">
        <div className="ck-row-top">
          <span className="ck-row-name">{name}</span>
          <span className="ck-row-time">{time}</span>
        </div>
        <div className="ck-row-bottom">
          <span className={cx("ck-row-preview", preview.accent && !blocked && "is-accent", preview.danger && "is-danger", preview.italic && "is-italic", blocked && "is-blocked")}>
            {blocked ? (
              blocked
            ) : (
              <>
                {preview.prefix}
                {preview.ticks ? (
                  <span className="ck-row-tick" data-state={preview.ticks} title={TICK_LABELS[preview.ticks]} aria-label={TICK_LABELS[preview.ticks]}>
                    {TICK_GLYPHS[preview.ticks]}{" "}
                  </span>
                ) : null}
                {preview.text}
              </>
            )}
          </span>
          {unread ? (
            <span className="ck-badge" aria-hidden="true">
              {unread}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});

const SkeletonRows: React.FC = () => (
  <div className="ck-skeletons" aria-hidden="true">
    {Array.from({ length: 6 }).map((_, i) => (
      <div className="ck-row ck-skeleton-row" key={i}>
        <span className="ck-skeleton ck-skeleton-avatar" />
        <div className="ck-row-main">
          <span className="ck-skeleton ck-skeleton-line" style={{ width: `${45 + ((i * 13) % 30)}%` }} />
          <span className="ck-skeleton ck-skeleton-line short" style={{ width: `${60 + ((i * 7) % 25)}%` }} />
        </div>
      </div>
    ))}
  </div>
);

export interface ConversationListScreenProps {
  /** Highlights the open conversation (split layout). */
  selectedPeerId?: string | null;
  onSelect: (peerId: string, conversation: Conversation) => void;
  title?: string;
  /** Extra filter chips after "All" and "Unread". */
  filters?: ConversationFilter[];
  emptyTitle?: string;
  emptyText?: string;
  /** Opens the appearance sheet. Default: the built-in global AppearanceSheet. `false` hides the button. */
  onOpenAppearance?: (() => void) | false;
  /** Show the "Blocked users" button (default: when a ModerationProvider is mounted). */
  blockedUsers?: boolean;
  /** Extra buttons in the header. */
  headerActions?: ReactNode;
  clock?: ClockFormat;
  className?: string;
}

export const ConversationListScreen: React.FC<ConversationListScreenProps> = ({
  selectedPeerId,
  onSelect,
  title = "Chats",
  filters: extraFilters,
  emptyTitle,
  emptyText,
  onOpenAppearance,
  blockedUsers,
  headerActions,
  clock,
  className,
}) => {
  const { conversations, loaded } = useConversations();
  const { store } = useChatContext();
  const typing = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().typing,
    () => store.getSnapshot().typing,
  );
  const appearance = useAppearance();
  const moderation = useOptionalBlocking();
  const [query, setQuery] = useState("");
  const [filterKey, setFilterKey] = useState("all");
  const [sheet, setSheet] = useState<null | "appearance" | "blocked">(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const filters = useMemo(() => conversationFilters(extraFilters), [extraFilters]);
  const chips = useMemo(() => filterChipModels(conversations, filters, filterKey), [conversations, filters, filterKey]);
  const visible = useMemo(() => applyConversationFilter(filterConversations(conversations, query), filters, filterKey), [conversations, filters, filterKey, query]);
  const empty = conversationEmptyState({ query, filter: filters.find((f) => f.key === filterKey), emptyTitle, emptyText });

  const showBlocked = blockedUsers ?? !!moderation;
  const showAppearance = onOpenAppearance !== false && (onOpenAppearance || appearance.available);

  const rowsIds = visible.map((c) => String(c.user_id));
  const tabbableId = focusKey && rowsIds.includes(focusKey) ? focusKey : selectedPeerId && rowsIds.includes(selectedPeerId) ? selectedPeerId : rowsIds[0];

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusKey(id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-peer="${CSS.escape(id)}"]`)?.focus());
  };
  const onListKeyDown = (e: React.KeyboardEvent) => {
    const active = (document.activeElement as HTMLElement | null)?.getAttribute("data-peer");
    const i = active ? rowsIds.indexOf(active) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(rowsIds[Math.min(rowsIds.length - 1, i + 1)]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(rowsIds[Math.max(0, i - 1)]);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(rowsIds[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(rowsIds[rowsIds.length - 1]);
    }
  };

  return (
    <section className={cx("ck-list-screen", className)} aria-label={title}>
      <header className="ck-list-header">
        <h1 className="ck-list-title">{title}</h1>
        <div className="ck-header-actions">
          {headerActions}
          {showBlocked ? (
            <button type="button" className="ck-icon-btn" aria-label="Blocked users" title="Blocked users" onClick={() => setSheet("blocked")}>
              <Icon name="ban" />
            </button>
          ) : null}
          {showAppearance ? (
            <button
              type="button"
              className="ck-icon-btn"
              aria-label="Appearance"
              title="Appearance"
              onClick={() => (typeof onOpenAppearance === "function" ? onOpenAppearance() : setSheet("appearance"))}
            >
              <Icon name="palette" />
            </button>
          ) : null}
        </div>
      </header>
      <ConnectionBanner />
      <div className="ck-search">
        <Icon name="search" size={18} />
        <input
          type="search"
          className="ck-search-input"
          placeholder="Search chats"
          aria-label="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusRow(rowsIds[0]);
            } else if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button type="button" className="ck-icon-btn ck-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>
      <div className="ck-chips" role="group" aria-label="Filter chats">
        {chips.map((c) => (
          <button key={c.key} type="button" className={cx("ck-chip", c.selected && "is-selected")} aria-pressed={c.selected} aria-label={c.accessibilityLabel} onClick={() => setFilterKey(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="ck-list-scroll">
        {!loaded ? (
          <SkeletonRows />
        ) : visible.length === 0 ? (
          <div className="ck-empty" role="status">
            <Icon name="message" size={36} />
            <p className="ck-empty-title">{empty.title}</p>
            {empty.text ? <p className="ck-empty-text">{empty.text}</p> : null}
          </div>
        ) : (
          <div ref={listRef} role="listbox" aria-label="Conversations" className="ck-rows" onKeyDown={onListKeyDown}>
            {visible.map((c) => (
              <ConversationRow
                key={String(c.user_id)}
                conversation={c}
                typing={!!typing[String(c.user_id)]}
                selected={selectedPeerId != null && String(selectedPeerId) === String(c.user_id)}
                tabbable={String(c.user_id) === tabbableId}
                onSelect={onSelect}
                clock={clock}
              />
            ))}
          </div>
        )}
      </div>
      {sheet === "appearance" ? <AppearanceSheet onClose={() => setSheet(null)} /> : null}
      {sheet === "blocked" ? <BlockedUsersScreen onClose={() => setSheet(null)} /> : null}
    </section>
  );
};
