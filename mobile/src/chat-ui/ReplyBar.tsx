import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { announce, Icon, ScalePressable, useReducedMotion, useTheme, type Theme } from "../theme";
import { textStyle } from "./primitives";

export interface ReplyBarProps {
  /** "You" or the peer's name. */
  senderName: string;
  /** One-line preview (see `replySnippet`). */
  snippet: string;
  onCancel: () => void;
}

/** "Replying to {sender}: {snippet}" strip above the composer, with a cancel ✕. */
export const ReplyBar = memo(function ReplyBar({ senderName, snippet, onCancel }: ReplyBarProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    announce(`Replying to ${senderName}`);
    if (reduced) progress.setValue(1);
    else {
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: theme.motion.duration.fast, useNativeDriver: true }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderName, snippet]);
  return (
    <Animated.View
      style={[s.bar, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}
      accessibilityLabel={`Replying to ${senderName}: ${snippet}`}
    >
      <View style={s.quote}>
        <Text style={s.sender} numberOfLines={1}>
          {senderName}
        </Text>
        <Text style={s.snippet} numberOfLines={1}>
          {snippet}
        </Text>
      </View>
      <ScalePressable onPress={onCancel} accessibilityLabel="Cancel reply" style={s.cancel}>
        <Icon name="close" size={theme.font.size.body} color={theme.colors.textMuted} />
      </ScalePressable>
    </Animated.View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        bar: {
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: theme.space.md,
          paddingRight: theme.space.xs,
          paddingTop: theme.space.sm,
          backgroundColor: theme.colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.colors.border,
        },
        quote: {
          flex: 1,
          borderLeftWidth: 3,
          borderLeftColor: theme.colors.accent,
          borderRadius: theme.radius.sm,
          backgroundColor: theme.colors.surfaceSunken,
          paddingHorizontal: theme.space.sm,
          paddingVertical: theme.space.xs,
        },
        sender: textStyle(theme, "small", theme.colors.accent, "semibold"),
        snippet: textStyle(theme, "small", theme.colors.textMuted),
        cancel: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.pill,
        },
      }),
    [theme],
  );
