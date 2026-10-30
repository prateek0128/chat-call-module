import { slot } from "../theme";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from "react-native";
import type { ChatMessage } from "../chat/types";
import { announce, Icon, ScalePressable, shadowStyle, useReducedMotion, useTheme, type Theme, type Wallpaper } from "../theme";
import { ChatWallpaper, type GradientRenderProps } from "./ChatWallpaper";
import type { ClockFormat } from "./format";
import { formatUnreadBadge } from "./format";
import { buildMessageRows, messageKey, type MessageListRow } from "./grouping";
import { MessageBubble } from "./MessageBubble";
import { SkeletonBox, textStyle } from "./primitives";
import { createStickyLabelController, stickyDateLabel, stickyFadeDuration } from "./stickyDate";
import { TypingIndicator } from "./TypingIndicator";

export interface MessageListProps {
  /** Newest first (as `useConversation().messages`). */
  messages: ChatMessage[];
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  typing?: boolean;
  /** Called when the user scrolls to the oldest loaded message. */
  onLoadMore?: () => void;
  peerName?: string;
  /** Max bubble width in px. */
  bubbleMaxWidth?: number;
  onOpenImage?: (uri: string, message: ChatMessage) => void;
  onOpenFile?: (message: ChatMessage) => void;
  onCallBack?: (message: ChatMessage) => void;
  onLongPressMessage?: (message: ChatMessage) => void;
  /** Inline error banner with Retry (e.g. history failed to load). */
  error?: { message: string; onRetry?: () => void } | null;
  emptyText?: string;
  clock?: ClockFormat;
  /** Chat whose wallpaper override applies (else the global wallpaper from useAppearance). */
  peerId?: string | null;
  /** Explicit wallpaper (wins over the appearance choice). */
  wallpaper?: Wallpaper;
  /** Gradient renderer for gradient wallpapers (default: expo-linear-gradient if installed). */
  renderGradient?: (props: GradientRenderProps) => React.ReactNode;
  /** Reply to a message (swipe right / screen-reader action on bubbles). */
  onReplyMessage?: (message: ChatMessage) => void;
  /** Swipe-right-to-reply (needs react-native-gesture-handler). Default true. */
  swipeToReply?: boolean;
  /** Tap on a video bubble. Default: `onOpenFile`. */
  onOpenVideo?: (message: ChatMessage) => void;
  /**
   * Tap on a quote whose original is not loaded. Default: announces "Original message isn't loaded".
   * Loaded originals are scrolled to and briefly highlighted.
   */
  onQuoteNotLoaded?: (replyToId: ChatMessage["id"], message: ChatMessage) => void;
  /** How long a jumped-to message stays highlighted (ms, default 1600). */
  highlightMs?: number;
  /** Retry a failed send (bubble shows "Not sent. Tap to retry"). */
  onRetryMessage?: (message: ChatMessage) => void;
  /** Floating day label at the top while scrolling (fades 1.5 s after scrolling stops). Default true. */
  stickyDateLabel?: boolean;
}

const keyExtractor = (row: MessageListRow) => row.key;
const VIEWABILITY = { itemVisiblePercentThreshold: 10 };

/**
 * Inverted FlatList (newest at the bottom). Older pages load on `onEndReached` (= top) and
 * keep their position by inversion. A jump-to-latest button appears after scrolling up more
 * than one screen and counts new incoming messages.
 */
export const DefaultMessageList = memo(function MessageList({
  messages,
  loading = false,
  loadingMore = false,
  hasMore = false,
  typing = false,
  onLoadMore,
  peerName,
  bubbleMaxWidth,
  onOpenImage,
  onOpenFile,
  onCallBack,
  onLongPressMessage,
  error,
  emptyText = "Say hi 👋",
  clock,
  peerId,
  wallpaper,
  renderGradient,
  onReplyMessage,
  swipeToReply = true,
  onOpenVideo,
  onQuoteNotLoaded,
  highlightMs = 1600,
  onRetryMessage,
  stickyDateLabel: stickyEnabled = true,
}: MessageListProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const reduced = useReducedMotion();
  const { height: windowHeight } = useWindowDimensions();
  const listRef = useRef<FlatList<MessageListRow>>(null);
  const rows = useMemo(() => buildMessageRows(messages), [messages]);
  const rowsRef = useRef(rows);

  // ---- new-message entrance animation + jump-to-latest counter --------------
  const newestId = messages.length ? String(messages[0].id) : null;
  const renderedNewestRef = useRef<string | null>(null);
  const countedNewestRef = useRef<string | null>(null);
  const animateKeysRef = useRef<Set<string>>(new Set());
  const awayRef = useRef(false);
  const [away, setAway] = useState(false);
  const [newCount, setNewCount] = useState(0);
  // Mark during render so the new row animates on its first mount.
  if (newestId !== renderedNewestRef.current) {
    const previous = renderedNewestRef.current;
    renderedNewestRef.current = newestId;
    // temp_* -> server id is the same message being confirmed: no second entrance.
    if (previous && newestId && !reduced && !previous.startsWith("temp_")) animateKeysRef.current.add(`m:${newestId}`);
  }
  useEffect(() => {
    const previous = countedNewestRef.current;
    countedNewestRef.current = newestId;
    if (!previous || !newestId || previous === newestId) return;
    if (awayRef.current && !messages[0].isMine) setNewCount((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId]);

  // ---- floating sticky day label ------------------------------------------------
  const [stickyLabel, setStickyLabel] = useState<string | null>(null);
  const stickyOpacity = useRef(new Animated.Value(0)).current;
  const fadeMs = stickyFadeDuration(reduced, theme.motion.duration.base);
  const fadeMsRef = useRef(fadeMs);
  fadeMsRef.current = fadeMs;
  const sticky = useMemo(
    () =>
      createStickyLabelController((visible) => {
        const toValue = visible ? 1 : 0;
        if (fadeMsRef.current <= 0) stickyOpacity.setValue(toValue);
        else Animated.timing(stickyOpacity, { toValue, duration: fadeMsRef.current, useNativeDriver: true }).start();
      }),
    [stickyOpacity],
  );
  useEffect(() => () => sticky.dispose(), [sticky]);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<ViewToken<MessageListRow>> }) => {
    let top = -1;
    for (const v of viewableItems) if (v.index != null && v.index > top) top = v.index;
    if (top >= 0) setStickyLabel(stickyDateLabel(rowsRef.current, top));
  }).current;

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (stickyEnabled) sticky.onScroll();
      const y = e.nativeEvent.contentOffset.y; // inverted: 0 = latest
      const isAway = y > windowHeight;
      if (isAway !== awayRef.current) {
        awayRef.current = isAway;
        setAway(isAway);
        if (!isAway) setNewCount(0);
      }
    },
    [windowHeight, stickyEnabled, sticky],
  );

  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: !reduced });
    setNewCount(0);
  }, [reduced]);

  const onEndReached = useCallback(() => {
    if (hasMore && !loadingMore && onLoadMore) onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);

  // ---- quote tap -> scroll to the original + highlight ----------------------------
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const highlightTimer = useRef<any>(null);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  rowsRef.current = rows;
  const onPressReply = useCallback(
    (replyToId: ChatMessage["id"], from: ChatMessage) => {
      const key = messageKey({ id: replyToId });
      const index = rowsRef.current.findIndex((r) => r.key === key);
      if (index < 0) {
        if (onQuoteNotLoaded) onQuoteNotLoaded(replyToId, from);
        else announce("Original message isn't loaded");
        return;
      }
      listRef.current?.scrollToIndex({ index, animated: !reduced, viewPosition: 0.5 });
      setHighlightKey(key);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightKey(null), highlightMs);
    },
    [onQuoteNotLoaded, reduced, highlightMs],
  );
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      // Variable row heights: jump near it, then retry once the rows are measured.
      listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: false });
      setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, animated: !reduced, viewPosition: 0.5 }), 120);
    },
    [reduced],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MessageListRow>) => {
      if (item.kind === "date") return <DateChip label={item.label} theme={theme} />;
      const animate = animateKeysRef.current.has(item.key);
      if (animate) animateKeysRef.current.delete(item.key);
      return (
        <EnterAnimated animate={animate} duration={theme.motion.duration.fast}>
          <MessageBubble
            message={item.message}
            groupStart={item.groupStart}
            maxWidth={bubbleMaxWidth}
            senderName={peerName}
            onOpenImage={onOpenImage}
            onOpenFile={onOpenFile}
            onCallBack={onCallBack}
            onLongPress={onLongPressMessage}
            clock={clock}
            onReply={onReplyMessage}
            swipeToReply={swipeToReply}
            onPressReply={onPressReply}
            highlighted={highlightKey === item.key}
            onOpenVideo={onOpenVideo}
            peerId={peerId}
            onRetry={onRetryMessage}
          />
        </EnterAnimated>
      );
    },
    [theme, bubbleMaxWidth, peerName, onOpenImage, onOpenFile, onCallBack, onLongPressMessage, clock, onReplyMessage, swipeToReply, onPressReply, highlightKey, onOpenVideo, peerId, onRetryMessage],
  );

  const errorBanner = error ? (
    <View style={s.error} accessibilityRole="alert">
      <Text style={s.errorText}>{error.message}</Text>
      {error.onRetry ? (
        <ScalePressable onPress={error.onRetry} accessibilityLabel="Retry" style={s.errorRetry}>
          <Text style={s.errorRetryText}>Retry</Text>
        </ScalePressable>
      ) : null}
    </View>
  ) : null;

  // Empty / loading states live outside the inverted list (ListEmptyComponent renders upside down).
  if (!messages.length) {
    return (
      <ChatWallpaper style={s.fill} peerId={peerId} wallpaper={wallpaper} renderGradient={renderGradient}>
        {errorBanner}
        {loading ? (
          <View style={s.skeletons} accessibilityLabel="Loading messages" accessibilityState={{ busy: true }}>
            {[0.55, 0.4, 0.65, 0.35, 0.5].map((w, i) => (
              <View key={i} style={{ alignItems: i % 2 ? "flex-end" : "flex-start", marginTop: theme.space.sm }}>
                <SkeletonBox theme={theme} width={`${Math.round(w * 100)}%` as `${number}%`} height={36} radius={theme.radius.bubble} />
              </View>
            ))}
          </View>
        ) : (
          <View style={s.empty}>
            <View style={s.chip}>
              <Text style={s.emptyText}>{emptyText}</Text>
            </View>
          </View>
        )}
        {typing ? <TypingIndicator name={peerName} /> : null}
      </ChatWallpaper>
    );
  }

  return (
    <ChatWallpaper style={s.fill} peerId={peerId} wallpaper={wallpaper} renderGradient={renderGradient}>
      {errorBanner}
      <FlatList
        ref={listRef}
        inverted
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        extraData={highlightKey}
        onScrollToIndexFailed={onScrollToIndexFailed}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.3}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onViewableItemsChanged={stickyEnabled ? onViewableItemsChanged : undefined}
        viewabilityConfig={VIEWABILITY}
        ListHeaderComponent={typing ? <TypingIndicator name={peerName} /> : <View style={{ height: theme.space.sm }} />}
        ListFooterComponent={
          loadingMore ? (
            <View style={s.loadingMore}>
              <View style={s.chip}>
                <ActivityIndicator color={theme.colors.textMuted} accessibilityLabel="Loading older messages" />
              </View>
            </View>
          ) : (
            <View style={{ height: theme.space.sm }} />
          )
        }
        maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 40 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={11}
        removeClippedSubviews={Platform.OS === "android"}
        style={s.list}
        accessibilityLabel="Messages"
      />
      {stickyEnabled && stickyLabel ? (
        <Animated.View pointerEvents="none" style={[s.sticky, { opacity: stickyOpacity }]} importantForAccessibility="no-hide-descendants">
          <View style={s.chip}>
            <Text style={textStyle(theme, "caption", theme.colors.textMuted, "medium")}>{stickyLabel}</Text>
          </View>
        </Animated.View>
      ) : null}
      {away ? (
        <ScalePressable
          onPress={jumpToLatest}
          accessibilityLabel={newCount ? `Jump to latest, ${newCount} new ${newCount === 1 ? "message" : "messages"}` : "Jump to latest message"}
          style={[s.jump, shadowStyle(theme, "md")]}
        >
          <Icon name="chevronDown" size={theme.font.size.heading} color={theme.colors.text} />
          {newCount ? (
            <View style={s.jumpBadge}>
              <Text style={s.jumpBadgeText} allowFontScaling={false}>
                {formatUnreadBadge(newCount)}
              </Text>
            </View>
          ) : null}
        </ScalePressable>
      ) : null}
    </ChatWallpaper>
  );
});

const DateChip = memo(function DateChip({ label, theme }: { label: string; theme: Theme }) {
  return (
    <View style={{ alignItems: "center", marginVertical: theme.space.sm }} accessibilityRole="header">
      <View style={{ backgroundColor: theme.colors.surface, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: theme.space.xs }}>
        <Text style={textStyle(theme, "caption", theme.colors.textMuted, "medium")}>{label}</Text>
      </View>
    </View>
  );
});

/** Fade + translateY 8 -> 0 for messages that arrive while the list is shown. */
const EnterAnimated = ({ animate, duration, children }: { animate: boolean; duration: number; children: React.ReactNode }) => {
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (!animate) return;
    Animated.timing(progress, { toValue: 1, duration, useNativeDriver: true }).start();
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!animate) return <>{children}</>;
  return (
    <Animated.View style={{ opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>
      {children}
    </Animated.View>
  );
};

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        fill: { flex: 1 },
        // Transparent so the wallpaper shows through.
        list: { flex: 1 },
        // Surface chip so text stays readable on any wallpaper (solids, gradients, photos).
        chip: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: theme.space.xs },
        skeletons: { flex: 1, justifyContent: "flex-end", padding: theme.space.lg },
        empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
        emptyText: { ...textStyle(theme, "body", theme.colors.textMuted), textAlign: "center" },
        loadingMore: { paddingVertical: theme.space.md, alignItems: "center" },
        sticky: { position: "absolute", top: theme.space.sm, left: 0, right: 0, alignItems: "center" },
        jump: {
          position: "absolute",
          right: theme.space.lg,
          bottom: theme.space.lg,
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surface,
          alignItems: "center",
          justifyContent: "center",
        },
        jumpBadge: {
          position: "absolute",
          top: -theme.space.xs,
          right: -theme.space.xs,
          minWidth: 20,
          height: 20,
          paddingHorizontal: theme.space.xs,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        },
        jumpBadgeText: { ...textStyle(theme, "caption", theme.colors.onAccent, "semibold"), lineHeight: 16 },
        error: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm,
          backgroundColor: theme.colors.surface,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        errorText: { ...textStyle(theme, "small", theme.colors.danger), flex: 1 },
        errorRetry: { minHeight: theme.layout.tapTarget, justifyContent: "center", paddingHorizontal: theme.space.md },
        errorRetryText: textStyle(theme, "small", theme.colors.accent, "semibold"),
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const MessageList = slot("MessageList", DefaultMessageList);
