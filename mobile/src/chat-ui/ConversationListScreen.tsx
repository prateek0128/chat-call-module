import { slot } from "../theme";
import { memo, ReactNode, useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useConversations, useUnreadCount } from "../chat";
import type { Conversation } from "../chat/types";
import { Avatar, Icon, ScalePressable, useSafeInsets, useTheme, type EdgeInsets, type Theme } from "../theme";
import { AppearanceSheet, type AppearanceSheetProps } from "./AppearanceSheet";
import type { GradientRenderProps } from "./ChatWallpaper";
import { ConnectionBanner } from "./ConnectionBanner";
import { ConversationList } from "./ConversationList";
import type { ConversationFilter } from "./conversationFilters";
import type { ClockFormat } from "./format";
import { useTypingMap } from "./hooks";
import { textStyle } from "./primitives";

export interface ConversationListScreenProps {
  /** Navigate to the chat. */
  onOpenConversation: (peerId: string, conversation: Conversation) => void;
  /** Highlighted conversation (split-pane layouts). */
  selectedPeerId?: string | null;
  title?: string;
  /** Your own avatar in the header. */
  me?: { name?: string | null; avatarUri?: string | null; id?: string | null } | null;
  /** Header actions on the right (new chat, settings, ...). */
  renderHeaderActions?: () => ReactNode;
  /** Explicit insets; otherwise react-native-safe-area-context (optional) or zero. */
  insets?: Partial<EdgeInsets>;
  showConnectionBanner?: boolean;
  searchable?: boolean;
  emptyTitle?: string;
  emptyText?: string;
  clock?: ClockFormat;
  /**
   * Shows an "Appearance" header action. Without onOpenAppearance it opens the built-in
   * AppearanceSheet (global mode; needs an <AppearanceProvider>). Default false.
   */
  showAppearanceAction?: boolean;
  /** Handle the "Appearance" action yourself (e.g. navigate to a settings screen). */
  onOpenAppearance?: () => void;
  /** Image picker for the sheet's "Choose image..." tile. */
  pickWallpaperImage?: AppearanceSheetProps["pickImage"];
  renderGradient?: (props: GradientRenderProps) => ReactNode;
  /** Filter chips All / Unread N (+ `filters`). Default true. */
  showFilters?: boolean;
  /** Host filters appended after All / Unread. */
  filters?: ConversationFilter[];
  /** Controlled selected filter + change callback (else internal state). */
  filter?: string;
  onFilterChange?: (key: string) => void;
}

/** Ready-made inbox: header ("Chats"), connection banner, search, live conversation list. */
export const DefaultConversationListScreen = memo(function ConversationListScreen({
  onOpenConversation,
  selectedPeerId,
  title = "Chats",
  me,
  renderHeaderActions,
  insets,
  showConnectionBanner = true,
  searchable = true,
  emptyTitle,
  emptyText,
  clock,
  showAppearanceAction = false,
  onOpenAppearance,
  pickWallpaperImage,
  renderGradient,
  showFilters,
  filters,
  filter,
  onFilterChange,
}: ConversationListScreenProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const safe = useSafeInsets(insets);
  const { conversations, loaded, refresh } = useConversations();
  const unread = useUnreadCount();
  const typing = useTypingMap();
  const [refreshing, setRefreshing] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const openAppearance = useCallback(() => (onOpenAppearance ? onOpenAppearance() : setAppearanceOpen(true)), [onOpenAppearance]);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh();
    // The list updates live; the spinner is only feedback for the gesture.
    setTimeout(() => setRefreshing(false), 800);
  }, [refresh]);

  return (
    <View style={[s.screen, { paddingLeft: safe.left, paddingRight: safe.right }]}>
      <View style={[s.header, { paddingTop: safe.top, height: 56 + safe.top }]}>
        {me ? <Avatar name={me.name} id={me.id || me.name} uri={me.avatarUri} size={32} style={{ marginRight: theme.space.md }} /> : null}
        <Text style={s.title} accessibilityRole="header" accessibilityLabel={unread ? `${title}, ${unread} unread` : title} numberOfLines={1}>
          {title}
        </Text>
        <View style={s.actions}>
          {renderHeaderActions ? renderHeaderActions() : null}
          {showAppearanceAction ? (
            <ScalePressable onPress={openAppearance} accessibilityLabel="Appearance" style={s.iconButton}>
              <Icon name="palette" size={theme.font.size.title} color={theme.colors.accent} />
            </ScalePressable>
          ) : null}
        </View>
      </View>
      {showConnectionBanner ? <ConnectionBanner /> : null}
      <ConversationList
        conversations={conversations}
        loaded={loaded}
        onOpenConversation={onOpenConversation}
        typing={typing}
        selectedPeerId={selectedPeerId}
        searchable={searchable}
        refreshing={refreshing}
        onRefresh={onRefresh}
        emptyTitle={emptyTitle}
        emptyText={emptyText}
        clock={clock}
        contentInsetBottom={safe.bottom}
        showFilters={showFilters}
        filters={filters}
        filter={filter}
        onFilterChange={onFilterChange}
      />
      {showAppearanceAction && !onOpenAppearance ? (
        <AppearanceSheet
          visible={appearanceOpen}
          onClose={() => setAppearanceOpen(false)}
          pickImage={pickWallpaperImage}
          renderGradient={renderGradient}
          insetBottom={safe.bottom}
        />
      ) : null}
    </View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface },
        header: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.lg,
          backgroundColor: theme.colors.surface,
        },
        title: { ...textStyle(theme, "heading", theme.colors.text, "bold"), flex: 1 },
        actions: { flexDirection: "row", alignItems: "center" },
        iconButton: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.pill,
        },
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const ConversationListScreen = slot("ConversationListScreen", DefaultConversationListScreen);
