import { memo, useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Conversation } from "../chat/types";
import { Avatar, Icon, useTheme, type Theme } from "../theme";
import { blockedRowLabel } from "./conversationFilters";
import { formatListTime, formatUnreadBadge, type ClockFormat } from "./format";
import { conversationPreview, TICK_GLYPHS, TICK_LABELS } from "./preview";
import { textStyle } from "./primitives";

/** Row height from the design spec (used by getItemLayout). */
export const CONVERSATION_ROW_HEIGHT = 72;

export interface ConversationRowProps {
  conversation: Conversation;
  typing?: boolean;
  selected?: boolean;
  onPress: (peerId: string, conversation: Conversation) => void;
  /** Reference "now" for relative times (pass a value that changes daily to roll "Today" over). */
  now?: Date;
  clock?: ClockFormat;
}

export const displayName = (c: Pick<Conversation, "username" | "user_id">): string => (c.username && c.username.trim()) || `User ${c.user_id}`;

export const ConversationRow = memo(function ConversationRow({ conversation, typing = false, selected = false, onPress, now, clock }: ConversationRowProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const name = displayName(conversation);
  const preview = conversationPreview(conversation, typing);
  const unread = formatUnreadBadge(conversation.unread_count);
  const time = formatListTime(conversation.last_message?.timestamp || conversation.updated_at, now || new Date(), clock);
  const blocked = blockedRowLabel(conversation, name);
  // Blocked either way: no presence.
  const online = !blocked && conversation.status === "online";
  const handlePress = useCallback(() => onPress(conversation.user_id, conversation), [onPress, conversation]);

  const previewColor = preview.accent ? theme.colors.accent : preview.danger ? theme.colors.danger : theme.colors.textMuted;
  const a11y = [
    name,
    online ? "online" : null,
    blocked,
    unread ? `${unread} unread ${conversation.unread_count === 1 ? "message" : "messages"}` : null,
    !blocked && preview.text ? `${preview.prefix}${preview.text}` : null,
    !blocked && preview.ticks ? TICK_LABELS[preview.ticks] : null,
    time || null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint="Opens the conversation"
      accessibilityState={{ selected }}
      style={({ pressed }) => [s.row, selected ? s.selected : pressed ? s.pressed : null]}
    >
      <Avatar name={name} id={conversation.user_id} uri={conversation.avatar} size={48} online={online} ringColor={selected ? theme.colors.accentSoft : theme.colors.surface} />
      <View style={s.body}>
        <View style={s.line}>
          <Text style={s.name} numberOfLines={1}>
            {name}
          </Text>
          {time ? <Text style={[s.time, unread ? { color: theme.colors.accent } : null]}>{time}</Text> : null}
        </View>
        <View style={s.line}>
          {blocked ? (
            <View style={s.blockedLine} accessibilityLabel={blocked}>
              <Icon name="ban" size={theme.font.size.small} color={theme.colors.textMuted} />
              <Text style={[s.preview, s.blockedText]} numberOfLines={1}>
                {blocked}
              </Text>
            </View>
          ) : (
          <Text style={[s.preview, { color: previewColor }, preview.italic ? s.italic : null]} numberOfLines={1}>
            {preview.ticks ? (
              <Text style={{ color: preview.ticks === "read" ? theme.colors.accent : theme.colors.textSubtle }}>{TICK_GLYPHS[preview.ticks]} </Text>
            ) : null}
            {preview.prefix}
            {preview.text}
          </Text>
          )}
          {unread ? (
            <View style={s.badge}>
              <Text style={s.badgeText} allowFontScaling={false}>
                {unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        row: {
          height: CONVERSATION_ROW_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.lg,
          backgroundColor: theme.colors.surface,
        },
        pressed: { backgroundColor: theme.colors.surfaceAlt },
        selected: { backgroundColor: theme.colors.accentSoft },
        body: {
          flex: 1,
          marginLeft: theme.space.md,
          height: CONVERSATION_ROW_HEIGHT,
          justifyContent: "center",
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        line: { flexDirection: "row", alignItems: "center" },
        name: { ...textStyle(theme, "title", theme.colors.text, "semibold"), flex: 1, marginRight: theme.space.sm },
        time: textStyle(theme, "caption", theme.colors.textMuted),
        preview: { ...textStyle(theme, "small", theme.colors.textMuted), flex: 1, marginRight: theme.space.sm },
        badge: {
          minWidth: 20,
          height: 20,
          paddingHorizontal: theme.space.xs + theme.space.xxs,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        },
        badgeText: { ...textStyle(theme, "caption", theme.colors.onAccent, "semibold"), lineHeight: 16 },
        blockedLine: { flex: 1, flexDirection: "row", alignItems: "center", marginRight: theme.space.sm },
        blockedText: { marginLeft: theme.space.xs, marginRight: 0 },
        italic: { fontStyle: "italic" },
      }),
    [theme],
  );
