/** Theme-level hooks: reduced motion, responsive layout. */
import { useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, useWindowDimensions } from "react-native";
import { decideLayout, type LayoutDecision } from "./layout";
import { useTheme } from "./ThemeProvider";

/** OS "reduce motion" setting, live. Animations become instant and loops stop when true. */
export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => mounted && setReduced(!!v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => setReduced(!!v));
    return () => {
      mounted = false;
      sub?.remove();
    };
  }, []);
  return reduced;
};

/** Single vs split pane for the current window width (uses the theme's breakpoints). */
export const useResponsiveLayout = (): LayoutDecision & { width: number; height: number } => {
  const { width, height } = useWindowDimensions();
  const theme = useTheme();
  return useMemo(() => ({ ...decideLayout(width, theme.layout), width, height }), [width, height, theme.layout]);
};

/** Announce text to screen readers (iOS VoiceOver / Android TalkBack). No-op on failure. */
export const announce = (message: string): void => {
  if (!message) return;
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // not available (tests / web)
  }
};
