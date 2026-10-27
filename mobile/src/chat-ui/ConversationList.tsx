import { memo, ReactElement, useCallback, useMemo, useState } from "react";
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ListRenderItemInfo } from "react-native";
import type { Conversation } from "../chat/types";
import { Icon, useTheme, type Theme } from "../theme";
import { CONVERSATION_ROW_HEIGHT, ConversationRow } from "./ConversationRow";
import { applyConversationFilter, conversationEmptyState, conversationFilters, filterChipModels, type ConversationFilter } from "./conversationFilters";
import type { ClockFormat } from "./format";
import { useTicker } from "./hooks";
import { filterConversations } from "./preview";
import { SkeletonBox, textStyle } from "./primitives";

export interface ConversationListProps {
  conversations: Conversation[];
  /** False until the first list arrived: shows 6 skeleton rows. */
  loaded: boolean;
  onOpenConversation: (peerId: string, conversation: Conversation) => void;
  /** Peer id -> typing. */
  typing?: Record<string, boolean>;
  /** Highlighted row (split-pane layouts). */
  selectedPeerId?: string | null;
  /** Show the search field (default true). */
  searchable?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  emptyTitle?: string;
  emptyText?: string;
  clock?: ClockFormat;
  /** Extra content above the search field (scrolls with the list). */
  ListHeaderComponent?: ReactElement | null;
  /** Bottom padding (safe area). */
  contentInsetBottom?: number;
  /** Filter chips under the search field: All / Unread N (+ `filters`). Default true. */
  showFilters?: boolean;
  /** Host filters appended after All / Unread (same key replaces a built-in). */
  filters?: ConversationFilter[];
  /** Controlled selected filter key (else internal state, starting at `initialFilter` or "all"). */
  filter?: string;
  initialFilter?: string;
  onFilterChange?: (key: string) => void;
}

const keyExtractor = (c: Conversation) => String(c.user_id);
const getItemLayout = (_: unknown, index: number) => ({ length: CONVERSATION_ROW_HEIGHT, offset: CONVERSATION_ROW_HEIGHT * index, index });

export const ConversationList = memo(function ConversationList({
  conversations,
  loaded,
  onOpenConversation,
  typing,
  selectedPeerId,
  searchable = true,
  refreshing = false,
  onRefresh,
  emptyTitle = "No chats yet",
  emptyText = "Conversations you start will show up here.",
  clock,
  ListHeaderComponent,
  contentInsetBottom = 0,
  showFilters = true,
  filters: extraFilters,
  filter: controlledFilter,
  initialFilter = "all",
  onFilterChange,
}: ConversationListProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const [query, setQuery] = useState("");
  const [ownFilter, setOwnFilter] = useState(initialFilter);
  const filterKey = controlledFilter ?? ownFilter;
  const allFilters = useMemo(() => conversationFilters(extraFilters), [extraFilters]);
  const selectFilter = useCallback(
    (key: string) => {
      if (controlledFilter === undefined) setOwnFilter(key);
      onFilterChange?.(key);
    },
    [controlledFilter, onFilterChange],
  );
  // A "now" that changes once a minute keeps rows memoised but rolls "Today" over.
  const minute = useTicker(true, 60000);
  const now = useMemo(() => new Date(), [minute]);
  const data = useMemo(
    () => filterConversations(showFilters ? applyConversationFilter(conversations, allFilters, filterKey) : conversations, query),
    [conversations, query, showFilters, allFilters, filterKey],
  );
  const chips = useMemo(() => (showFilters ? filterChipModels(conversations, allFilters, filterKey) : []), [showFilters, conversations, allFilters, filterKey]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Conversation>) => (
      <ConversationRow
        conversation={item}
        typing={!!typing?.[item.user_id]}
        selected={selectedPeerId != null && String(selectedPeerId) === String(item.user_id)}
        onPress={onOpenConversation}
        now={now}
        clock={clock}
      />
    ),
    [typing, selectedPeerId, onOpenConversation, now, clock],
  );

  const header = (
    <View>
      {ListHeaderComponent}
      {searchable ? (
        <View style={s.searchWrap}>
          <Icon name="search" size={theme.font.size.body} color={theme.colors.textSubtle} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.colors.textSubtle}
            style={s.search}
            accessibilityLabel="Search chats by name"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      ) : null}
      {chips.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} accessibilityRole="radiogroup" accessibilityLabel="Filter chats">
          {chips.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => selectFilter(c.key)}
              accessibilityRole="radio"
              accessibilityLabel={c.accessibilityLabel}
              accessibilityState={{ selected: c.selected, checked: c.selected }}
              style={[s.chip, c.selected ? s.chipSelected : null]}
            >
              <Text style={[s.chipText, c.selected ? s.chipTextSelected : null]}>{c.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  if (!loaded) {
    return (
      <View style={s.fill} accessibilityLabel="Loading chats" accessibilityState={{ busy: true }}>
        {header}
        {Array.from({ length: 6 }, (_, i) => (
          <View key={i} style={s.skeletonRow}>
            <SkeletonBox theme={theme} width={48} height={48} radius={24} />
            <View style={s.skeletonBody}>
              <SkeletonBox theme={theme} width="55%" height={12} />
              <SkeletonBox theme={theme} width="80%" height={10} style={{ marginTop: theme.space.sm }} />
            </View>
          </View>
        ))}
      </View>
    );
  }

  const emptyCopy = conversationEmptyState({ query, filter: showFilters ? allFilters.find((f) => f.key === filterKey) : null, emptyTitle, emptyText });
  const empty = (
    <View style={s.empty} accessibilityLiveRegion="polite">
      <Text style={s.emptyTitle}>{emptyCopy.title}</Text>
      {emptyCopy.text ? <Text style={s.emptyText}>{emptyCopy.text}</Text> : null}
    </View>
  );

  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      getItemLayout={getItemLayout}
      extraData={now}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      refreshing={onRefresh ? refreshing : undefined}
      onRefresh={onRefresh}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={9}
      removeClippedSubviews={Platform.OS === "android"}
      style={s.fill}
      contentContainerStyle={{ paddingBottom: contentInsetBottom }}
      accessibilityLabel="Chats"
    />
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        fill: { flex: 1, backgroundColor: theme.colors.surface },
        searchWrap: {
          flexDirection: "row",
          alignItems: "center",
          marginHorizontal: theme.space.lg,
          marginVertical: theme.space.sm,
          paddingHorizontal: theme.space.md,
          minHeight: theme.layout.tapTarget,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceSunken,
        },
        search: { ...textStyle(theme, "body", theme.colors.text), flex: 1, marginLeft: theme.space.sm, paddingVertical: theme.space.sm },
        skeletonRow: { height: CONVERSATION_ROW_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: theme.space.lg },
        skeletonBody: { flex: 1, marginLeft: theme.space.md },
        empty: { alignItems: "center", paddingHorizontal: theme.space.xl, paddingVertical: theme.space.xxl },
        emptyTitle: { ...textStyle(theme, "title", theme.colors.text, "semibold"), textAlign: "center" },
        emptyText: { ...textStyle(theme, "small", theme.colors.textMuted), textAlign: "center", marginTop: theme.space.xs },
        chips: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm, flexDirection: "row" },
        chip: {
          minHeight: 32,
          justifyContent: "center",
          paddingHorizontal: theme.space.md,
          marginRight: theme.space.sm,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surfaceSunken,
        },
        chipSelected: { backgroundColor: theme.colors.accentSoft },
        chipText: textStyle(theme, "small", theme.colors.textMuted, "medium"),
        chipTextSelected: { color: theme.colors.accentStrong },
      }),
    [theme],
  );
