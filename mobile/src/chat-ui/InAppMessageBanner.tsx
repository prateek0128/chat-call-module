import { slot } from "../theme";
import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { ChatMessage } from "../chat/types";
import { announce, Avatar, Icon, ScalePressable, shadowStyle, useReducedMotion, useSafeInsets, useTheme, type EdgeInsets, type Theme } from "../theme";
import { SwipeUpToDismiss } from "./gestures";
import { useInAppBanner, useMessageSound, type UseInAppBannerOptions } from "./hooks";
import type { SoundSource } from "./messageSound";
import { textStyle } from "./primitives";

export interface InAppMessageBannerProps extends UseInAppBannerOptions {
  /** Tap on the banner: open that chat (e.g. `navigation.navigate("Chat", { peerId, chatId })`). */
  onOpenChat: (peerId: string, chatId: ChatMessage["chat_id"], message: ChatMessage) => void;
  /** Explicit insets; otherwise react-native-safe-area-context (optional) or zero. */
  insets?: Partial<EdgeInsets>;
  /** Swipe up to dismiss (needs react-native-gesture-handler). Default true. */
  swipeToDismiss?: boolean;
  /** New-message sound played with the banner (expo-audio / expo-av; silent without either). */
  soundSource?: SoundSource | null;
  /** Host mute setting for the sound. */
  soundMuted?: boolean;
}

/**
 * Top banner for new messages in chats other than the open one (avatar, name, text).
 * Tap opens the chat, swipe up / ✕ / 4 s dismisses it. Mount it ONCE near the app root,
 * inside <ChatProvider> (and <ThemeProvider>), above your navigator so it overlays every screen.
 */
export const DefaultInAppMessageBanner = memo(function InAppMessageBanner({ onOpenChat, insets, swipeToDismiss = true, soundSource, soundMuted, ...options }: InAppMessageBannerProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const safe = useSafeInsets(insets);
  const reduced = useReducedMotion();
  const { banner, dismiss } = useInAppBanner(options);
  useMessageSound({ source: soundSource, muted: soundMuted, enabled: options.enabled, activePeerId: options.activePeerId });
  const progress = useRef(new Animated.Value(0)).current;
  const key = banner?.key;

  useEffect(() => {
    if (!key) return;
    if (reduced) progress.setValue(1);
    else {
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: theme.motion.duration.base, useNativeDriver: true }).start();
    }
  }, [key, reduced, progress, theme.motion.duration.base]);

  useEffect(() => {
    if (banner) announce(`New message from ${banner.name}: ${banner.text}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!banner) return null;
  const open = () => {
    dismiss();
    onOpenChat(banner.peerId, banner.chatId, banner.message);
  };
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        s.wrap,
        { top: safe.top + theme.space.sm, left: safe.left + theme.space.md, right: safe.right + theme.space.md },
        { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }] },
      ]}
    >
      <SwipeUpToDismiss enabled={swipeToDismiss} onDismiss={dismiss}>
        <View style={[s.card, shadowStyle(theme, "md")]} accessibilityLiveRegion="polite">
          <ScalePressable onPress={open} accessibilityLabel={`New message from ${banner.name}: ${banner.text}`} accessibilityHint="Opens the chat" style={s.main}>
            <Avatar name={banner.name} id={banner.peerId} uri={banner.avatar} size={40} />
            <View style={s.text}>
              <Text style={s.name} numberOfLines={1}>
                {banner.name}
              </Text>
              <Text style={s.body} numberOfLines={2}>
                {banner.text}
              </Text>
            </View>
          </ScalePressable>
          <ScalePressable onPress={dismiss} accessibilityLabel="Dismiss notification" style={s.close}>
            <Icon name="close" size={theme.font.size.body} color={theme.colors.textMuted} />
          </ScalePressable>
        </View>
      </SwipeUpToDismiss>
    </Animated.View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        wrap: { position: "absolute", zIndex: 1000, alignItems: "center" },
        card: {
          flexDirection: "row",
          alignItems: "center",
          maxWidth: 560,
          width: "100%",
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          paddingLeft: theme.space.md,
        },
        main: { flex: 1, flexDirection: "row", alignItems: "center", paddingVertical: theme.space.sm, minHeight: theme.layout.tapTarget },
        text: { marginLeft: theme.space.md, flexShrink: 1 },
        name: textStyle(theme, "body", theme.colors.text, "semibold"),
        body: textStyle(theme, "small", theme.colors.textMuted),
        close: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.pill,
        },
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const InAppMessageBanner = slot("InAppMessageBanner", DefaultInAppMessageBanner);
