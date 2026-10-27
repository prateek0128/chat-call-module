import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { MAX_UPLOAD_BYTES } from "../chat/ChatStore";
import { announce, Icon, ScalePressable, useReducedMotion, useTheme, type Theme } from "../theme";
import { attachmentName, checkAttachmentSize, isImageAttachment, type PickedAttachment } from "./attachments";
import { formatFileSize } from "./format";
import { textStyle } from "./primitives";

export interface AttachmentPreviewSheetProps {
  /** The picked file; null hides the sheet. */
  file: PickedAttachment | null;
  onCancel: () => void;
  /** Upload. Resolve `false` to keep the sheet open (the error is reported by ChatProvider.onError). */
  onSend: (file: PickedAttachment) => Promise<boolean> | boolean | void;
  /** Upload limit (default 10 MB, the server's). */
  maxBytes?: number;
  insetBottom?: number;
}

/** Modal sheet: thumbnail or file card, name, size, Cancel / Send. Checks the size limit before upload. */
export const AttachmentPreviewSheet = memo(function AttachmentPreviewSheet({
  file,
  onCancel,
  onSend,
  maxBytes = MAX_UPLOAD_BYTES,
  insetBottom = 0,
}: AttachmentPreviewSheetProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const reduced = useReducedMotion();
  const [sending, setSending] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const visible = !!file;
  const check = file ? checkAttachmentSize(file.size, maxBytes) : ({ ok: true } as const);
  const error = check.ok ? null : check.message;

  useEffect(() => {
    if (!visible) return;
    setSending(false);
    if (reduced) progress.setValue(1);
    else {
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: theme.motion.duration.base, useNativeDriver: true }).start();
    }
  }, [visible, reduced, progress, theme.motion.duration.base]);

  useEffect(() => {
    if (error) announce(error);
  }, [error]);

  if (!file) return null;
  const name = attachmentName(file);
  const image = isImageAttachment(file);
  const size = formatFileSize(file.size);

  const send = async () => {
    if (error || sending) return;
    setSending(true);
    try {
      const ok = await onSend(file);
      if (ok === false) setSending(false);
    } catch {
      setSending(false);
    }
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onCancel} statusBarTranslucent>
      <Animated.View style={[s.overlay, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel" />
      </Animated.View>
      <Animated.View
        style={[
          s.sheet,
          { paddingBottom: theme.space.lg + insetBottom, opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] },
        ]}
        accessibilityViewIsModal
      >
        <Text style={s.title} accessibilityRole="header">
          Send attachment
        </Text>
        {image ? (
          <Image source={{ uri: file.uri }} style={s.thumb} resizeMode="contain" accessibilityLabel={`Preview of ${name}`} />
        ) : (
          <View style={s.fileCard}>
            <Icon name="file" size={theme.font.size.display} color={theme.colors.textMuted} />
          </View>
        )}
        <Text style={s.name} numberOfLines={2}>
          {name}
        </Text>
        {size ? <Text style={s.size}>{size}</Text> : null}
        {error ? (
          <Text style={s.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={s.buttons}>
          <ScalePressable onPress={onCancel} accessibilityLabel="Cancel" style={[s.button, s.cancel]}>
            <Text style={s.cancelText}>Cancel</Text>
          </ScalePressable>
          <ScalePressable
            onPress={send}
            disabled={!!error || sending}
            accessibilityLabel={`Send ${name}`}
            accessibilityState={{ busy: sending }}
            style={[s.button, { backgroundColor: error ? theme.colors.surfaceSunken : theme.colors.accent }]}
          >
            {sending ? (
              <ActivityIndicator color={theme.colors.onAccent} />
            ) : (
              <Text style={[s.sendText, error ? { color: theme.colors.textSubtle } : null]}>Send</Text>
            )}
          </ScalePressable>
        </View>
      </Animated.View>
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
          alignItems: "center",
        },
        title: { ...textStyle(theme, "title", theme.colors.text, "semibold"), marginBottom: theme.space.md },
        thumb: { width: "100%", height: 220, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceSunken },
        fileCard: {
          width: 96,
          height: 96,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surfaceSunken,
          alignItems: "center",
          justifyContent: "center",
        },
        name: { ...textStyle(theme, "body", theme.colors.text, "medium"), marginTop: theme.space.md, textAlign: "center" },
        size: { ...textStyle(theme, "small", theme.colors.textMuted), marginTop: theme.space.xxs },
        error: { ...textStyle(theme, "small", theme.colors.danger), marginTop: theme.space.sm, textAlign: "center" },
        buttons: { flexDirection: "row", marginTop: theme.space.lg, alignSelf: "stretch" },
        button: {
          flex: 1,
          minHeight: theme.layout.tapTarget,
          borderRadius: theme.radius.md,
          alignItems: "center",
          justifyContent: "center",
          marginHorizontal: theme.space.xs,
        },
        cancel: { backgroundColor: theme.colors.surfaceSunken },
        cancelText: textStyle(theme, "body", theme.colors.text, "semibold"),
        sendText: textStyle(theme, "body", theme.colors.onAccent, "semibold"),
      }),
    [theme],
  );
