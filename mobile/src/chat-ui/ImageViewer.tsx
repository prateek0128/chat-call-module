import { slot } from "../theme";
import { memo } from "react";
import { Image, Modal, StyleSheet, Text, View } from "react-native";
import { Icon, ScalePressable, useSafeInsets, useTheme, type EdgeInsets, type Theme } from "../theme";

const actionStyle = (theme: Theme) => ({
  flexDirection: "row" as const,
  alignItems: "center" as const,
  minHeight: theme.layout.tapTarget,
  paddingHorizontal: theme.space.lg,
  marginHorizontal: theme.space.sm,
  borderRadius: theme.radius.pill,
  backgroundColor: theme.colors.callControl,
});

export interface ImageViewerProps {
  /** Image to show; null hides the viewer. */
  uri: string | null;
  onClose: () => void;
  insets?: Partial<EdgeInsets>;
  /** Shows a Download button (ChatScreen: save to gallery via the fileActions adapter, else download). */
  onDownload?: () => void;
  /** Shows a Share button (fileActions adapter). */
  onShare?: () => void;
  /** Download button label (default "Save"). */
  downloadLabel?: string;
}

/** Full-screen image viewer (Modal). Android back / the close button dismiss it. */
export const DefaultImageViewer = memo(function ImageViewer({ uri, onClose, insets, onDownload, onShare, downloadLabel = "Save" }: ImageViewerProps) {
  const theme = useTheme();
  const safe = useSafeInsets(insets);
  if (!uri) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: theme.colors.callBackgroundStart }} accessibilityViewIsModal>
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel="Photo" />
        <ScalePressable
          onPress={onClose}
          accessibilityLabel="Close photo"
          style={{
            position: "absolute",
            top: safe.top + theme.space.sm,
            right: safe.right + theme.space.sm,
            width: theme.layout.tapTarget,
            height: theme.layout.tapTarget,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.callControl,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="close" size={theme.font.size.title} color={theme.colors.callText} />
        </ScalePressable>
        {onDownload || onShare ? (
          <View style={{ position: "absolute", left: 0, right: 0, bottom: safe.bottom + theme.space.lg, flexDirection: "row", justifyContent: "center" }}>
            {onDownload ? (
              <ScalePressable onPress={onDownload} accessibilityLabel={`${downloadLabel} photo`} style={actionStyle(theme)}>
                <Icon name="download" size={theme.font.size.title} color={theme.colors.callText} />
                <Text style={{ color: theme.colors.callText, marginLeft: theme.space.xs, fontSize: theme.font.size.small }}>{downloadLabel}</Text>
              </ScalePressable>
            ) : null}
            {onShare ? (
              <ScalePressable onPress={onShare} accessibilityLabel="Share photo" style={actionStyle(theme)}>
                <Icon name="share" size={theme.font.size.title} color={theme.colors.callText} />
                <Text style={{ color: theme.colors.callText, marginLeft: theme.space.xs, fontSize: theme.font.size.small }}>Share</Text>
              </ScalePressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Modal>
  );
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const ImageViewer = slot("ImageViewer", DefaultImageViewer);
