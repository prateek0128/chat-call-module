import { memo, useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import { useReducedMotion, useTheme } from "../theme";

export interface TypingIndicatorProps {
  /** Who is typing (for the accessibility label). */
  name?: string;
}

const CYCLE_MS = 1200;
const STAGGER_MS = 150;

/** Incoming-side bubble with 3 dots: staggered opacity/translateY loop (1.2 s). Static with reduced motion. */
export const TypingIndicator = memo(function TypingIndicator({ name }: TypingIndicatorProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    if (reduced) {
      dots.forEach((d) => d.setValue(1));
      return;
    }
    const half = (CYCLE_MS - STAGGER_MS * 2) / 2;
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * STAGGER_MS),
          Animated.timing(d, { toValue: 1, duration: half, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: half, useNativeDriver: true }),
          Animated.delay((2 - i) * STAGGER_MS),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [reduced, dots]);

  const size = 7;
  return (
    <View
      style={{ flexDirection: "row", paddingHorizontal: theme.space.md, marginTop: theme.space.sm, marginBottom: theme.space.xs }}
      accessible
      accessibilityLabel={name ? `${name} is typing` : "Typing"}
      accessibilityLiveRegion="polite"
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.bubbleIn,
          borderRadius: theme.radius.bubble,
          borderTopLeftRadius: theme.radius.sm,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.md,
        }}
      >
        {dots.map((d, i) => (
          <Animated.View
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              marginHorizontal: theme.space.xxs,
              backgroundColor: theme.colors.textMuted,
              opacity: reduced ? 0.7 : d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
              transform: [{ translateY: reduced ? 0 : d.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
            }}
          />
        ))}
      </View>
    </View>
  );
});
