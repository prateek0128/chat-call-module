import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Modal, StyleSheet, Text, View } from "react-native";
import { Icon, ScalePressable, useSafeInsets, useTheme, type EdgeInsets, type Theme } from "../theme";
import { getWebView } from "./optionalPeers";
import { textStyle } from "./primitives";

export interface DocumentViewerModalProps {
  /** File URL to show; null hides the viewer. */
  uri: string | null;
  /** Title (file name). */
  name?: string | null;
  onClose: () => void;
  /**
   * URL the WebView loads for `fileUrl`. Default: the file URL itself (PDFs render natively on iOS;
   * Android WebViews may download instead). An online viewer such as
   * `(u) => "https://docs.google.com/gview?embedded=true&url=" + encodeURIComponent(u)` is an
   * OPT-IN: it sends the file URL to a third party, so only use it for non-private files.
   */
  documentViewerUrl?: (fileUrl: string) => string;
  /** Shows a Share button (ChatScreen wires the fileActions adapter). */
  onShare?: () => void;
  insets?: Partial<EdgeInsets>;
}

/** True when react-native-webview is installed (the in-app viewer is available). */
export const documentViewerAvailable = (): boolean => !!getWebView();

/**
 * In-app document viewer on react-native-webview (optional peer). Without it, opens the file with
 * `Linking.openURL` and closes.
 */
export const DocumentViewerModal = memo(function DocumentViewerModal({ uri, name, onClose, documentViewerUrl, onShare, insets }: DocumentViewerModalProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const safe = useSafeInsets(insets);
  const WebView = getWebView();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFailed(false);
    if (uri && !WebView) {
      void Linking.openURL(uri).catch(() => undefined);
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  if (!uri || !WebView) return null;
  const source = documentViewerUrl ? documentViewerUrl(uri) : uri;
  const openExternally = () => void Linking.openURL(uri).catch(() => undefined);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.screen, { paddingTop: safe.top, paddingBottom: safe.bottom }]} accessibilityViewIsModal>
        <View style={s.bar}>
          <ScalePressable onPress={onClose} accessibilityLabel="Close document" style={s.iconButton}>
            <Icon name="close" size={theme.font.size.title} color={theme.colors.text} />
          </ScalePressable>
          <Text style={s.title} numberOfLines={1} accessibilityRole="header">
            {name || "Document"}
          </Text>
          {onShare ? (
            <ScalePressable onPress={onShare} accessibilityLabel="Share document" style={s.iconButton}>
              <Icon name="share" size={theme.font.size.title} color={theme.colors.accent} />
            </ScalePressable>
          ) : null}
          <ScalePressable onPress={openExternally} accessibilityLabel="Open in another app" style={s.iconButton}>
            <Icon name="download" size={theme.font.size.title} color={theme.colors.accent} />
          </ScalePressable>
        </View>
        <View style={s.fill}>
          {failed ? (
            <View style={s.center}>
              <Text style={s.error}>Couldn't show this document.</Text>
              <ScalePressable onPress={openExternally} accessibilityLabel="Open in another app" style={s.button}>
                <Text style={s.buttonText}>Open in another app</Text>
              </ScalePressable>
            </View>
          ) : (
            <WebView
              source={{ uri: source }}
              style={s.fill}
              originWhitelist={["*"]}
              onLoadEnd={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
            />
          )}
          {loading && !failed ? (
            <View style={[StyleSheet.absoluteFill, s.center]} pointerEvents="none">
              <ActivityIndicator color={theme.colors.textMuted} accessibilityLabel="Loading document" />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface },
        bar: {
          flexDirection: "row",
          alignItems: "center",
          minHeight: 56,
          paddingHorizontal: theme.space.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        title: { ...textStyle(theme, "title", theme.colors.text, "semibold"), flex: 1, marginHorizontal: theme.space.sm },
        iconButton: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.pill,
        },
        fill: { flex: 1 },
        center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
        error: { ...textStyle(theme, "body", theme.colors.textMuted), textAlign: "center" },
        button: { marginTop: theme.space.md, minHeight: theme.layout.tapTarget, justifyContent: "center", paddingHorizontal: theme.space.lg },
        buttonText: textStyle(theme, "body", theme.colors.accent, "semibold"),
      }),
    [theme],
  );
