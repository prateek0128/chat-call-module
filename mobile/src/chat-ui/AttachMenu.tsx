import { slot } from "../theme";
import { memo, useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, ScalePressable, useTheme, type Theme } from "../theme";
import type { PickedAttachment } from "./attachments";
import type { AttachPicker } from "./pickers";
import { textStyle } from "./primitives";

export interface AttachMenuProps {
  visible: boolean;
  /** Items, in order (host-defined, or `createExpoPickers()`). */
  pickers: readonly AttachPicker[];
  /** A picker resolved a file (ChatScreen opens the preview sheet). */
  onPicked: (file: PickedAttachment, picker: AttachPicker) => void;
  onClose: () => void;
  /** A picker threw (permission, module error). */
  onError?: (error: unknown, picker: AttachPicker) => void;
  insetBottom?: number;
  title?: string;
}

/** Bottom sheet with one tile per picker (Photo, Camera, Video, Record video, Document, custom…). */
export const DefaultAttachMenu = memo(function AttachMenu({ visible, pickers, onPicked, onClose, onError, insetBottom = 0, title = "Send" }: AttachMenuProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  if (!visible) return null;
  const run = async (p: AttachPicker) => {
    onClose();
    try {
      const file = await p.pick();
      if (file) onPicked(file, p);
    } catch (e) {
      onError?.(e, p);
    }
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={s.overlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close attach menu" />
      <View style={[s.sheet, { paddingBottom: theme.space.lg + insetBottom }]} accessibilityViewIsModal accessibilityRole="menu" accessibilityLabel="Attach">
        <Text style={s.title} accessibilityRole="header">
          {title}
        </Text>
        <View style={s.grid}>
          {pickers.map((p) => (
            <ScalePressable key={p.key} onPress={() => void run(p)} accessibilityRole="menuitem" accessibilityLabel={p.label} style={s.tile}>
              <View style={s.iconWrap}>
                <Icon name={p.icon || "attach"} size={theme.font.size.heading} color={theme.colors.accent} />
              </View>
              <Text style={s.label} numberOfLines={2}>
                {p.label}
              </Text>
            </ScalePressable>
          ))}
        </View>
      </View>
    </Modal>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.overlay },
        sheet: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingTop: theme.space.lg,
          paddingHorizontal: theme.space.lg,
        },
        title: { ...textStyle(theme, "title", theme.colors.text, "semibold"), marginBottom: theme.space.md },
        grid: { flexDirection: "row", flexWrap: "wrap" },
        tile: { width: "25%", alignItems: "center", marginBottom: theme.space.lg, minHeight: theme.layout.tapTarget },
        iconWrap: {
          width: 52,
          height: 52,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accentSoft,
          alignItems: "center",
          justifyContent: "center",
        },
        label: { ...textStyle(theme, "caption", theme.colors.textMuted, "medium"), marginTop: theme.space.xs, textAlign: "center" },
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const AttachMenu = slot("AttachMenu", DefaultAttachMenu);
