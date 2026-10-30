/**
 * Gesture wrappers on the optional react-native-gesture-handler (v2, lazily loaded through
 * optionalPeers.ts). Without it (or with `enabled={false}`) they render their children as-is:
 * reply stays available from the long-press menu / screen-reader action, and the banner keeps
 * its close button. Gestures run their callbacks on the JS thread (no reanimated needed).
 * The host app must be wrapped in RNGH's <GestureHandlerRootView>.
 */
import { slot } from "../theme";
import React, { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Text, View } from "react-native";
import { useReducedMotion, useTheme } from "../theme";
import { shouldTriggerReply, swipeReplyOffset, SWIPE_REPLY_THRESHOLD } from "./messageActions";
import { getGestureHandler, hapticTick } from "./optionalPeers";
import { textStyle } from "./primitives";

/** True when react-native-gesture-handler is installed (swipe gestures available). */
export const gesturesAvailable = (): boolean => !!getGestureHandler();

export interface SwipeToReplyProps {
  enabled?: boolean;
  onReply: () => void;
  children: React.ReactNode;
}

/** Swipe a bubble right to reply: the bubble follows the finger, a ↩ hint fades in, haptic tick at the threshold. */
export const DefaultSwipeToReply = memo(function SwipeToReply({ enabled = true, onReply, children }: SwipeToReplyProps) {
  const RNGH = enabled ? getGestureHandler() : null;
  if (!RNGH) return <>{children}</>;
  return (
    <SwipeToReplyInner RNGH={RNGH} onReply={onReply}>
      {children}
    </SwipeToReplyInner>
  );
});

const SwipeToReplyInner = ({ RNGH, onReply, children }: { RNGH: any; onReply: () => void; children: React.ReactNode }) => {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const tx = useRef(new Animated.Value(0)).current;
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const crossed = useRef(false);

  const gesture = useMemo(() => {
    const settle = () => {
      if (reduced) tx.setValue(0);
      else Animated.timing(tx, { toValue: 0, duration: theme.motion.duration.fast, useNativeDriver: true }).start();
    };
    return RNGH.Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX(12)
      .failOffsetX(-12)
      .failOffsetY([-14, 14])
      .onUpdate((e: { translationX: number }) => {
        tx.setValue(swipeReplyOffset(e.translationX));
        const over = shouldTriggerReply(e.translationX);
        if (over && !crossed.current) hapticTick();
        crossed.current = over;
      })
      .onEnd((e: { translationX: number }) => {
        if (shouldTriggerReply(e.translationX)) onReplyRef.current();
      })
      .onFinalize(() => {
        crossed.current = false;
        settle();
      });
  }, [RNGH, tx, reduced, theme.motion.duration.fast]);

  const { GestureDetector } = RNGH;
  return (
    <GestureDetector gesture={gesture}>
      <View>
        <Animated.View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            left: theme.space.md,
            top: 0,
            bottom: 0,
            justifyContent: "center",
            opacity: tx.interpolate({ inputRange: [0, SWIPE_REPLY_THRESHOLD], outputRange: [0, 1], extrapolate: "clamp" }),
          }}
        >
          <Text style={textStyle(theme, "title", theme.colors.textMuted)}>↩</Text>
        </Animated.View>
        <Animated.View style={{ transform: [{ translateX: tx }] }}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
};

export interface SwipeUpToDismissProps {
  enabled?: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}

/** Fling / drag a banner up to dismiss it (no-op wrapper without gesture handler). */
export const DefaultSwipeUpToDismiss = memo(function SwipeUpToDismiss({ enabled = true, onDismiss, children }: SwipeUpToDismissProps) {
  const RNGH = enabled ? getGestureHandler() : null;
  const ref = useRef(onDismiss);
  ref.current = onDismiss;
  const ty = useRef(new Animated.Value(0)).current;
  useEffect(() => () => ty.setValue(0), [ty]);
  const gesture = useMemo(
    () =>
      RNGH
        ? RNGH.Gesture.Pan()
            .runOnJS(true)
            .activeOffsetY(-8)
            .onUpdate((e: { translationY: number }) => ty.setValue(Math.min(0, e.translationY)))
            .onEnd((e: { translationY: number; velocityY?: number }) => {
              if (e.translationY < -24 || (e.velocityY ?? 0) < -500) ref.current();
              ty.setValue(0);
            })
        : null,
    [RNGH, ty],
  );
  if (!RNGH || !gesture) return <>{children}</>;
  const { GestureDetector } = RNGH;
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={{ transform: [{ translateY: ty }] }}>{children}</Animated.View>
    </GestureDetector>
  );
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const SwipeToReply = slot("SwipeToReply", DefaultSwipeToReply);
export const SwipeUpToDismiss = slot("SwipeUpToDismiss", DefaultSwipeUpToDismiss);
