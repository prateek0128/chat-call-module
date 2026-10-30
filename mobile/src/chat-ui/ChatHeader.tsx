import { slot } from "../theme";
import { memo, ReactNode, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Avatar, Icon, ScalePressable, shadowStyle, useTheme, type Theme } from "../theme";
import type { ClockFormat } from "./format";
import { useSharedTicker } from "./hooks";
import { headerStatus } from "./lastSeen";
import { textStyle } from "./primitives";

export interface ChatHeaderActionsContext {
  peerId: string;
  name: string;
}

export interface ChatHeaderMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface ChatHeaderProps {
  peerId: string;
  name: string;
  avatarUri?: string | null;
  /** Presence status from the conversation ("online", "offline", "away"). */
  status?: string | null;
  typing?: boolean;
  /** Shows the back button (single-pane layout). */
  onBack?: () => void;
  /**
   * Shows a call button. chat-ui never imports call: in combined mode the host passes
   * `onCall={(peerId) => startCall(peerId)}` from `useCall()`.
   */
  onCall?: (peerId: string) => void;
  /** Extra / replacement actions on the right (rendered before the call button). */
  renderActions?: (ctx: ChatHeaderActionsContext) => ReactNode;
  /** Tap on the name/avatar (e.g. open a profile). */
  onPressTitle?: () => void;
  /** Top safe-area inset. */
  insetTop?: number;
  /** Adds "Wallpaper" to the overflow (more) menu; open an <AppearanceSheet peerId={peerId}> from it. */
  onOpenAppearance?: () => void;
  /** Extra overflow-menu items (the more button shows when there is at least one item). */
  menuItems?: ChatHeaderMenuItem[];
  /** Peer's last seen (naive UTC ISO is fine): "last seen 5 min ago" when not online. */
  lastSeen?: string | null;
  /** I blocked them: "Blocked", no online dot, no call action. */
  isBlocked?: boolean;
  /** They blocked me: "You are blocked", no online dot, no call action. */
  blockedByOther?: boolean;
  /** 12h (default) or 24h clock for "today at 6:02 PM". */
  clock?: ClockFormat;
}

const HEADER_HEIGHT = 56;

export const DefaultChatHeader = memo(function ChatHeader({
  peerId,
  name,
  avatarUri,
  status,
  typing = false,
  onBack,
  onCall,
  renderActions,
  onPressTitle,
  insetTop = 0,
  onOpenAppearance,
  menuItems,
  lastSeen,
  isBlocked = false,
  blockedByOther = false,
  clock,
}: ChatHeaderProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  // One shared 60 s interval re-renders every "last seen N min ago" on screen.
  const showsLastSeen = !!lastSeen && status !== "online" && !isBlocked && !blockedByOther;
  useSharedTicker(60000, showsLastSeen);
  const presence = headerStatus({ typing, status, lastSeen, isBlocked, blockedByOther, clock, now: new Date() });
  // "online" stays muted: the success green is below 4.5:1 on surfaces at caption size.
  const presenceColor = presence.tone === "accent" ? theme.colors.accent : theme.colors.textMuted;
  const iconSize = theme.font.size.heading;
  const [menuOpen, setMenuOpen] = useState(false);
  const items: ChatHeaderMenuItem[] = [...(onOpenAppearance ? [{ label: "Wallpaper", onPress: onOpenAppearance }] : []), ...(menuItems || [])];

  const title = (
    <View style={s.titleRow}>
      <Avatar name={name} id={peerId} uri={avatarUri} size={40} online={presence.showOnlineDot} />
      <View style={s.titleText}>
        <Text style={s.name} numberOfLines={1} accessibilityRole="header">
          {name}
        </Text>
        <Text style={[s.subtitle, { color: presenceColor }]} numberOfLines={1} accessibilityLiveRegion="polite">
          {presence.text}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[s.bar, { paddingTop: insetTop, height: HEADER_HEIGHT + insetTop }]}>
      {onBack ? (
        <ScalePressable onPress={onBack} accessibilityLabel="Back" style={s.iconButton}>
          <Icon name="back" size={iconSize + 6} color={theme.colors.accent} />
        </ScalePressable>
      ) : (
        <View style={{ width: theme.space.lg }} />
      )}
      {onPressTitle ? (
        <Pressable
          style={s.titlePress}
          onPress={onPressTitle}
          accessibilityRole="button"
          accessibilityLabel={`${name}, ${presence.text}`}
          accessibilityHint="Shows contact details"
        >
          {title}
        </Pressable>
      ) : (
        <View style={s.titlePress} accessible accessibilityLabel={`${name}, ${presence.text}`}>
          {title}
        </View>
      )}
      <View style={s.actions}>
        {renderActions ? renderActions({ peerId, name }) : null}
        {onCall && presence.canCall ? (
          <ScalePressable onPress={() => onCall(peerId)} accessibilityLabel={`Call ${name}`} style={s.iconButton}>
            <Icon name="call" size={iconSize} color={theme.colors.accent} />
          </ScalePressable>
        ) : null}
        {items.length ? (
          <ScalePressable onPress={() => setMenuOpen(true)} accessibilityLabel="More options" style={s.iconButton}>
            <Icon name="more" size={iconSize} color={theme.colors.accent} />
          </ScalePressable>
        ) : null}
      </View>
      {items.length && menuOpen ? (
        <Modal visible transparent animationType="none" onRequestClose={() => setMenuOpen(false)}>
          <Pressable style={s.menuBackdrop} onPress={() => setMenuOpen(false)} accessibilityRole="button" accessibilityLabel="Close menu">
            <View style={[s.menu, { marginTop: insetTop + HEADER_HEIGHT - theme.space.sm }, shadowStyle(theme, "lg")]} accessibilityRole="menu">
              {items.map((item) => (
                <Pressable
                  key={item.label}
                  style={s.menuItem}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  onPress={() => {
                    setMenuOpen(false);
                    item.onPress();
                  }}
                >
                  <Text style={[s.menuText, item.destructive && { color: theme.colors.danger }]}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        bar: {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.surface,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
          paddingRight: theme.space.xs,
        },
        iconButton: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.pill,
        },
        titlePress: { flex: 1, minHeight: theme.layout.tapTarget, justifyContent: "center" },
        titleRow: { flexDirection: "row", alignItems: "center" },
        titleText: { flex: 1, marginLeft: theme.space.md },
        name: textStyle(theme, "title", theme.colors.text, "semibold"),
        subtitle: textStyle(theme, "caption", theme.colors.textMuted),
        actions: { flexDirection: "row", alignItems: "center" },
        menuBackdrop: { flex: 1, alignItems: "flex-end", paddingRight: theme.space.sm },
        menu: { minWidth: 180, backgroundColor: theme.colors.surface, borderRadius: theme.radius.md, paddingVertical: theme.space.xs },
        menuItem: { minHeight: theme.layout.tapTarget, justifyContent: "center", paddingHorizontal: theme.space.lg },
        menuText: textStyle(theme, "body", theme.colors.text),
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const ChatHeader = slot("ChatHeader", DefaultChatHeader);
