import { slot } from "../theme";
import { memo, useEffect, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { announce, shadowStyle, useTheme, type Theme } from "../theme";
import { textStyle } from "./primitives";

export interface ToastMessage {
  text: string;
  tone?: "info" | "error";
  /** 0..1 shows a progress bar (downloads). */
  progress?: number | null;
}

export interface ToastProps {
  toast: ToastMessage | null;
  /** Distance from the bottom of the parent. */
  bottom?: number;
}

/** Small status pill (copied, download progress, errors). Announced to screen readers. */
export const DefaultToast = memo(function Toast({ toast, bottom = 0 }: ToastProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const text = toast?.text;
  useEffect(() => {
    if (text) announce(text);
  }, [text]);
  if (!toast) return null;
  const pct = toast.progress != null ? Math.round(Math.max(0, Math.min(1, toast.progress)) * 100) : null;
  return (
    <View pointerEvents="none" style={[s.wrap, { bottom: bottom + theme.space.md }]}>
      <View
        style={[s.toast, shadowStyle(theme, "md"), toast.tone === "error" ? { backgroundColor: theme.colors.danger } : null]}
        accessibilityRole={toast.tone === "error" ? "alert" : "text"}
        accessibilityLiveRegion="polite"
      >
        <Text style={s.text}>{toast.text}</Text>
        {pct != null ? (
          <View style={s.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}>
            <View style={[s.fill, { width: `${pct}%` }]} />
          </View>
        ) : null}
      </View>
    </View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        wrap: { position: "absolute", left: theme.space.lg, right: theme.space.lg, alignItems: "center" },
        toast: {
          maxWidth: 420,
          borderRadius: theme.radius.lg,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm,
          backgroundColor: theme.colors.text,
        },
        text: textStyle(theme, "small", theme.colors.surface, "medium"),
        track: { height: 3, marginTop: theme.space.xs, borderRadius: theme.radius.pill, backgroundColor: theme.colors.overlay, overflow: "hidden" },
        fill: { height: 3, backgroundColor: theme.colors.accent },
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const Toast = slot("Toast", DefaultToast);
