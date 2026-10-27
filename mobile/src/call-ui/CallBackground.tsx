import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { gradientStops, useTheme } from "../theme";

export interface CallBackgroundProps {
  /** Number of colour bands (default 16). More bands = smoother, more views. */
  steps?: number;
}

/**
 * Vertical `callBackgroundStart` -> `callBackgroundEnd` gradient without native deps: stacked
 * bands of interpolated colour. Pass `renderBackground` to CallScreen / CallOverlay to use
 * expo-linear-gradient (or anything else) instead.
 */
export const CallBackground = memo(function CallBackground({ steps = 16 }: CallBackgroundProps) {
  const theme = useTheme();
  const colors = useMemo(
    () => gradientStops(theme.colors.callBackgroundStart, theme.colors.callBackgroundEnd, steps),
    [theme.colors.callBackgroundStart, theme.colors.callBackgroundEnd, steps],
  );
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {colors.map((c, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: c }} />
      ))}
    </View>
  );
});
