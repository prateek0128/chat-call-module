import { memo, ReactNode, useCallback, useRef } from "react";
import { Animated, Pressable, type AccessibilityRole, type AccessibilityState, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { useReducedMotion } from "./hooks";
import { slopFor } from "./touch";
import { useTheme } from "./ThemeProvider";

export interface ScalePressableProps {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  /** Expands the touch area to at least `layout.tapTarget` when the visual is smaller. */
  hitSlop?: Insets;
  /** Visual size of the element; used to compute a default hitSlop up to the 44pt target. */
  visualSize?: number;
  style?: StyleProp<ViewStyle>;
  /** Pressed scale (default 0.96 per the motion spec). */
  pressedScale?: number;
  testID?: string;
  children?: ReactNode;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Pressable that scales to 0.96 while pressed (`motion.duration.fast`, native driver; off with reduced motion). */
export const ScalePressable = memo(function ScalePressable({
  onPress,
  onLongPress,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = "button",
  accessibilityState,
  hitSlop,
  visualSize,
  style,
  pressedScale = 0.96,
  testID,
  children,
}: ScalePressableProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = useCallback(
    (v: number) => {
      if (reduced) return scale.setValue(1);
      Animated.timing(scale, { toValue: v, duration: theme.motion.duration.fast, useNativeDriver: true }).start();
    },
    [reduced, scale, theme.motion.duration.fast],
  );
  const slop = hitSlop || slopFor(visualSize, theme.layout.tapTarget);
  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      onPressIn={() => to(pressedScale)}
      onPressOut={() => to(1)}
      hitSlop={slop}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, ...(accessibilityState || {}) }}
      testID={testID}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
});
