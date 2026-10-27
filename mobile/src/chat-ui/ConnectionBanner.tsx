import { memo, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ScalePressable, useTheme, withAlpha, type Theme } from "../theme";
import type { ConnectionBannerModel } from "./connection";
import { useConnectionBanner } from "./hooks";
import { textStyle } from "./primitives";

export interface ConnectionBannerViewProps {
  model: ConnectionBannerModel;
  onRetry?: () => void;
}

/** Presentational banner: "Connecting…" (warning tint) / "Offline. Retrying in Ns" + Retry. */
export const ConnectionBannerView = memo(function ConnectionBannerView({ model, onRetry }: ConnectionBannerViewProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  if (!model.visible) return null;
  const tint = model.tone === "danger" ? theme.colors.danger : theme.colors.warning;
  return (
    <View
      style={[s.bar, { backgroundColor: withAlpha(tint, 0.14) }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={model.text}
    >
      <Text style={[s.text, { color: theme.colors.text }]} numberOfLines={1}>
        {model.text}
      </Text>
      {model.showRetry && onRetry ? (
        <ScalePressable onPress={onRetry} accessibilityLabel="Retry connecting now" style={s.retry} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          <Text style={s.retryText}>Retry</Text>
        </ScalePressable>
      ) : null}
    </View>
  );
});

/** Slim bar under the header bound to the shared socket (needs <CommsProvider>). */
export const ConnectionBanner = memo(function ConnectionBanner() {
  const { retry, ...model } = useConnectionBanner();
  return <ConnectionBannerView model={model} onRetry={retry} />;
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        bar: { flexDirection: "row", alignItems: "center", minHeight: 32, paddingHorizontal: theme.space.lg },
        text: { ...textStyle(theme, "small", theme.colors.text, "medium"), flex: 1 },
        retry: { minHeight: 32, justifyContent: "center", paddingHorizontal: theme.space.sm },
        retryText: textStyle(theme, "small", theme.colors.accent, "semibold"),
      }),
    [theme],
  );
