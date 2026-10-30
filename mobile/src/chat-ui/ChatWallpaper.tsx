/**
 * Chat background from the user's wallpaper choice (see `useAppearance`).
 * - default: `colors.wallpaper` + a subtle dot pattern (one 16 px PNG tile repeated by the native
 *   image view: a single view, no per-dot views).
 * - solid: one View colour.
 * - gradient: host `renderGradient`, else `expo-linear-gradient` (OPTIONAL peer, lazily required),
 *   else the first stop as a solid colour.
 * - image: <Image resizeMode="cover"> + a dim overlay View; falls back to the base colour on error.
 */
import { slot } from "../theme";
import { memo, ReactNode, useEffect, useState, type ComponentType } from "react";
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { resolveWallpaper, useAppearance, useTheme, type Wallpaper } from "../theme";

export interface GradientRenderProps {
  colors: [string, string];
  start: { x: number; y: number };
  end: { x: number; y: number };
  style: StyleProp<ViewStyle>;
}

export interface ChatWallpaperProps {
  /** Explicit wallpaper (e.g. a preview). Default: the appearance choice for `peerId`. */
  wallpaper?: Wallpaper;
  /** Chat whose override applies (else the global wallpaper). */
  peerId?: string | null;
  /** Draws a gradient (e.g. react-native-linear-gradient). Default: expo-linear-gradient if installed. */
  renderGradient?: (props: GradientRenderProps) => ReactNode;
  /** Dot pattern on the default wallpaper (default true). */
  pattern?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  testID?: string;
}

/** 16x16 transparent PNG with a 2x2 dot, tinted at runtime. */
const DOT_TILE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAF0lEQVR42mNgGAUjAPyH4oEzYBQMCQAAFm4D/Y9nAKEAAAAASUVORK5CYII=";

type LinearGradientComponent = ComponentType<{ colors: string[]; start?: { x: number; y: number }; end?: { x: number; y: number }; style?: StyleProp<ViewStyle> }>;

let linearGradient: LinearGradientComponent | null | undefined;
const resolveLinearGradient = (): LinearGradientComponent | null => {
  if (linearGradient !== undefined) return linearGradient;
  try {
    // Optional peer; enable metro `transformer.allowOptionalDependencies` if it is not installed.
    const mod = require("expo-linear-gradient");
    linearGradient = (mod && mod.LinearGradient) || null;
  } catch {
    linearGradient = null;
  }
  return linearGradient as LinearGradientComponent | null;
};

export const DefaultChatWallpaper = memo(function ChatWallpaper({ wallpaper, peerId, renderGradient, pattern = true, style, children, testID }: ChatWallpaperProps) {
  const theme = useTheme();
  const appearance = useAppearance();
  const chosen = wallpaper ?? appearance.wallpaperFor(peerId);
  const model = resolveWallpaper(chosen, theme.scheme, theme.colors.wallpaper);
  const imageUri = model.kind === "image" ? model.uri : null;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  useEffect(() => setFailedUri(null), [imageUri]);

  let background: ReactNode = null;
  let color: string;
  if (model.kind === "color") {
    color = model.color;
    if (model.pattern && pattern) {
      background = (
        <Image
          source={{ uri: DOT_TILE }}
          resizeMode="repeat"
          style={[StyleSheet.absoluteFill, { tintColor: theme.colors.textSubtle, opacity: theme.scheme === "dark" ? 0.18 : 0.22 }]}
          importantForAccessibility="no-hide-descendants"
          testID="wallpaper-pattern"
        />
      );
    }
  } else if (model.kind === "gradient") {
    color = model.fallbackColor;
    const gProps: GradientRenderProps = { colors: model.colors, start: model.start, end: model.end, style: StyleSheet.absoluteFill };
    if (renderGradient) background = renderGradient(gProps);
    else {
      const LG = resolveLinearGradient();
      if (LG) background = <LG colors={model.colors} start={model.start} end={model.end} style={StyleSheet.absoluteFill} />;
    }
  } else {
    color = model.fallbackColor;
    if (failedUri !== model.uri) {
      background = (
        <>
          <Image
            source={{ uri: model.uri }}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            onError={() => setFailedUri(model.uri)}
            importantForAccessibility="no"
            testID="wallpaper-image"
          />
          {model.overlayOpacity > 0 ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: model.overlayColor, opacity: model.overlayOpacity }]} testID="wallpaper-dim" />
          ) : null}
        </>
      );
    }
  }

  return (
    <View style={[styles.root, style, { backgroundColor: color }]} testID={testID}>
      {background ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none" importantForAccessibility="no-hide-descendants">
          {background}
        </View>
      ) : null}
      {children}
    </View>
  );
});

const styles = StyleSheet.create({ root: { overflow: "hidden" } });

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const ChatWallpaper = slot("ChatWallpaper", DefaultChatWallpaper);
