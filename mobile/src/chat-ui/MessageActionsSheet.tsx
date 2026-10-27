import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text } from "react-native";
import type { ChatMessage } from "../chat/types";
import { Icon, ScalePressable, useReducedMotion, useTheme, type Theme } from "../theme";
import type { MessageAction } from "./messageActions";
import { replySnippet } from "./messageActions";
import { textStyle } from "./primitives";

export interface MessageActionsSheetProps {
  /** The long-pressed message; null hides the sheet. */
  message: ChatMessage | null;
  /** Items to show (see `messageActionList`). */
  actions: readonly MessageAction[];
  onSelect: (action: MessageAction, message: ChatMessage) => void;
  onClose: () => void;
  insetBottom?: number;
}

/** Bottom sheet for a long-pressed message: a one-line preview, then the actions. */
export const MessageActionsSheet = memo(function MessageActionsSheet({ message, actions, onSelect, onClose, insetBottom = 0 }: MessageActionsSheetProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const visible = !!message;

  useEffect(() => {
    if (!visible) return;
    if (reduced) progress.setValue(1);
    else {
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: theme.motion.duration.base, useNativeDriver: true }).start();
    }
  }, [visible, reduced, progress, theme.motion.duration.base]);

  if (!message) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[s.overlay, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close message actions" />
      </Animated.View>
      <Animated.View
        style={[
          s.sheet,
          { paddingBottom: theme.space.md + insetBottom, opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] },
        ]}
        accessibilityViewIsModal
        accessibilityRole="menu"
        accessibilityLabel="Message actions"
      >
        <Text style={s.preview} numberOfLines={2}>
          {replySnippet(message, 160)}
        </Text>
        {actions.map((a) => (
          <ScalePressable
            key={a.key}
            onPress={() => onSelect(a, message)}
            accessibilityRole="menuitem"
            accessibilityLabel={a.label}
            style={s.row}
          >
            {a.icon ? <Icon name={a.icon} size={theme.font.size.heading} color={a.destructive ? theme.colors.danger : theme.colors.textMuted} /> : null}
            <Text style={[s.label, a.icon ? { marginLeft: theme.space.md } : null, a.destructive ? { color: theme.colors.danger } : null]}>{a.label}</Text>
          </ScalePressable>
        ))}
        <ScalePressable onPress={onClose} accessibilityLabel="Cancel" style={[s.row, s.cancel]}>
          <Text style={[s.label, s.cancelText]}>Cancel</Text>
        </ScalePressable>
      </Animated.View>
    </Modal>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.overlay },
        sheet: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingTop: theme.space.md,
          paddingHorizontal: theme.space.md,
        },
        preview: {
          ...textStyle(theme, "small", theme.colors.textMuted),
          paddingHorizontal: theme.space.sm,
          paddingBottom: theme.space.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
          marginBottom: theme.space.xs,
        },
        row: {
          flexDirection: "row",
          alignItems: "center",
          minHeight: theme.layout.tapTarget + theme.space.xs,
          paddingHorizontal: theme.space.sm,
          borderRadius: theme.radius.md,
        },
        label: textStyle(theme, "body", theme.colors.text, "medium"),
        cancel: { justifyContent: "center", marginTop: theme.space.xs, backgroundColor: theme.colors.surfaceSunken },
        cancelText: { textAlign: "center", flex: 1 },
      }),
    [theme],
  );
