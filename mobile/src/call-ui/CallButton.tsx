import { memo, useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import { Icon, ScalePressable, useReducedMotion, useTheme, type IconName } from "../theme";

export type CallButtonVariant = "control" | "accept" | "hangup";

export interface CallButtonProps {
  icon: IconName;
  /** Visible caption under the button. */
  caption?: string;
  /** Screen-reader label ("Mute microphone"). */
  accessibilityLabel: string;
  onPress: () => void;
  variant?: CallButtonVariant;
  /** Toggle state (Mute / Speaker): filled light background when on. */
  active?: boolean;
  /** Toggle buttons report `checked` to screen readers. */
  toggle?: boolean;
  /** Gentle repeating bounce (incoming Accept). Off with reduced motion. */
  bounce?: boolean;
  disabled?: boolean;
  size?: number;
}

/** Round, labelled call control with press scale (0.96). */
export const CallButton = memo(function CallButton({
  icon,
  caption,
  accessibilityLabel,
  onPress,
  variant = "control",
  active = false,
  toggle = false,
  bounce = false,
  disabled = false,
  size = 64,
}: CallButtonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!bounce || reduced) {
      lift.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(lift, { toValue: 1, duration: theme.motion.duration.slow, useNativeDriver: true }),
        Animated.timing(lift, { toValue: 0, duration: theme.motion.duration.slow, useNativeDriver: true }),
        Animated.delay(theme.motion.duration.slow * 2),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bounce, reduced, lift, theme.motion.duration.slow]);

  const bg =
    variant === "accept"
      ? theme.colors.callAccept
      : variant === "hangup"
        ? theme.colors.callHangup
        : active
          ? theme.colors.callControlActive
          : theme.colors.callControl;
  const fg = variant === "control" && active ? theme.colors.callBackgroundStart : theme.colors.callText;

  return (
    <View style={{ alignItems: "center", marginHorizontal: theme.space.md }}>
      <Animated.View style={{ transform: [{ translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] }}>
        <ScalePressable
          onPress={onPress}
          disabled={disabled}
          accessibilityLabel={accessibilityLabel}
          accessibilityState={toggle ? { checked: active } : undefined}
          accessibilityRole={toggle ? "switch" : "button"}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: bg,
            alignItems: "center",
            justifyContent: "center",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Icon name={icon} size={Math.round(size * 0.4)} color={fg} />
        </ScalePressable>
      </Animated.View>
      {caption ? (
        <Text
          style={{
            marginTop: theme.space.sm,
            fontSize: theme.font.size.caption,
            color: theme.colors.callTextMuted,
            fontFamily: theme.font.nativeFamily,
          }}
          importantForAccessibility="no"
          accessible={false}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
});
