import { memo, useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ScalePressable, shadowStyle, useTheme, type Theme } from "../theme";
import { textStyle } from "./primitives";

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirm in the danger colour (Clear chat, Delete). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small centred confirm dialog (themeable; no native Alert). */
export const ConfirmDialog = memo(function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={s.center}>
        <Pressable style={s.overlay} onPress={onCancel} accessibilityRole="button" accessibilityLabel={cancelLabel} />
        <View style={[s.card, shadowStyle(theme, "lg")]} accessibilityViewIsModal accessibilityRole="alert">
          <Text style={s.title} accessibilityRole="header">
            {title}
          </Text>
          {message ? <Text style={s.message}>{message}</Text> : null}
          <View style={s.buttons}>
            <ScalePressable onPress={onCancel} accessibilityLabel={cancelLabel} style={s.button}>
              <Text style={s.cancel}>{cancelLabel}</Text>
            </ScalePressable>
            <ScalePressable onPress={onConfirm} accessibilityLabel={confirmLabel} style={s.button}>
              <Text style={[s.confirm, destructive ? { color: theme.colors.danger } : null]}>{confirmLabel}</Text>
            </ScalePressable>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
        overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.overlay },
        card: { width: "100%", maxWidth: 360, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.space.lg },
        title: textStyle(theme, "title", theme.colors.text, "semibold"),
        message: { ...textStyle(theme, "body", theme.colors.textMuted), marginTop: theme.space.sm },
        buttons: { flexDirection: "row", justifyContent: "flex-end", marginTop: theme.space.lg },
        button: { minHeight: theme.layout.tapTarget, justifyContent: "center", paddingHorizontal: theme.space.md, marginLeft: theme.space.sm },
        cancel: textStyle(theme, "body", theme.colors.textMuted, "semibold"),
        confirm: textStyle(theme, "body", theme.colors.accent, "semibold"),
      }),
    [theme],
  );
