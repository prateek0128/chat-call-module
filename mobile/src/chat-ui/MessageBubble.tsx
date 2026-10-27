import React, { memo, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type ImageStyle, type StyleProp } from "react-native";
import { isDeletedMessage, isSystemMessage, type ChatMessage } from "../chat/types";
import { Icon, useTheme, withAlpha, type Theme } from "../theme";
import { CallEntry } from "./CallEntry";
import { isCallMessage } from "./callEntryModel";
import { formatFileSize, formatMessageTime, type ClockFormat } from "./format";
import { SwipeToReply } from "./gestures";
import { AudioMessageRow, audioPlaybackAvailable } from "./MediaPlayers";
import { canReplyTo, formatMediaDuration, replySenderLabel, replySnippet } from "./messageActions";
import { documentBadge } from "./documentBadge";
import { DELETED_MINE_TEXT, DELETED_TEXT, mediaKindOf, messageTicks, TICK_GLYPHS, TICK_LABELS, type TickState } from "./preview";
import { textStyle } from "./primitives";

export interface MessageBubbleProps {
  message: ChatMessage;
  /** First bubble of a group: tail + larger top margin. */
  groupStart?: boolean;
  /** Max bubble width in px (default: `layout.bubbleMaxWidthPct` of 360). */
  maxWidth?: number;
  /** Sender name for screen readers (incoming). */
  senderName?: string;
  onOpenImage?: (uri: string, message: ChatMessage) => void;
  onOpenFile?: (message: ChatMessage) => void;
  onCallBack?: (message: ChatMessage) => void;
  onLongPress?: (message: ChatMessage) => void;
  clock?: ClockFormat;
  /** Reply to this message (swipe right with react-native-gesture-handler; screen-reader "Reply" action). */
  onReply?: (message: ChatMessage) => void;
  /** Swipe-right-to-reply (needs react-native-gesture-handler + onReply). Default true. */
  swipeToReply?: boolean;
  /** Tap on the quoted message (MessageList scrolls to it). */
  onPressReply?: (replyToId: ChatMessage["id"], message: ChatMessage) => void;
  /** Briefly highlighted (jumped to from a quote). */
  highlighted?: boolean;
  /** Tap on a video. Default: `onOpenFile`. */
  onOpenVideo?: (message: ChatMessage) => void;
  /** Peer of this 1:1 chat: labels quotes "You" / peer name. */
  peerId?: string | null;
  /** Inline audio play / pause when expo-audio or expo-av is installed. Default true. */
  audioPlayback?: boolean;
  /** Retry a `failed` send (rate limited / too long). Shows "Not sent. Tap to retry". */
  onRetry?: (message: ChatMessage) => void;
}

const IMAGE_WIDTH = 240;

/** Text / image / file bubble (or a call entry chip) with inline time + ticks. */
export const MessageBubble = memo(function MessageBubble({
  message,
  groupStart = true,
  maxWidth,
  senderName,
  onOpenImage,
  onOpenFile,
  onCallBack,
  onLongPress,
  clock,
  onReply,
  swipeToReply = true,
  onPressReply,
  highlighted = false,
  onOpenVideo,
  peerId,
  audioPlayback = true,
  onRetry,
}: MessageBubbleProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  if (isCallMessage(message)) return <CallEntry message={message} onCallBack={onCallBack} clock={clock} />;
  if (isSystemMessage(message)) {
    // Centred chip (e.g. "You matched with Asha"): not a bubble, no actions.
    return (
      <View style={s.systemWrap} accessibilityRole="text" accessibilityLabel={message.content}>
        <View style={s.systemChip}>
          <Text style={s.systemText}>{message.content}</Text>
        </View>
      </View>
    );
  }

  const mine = message.isMine;
  const kind = mediaKindOf(message);
  const time = formatMessageTime(message.timestamp, clock);
  const ticks = messageTicks(message);
  const fg = mine ? theme.colors.bubbleOutText : theme.colors.bubbleInText;
  const metaColor = mine ? theme.colors.tickOut : theme.colors.textMuted;
  const width = maxWidth ?? Math.round((360 * theme.layout.bubbleMaxWidthPct) / 100);
  const caption = (message.content || "").trim();
  const showCaption = !!caption && caption !== message.file_name && !/^\[.*\]$/.test(caption);
  const tailRadius = theme.radius.sm;

  const bubbleStyle = [
    s.bubble,
    { maxWidth: width, backgroundColor: mine ? theme.colors.bubbleOut : theme.colors.bubbleIn },
    groupStart ? (mine ? { borderTopRightRadius: tailRadius } : { borderTopLeftRadius: tailRadius }) : null,
    kind === "image" || kind === "video" ? s.imageBubble : null,
    message.pending ? { opacity: 0.85 } : null,
  ];

  const meta = <Meta time={time} ticks={ticks} color={metaColor} theme={theme} />;
  const sending = !!message.pending && !!kind;
  const failed = !!message.failed;
  const retry = failed && onRetry ? () => onRetry(message) : undefined;
  const failedLabel = retry ? "Not sent. Tap to retry" : "Not sent";
  const failedRow = failed ? (
    <Pressable onPress={retry} disabled={!retry} accessibilityRole="button" accessibilityLabel={failedLabel} style={s.failedRow} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
      <Icon name="retry" size={theme.font.size.small} color={theme.colors.danger} />
      <Text style={s.failedText}>{failedLabel}</Text>
    </Pressable>
  ) : null;
  const mediaOverlay = sending ? (
    <View style={s.mediaOverlay} accessibilityLabel="Sending" accessibilityState={{ busy: true }}>
      <ActivityIndicator color={theme.colors.callText} />
      <Text style={s.overlayText}>Sending…</Text>
    </View>
  ) : failed ? (
    <Pressable onPress={retry} disabled={!retry} accessibilityRole="button" accessibilityLabel={failedLabel} style={s.mediaOverlay}>
      <Icon name="retry" size={theme.font.size.heading} color={theme.colors.callText} />
      <Text style={s.overlayText}>{retry ? "Tap to retry" : "Not sent"}</Text>
    </Pressable>
  ) : null;

  if (isDeletedMessage(message)) {
    const text = mine ? DELETED_MINE_TEXT : DELETED_TEXT;
    return (
      <View style={[s.row, { justifyContent: mine ? "flex-end" : "flex-start", marginTop: groupStart ? theme.space.sm : theme.space.xxs }]}>
        <Pressable
          onLongPress={onLongPress ? () => onLongPress(message) : undefined}
          disabled={!onLongPress}
          style={[s.bubble, { maxWidth: width, backgroundColor: mine ? theme.colors.bubbleOut : theme.colors.bubbleIn }]}
          accessible
          accessibilityLabel={`${text}${time ? `, ${time}` : ""}`}
        >
          <Text style={[s.text, s.deleted, { color: mine ? fg : theme.colors.textMuted }]}>
            {text}
            <Text style={s.spacer}>{metaSpacer(time, null)}</Text>
          </Text>
          <View style={s.metaInline}>
            <Meta time={time} ticks={null} color={metaColor} theme={theme} />
          </View>
        </Pressable>
      </View>
    );
  }
  const a11y = [
    mine ? "You" : senderName || "Message",
    kind === "image" ? "photo" : kind ? `${kind}${message.file_name ? ` ${message.file_name}` : ""}` : null,
    showCaption || !kind ? caption : null,
    time || null,
    ticks ? TICK_LABELS[ticks] : null,
    sending ? "sending" : null,
    failed ? "not sent" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const quoted = message.reply_to;
  const quoteSender = quoted && peerId != null ? replySenderLabel({ isMine: String(quoted.sender_id) !== String(peerId) }, senderName) : null;
  const quoteText = quoted ? (quoted.content || quoted.file_name ? replySnippet(quoted) : "Attachment") : "";
  const reply = quoted ? (
    <Pressable
      onPress={onPressReply ? () => onPressReply(quoted.id, message) : undefined}
      disabled={!onPressReply}
      accessibilityRole={onPressReply ? "button" : undefined}
      accessibilityLabel={`Reply to ${quoteSender || "message"}: ${quoteText}${onPressReply ? ". Shows the original message" : ""}`}
      style={[s.reply, { borderLeftColor: mine ? theme.colors.tickOut : theme.colors.accent, backgroundColor: withAlpha(fg, 0.08) }]}
    >
      {quoteSender ? (
        <Text style={[s.replySender, { color: mine ? fg : theme.colors.accent }]} numberOfLines={1}>
          {quoteSender}
        </Text>
      ) : null}
      <Text style={[s.replyText, { color: fg }]} numberOfLines={2}>
        {quoteText}
      </Text>
    </Pressable>
  ) : null;

  let body: React.ReactNode;
  if (kind === "image") {
    const uri = message.thumbnail_url || message.file_url || "";
    const imgWidth = Math.min(IMAGE_WIDTH, width - theme.space.xs * 2);
    body = (
      <View>
        {reply}
        <Pressable
          onPress={() => uri && onOpenImage && onOpenImage(message.file_url || uri, message)}
          disabled={!uri || !onOpenImage}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Photo${showCaption ? `: ${caption}` : ""}. Opens full screen`}
        >
          {uri ? (
            <BubbleImage uri={uri} style={[s.image, { width: imgWidth, height: Math.round((imgWidth * 3) / 4) }]} spinnerColor={theme.colors.textMuted} showSpinner={!sending} />
          ) : (
            <View style={[s.image, s.imagePlaceholder, { width: imgWidth, height: Math.round((imgWidth * 3) / 4) }]}>
              <Icon name="image" size={theme.font.size.display} color={theme.colors.textSubtle} />
            </View>
          )}
          {mediaOverlay}
        </Pressable>
        {showCaption ? (
          <Text style={[s.text, s.caption, { color: fg }]}>
            {caption}
            <Text style={s.spacer}>{metaSpacer(time, ticks)}</Text>
          </Text>
        ) : null}
        <View style={showCaption ? s.metaInline : s.metaOnImage}>{showCaption ? meta : <Meta time={time} ticks={ticks} color={theme.colors.callText} theme={theme} />}</View>
      </View>
    );
  } else if (kind === "video") {
    const poster = message.thumbnail_url || "";
    const imgWidth = Math.min(IMAGE_WIDTH, width - theme.space.xs * 2);
    const dur = formatMediaDuration(message.duration);
    const openVideo = onOpenVideo || onOpenFile;
    body = (
      <View>
        {reply}
        <Pressable
          onPress={() => openVideo && openVideo(message)}
          disabled={!openVideo || !message.file_url}
          accessibilityRole="button"
          accessibilityLabel={`Video${dur ? `, ${dur}` : ""}${showCaption ? `: ${caption}` : ""}. Plays full screen`}
        >
          <View style={[s.image, s.imagePlaceholder, { width: imgWidth, height: Math.round((imgWidth * 9) / 16), overflow: "hidden" }]}>
            {poster ? <Image source={{ uri: poster }} style={[StyleSheet.absoluteFill, { borderRadius: theme.radius.bubble - theme.space.xs }]} resizeMode="cover" /> : null}
            <View style={s.play}>
              <Text style={textStyle(theme, "title", theme.colors.callText)}>▶</Text>
            </View>
            {dur ? (
              <View style={s.duration}>
                <Text style={[textStyle(theme, "caption", theme.colors.callText), { lineHeight: 15 }]}>{dur}</Text>
              </View>
            ) : null}
            {mediaOverlay}
          </View>
        </Pressable>
        {showCaption ? (
          <Text style={[s.text, s.caption, { color: fg }]}>
            {caption}
            <Text style={s.spacer}>{metaSpacer(time, ticks)}</Text>
          </Text>
        ) : null}
        <View style={showCaption ? s.metaInline : s.metaOnImage}>{showCaption ? meta : <Meta time={time} ticks={ticks} color={theme.colors.callText} theme={theme} />}</View>
      </View>
    );
  } else if (kind === "audio" && audioPlayback && message.file_url && audioPlaybackAvailable()) {
    body = (
      <View>
        {reply}
        <AudioMessageRow uri={message.file_url} duration={message.duration} color={fg} mutedColor={metaColor} label={message.file_name || "Audio"} />
        {showCaption ? <Text style={[s.text, { color: fg }]}>{caption}</Text> : null}
        <View style={s.metaRow}>{meta}</View>
      </View>
    );
  } else if (kind) {
    const size = formatFileSize(message.file_size);
    const badge = kind === "file" ? documentBadge(message.file_name, message.file_type) : null;
    const badgeColor = badge ? theme.colors[badge.colorToken] : fg;
    const fileMeta = sending ? "Sending…" : badge ? (size ? `${badge.label} · ${size}` : badge.label) : size;
    body = (
      <View>
        {reply}
        <Pressable
          onPress={() => onOpenFile && onOpenFile(message)}
          disabled={!onOpenFile}
          accessibilityRole="button"
          accessibilityLabel={`${kind === "file" ? (badge ? `${badge.label} file` : "File") : kind}: ${message.file_name || "attachment"}${size ? `, ${size}` : ""}${sending ? ", sending" : ""}`}
          style={[s.fileCard, { backgroundColor: withAlpha(fg, 0.08) }]}
        >
          {sending ? (
            <View style={s.fileBadge}>
              <ActivityIndicator color={fg} size="small" />
            </View>
          ) : badge ? (
            <View style={[s.fileBadge, { backgroundColor: badgeColor }]}>
              <Text style={s.fileBadgeText} allowFontScaling={false} numberOfLines={1}>
                {badge.label}
              </Text>
            </View>
          ) : (
            <Icon name="file" size={theme.font.size.heading} color={fg} />
          )}
          <View style={s.fileText}>
            <Text style={[s.fileName, { color: fg }]} numberOfLines={2}>
              {message.file_name || (kind === "audio" ? "Audio" : "File")}
            </Text>
            {fileMeta ? <Text style={[s.fileSize, { color: metaColor }]}>{fileMeta}</Text> : null}
          </View>
        </Pressable>
        {showCaption ? <Text style={[s.text, { color: fg }]}>{caption}</Text> : null}
        <View style={s.metaRow}>{meta}</View>
      </View>
    );
  } else {
    body = (
      <View>
        {reply}
        <Text style={[s.text, { color: fg }]} selectable>
          {message.content}
          <Text style={s.spacer}>{metaSpacer(time, ticks)}</Text>
        </Text>
        <View style={s.metaInline}>{meta}</View>
      </View>
    );
  }

  const replyable = !!onReply && canReplyTo(message);
  const a11yActions = [
    ...(replyable ? [{ name: "reply", label: "Reply" }] : []),
    ...(onLongPress ? [{ name: "longpress", label: "Message actions" }] : []),
  ];
  const row = (
    <View
      style={[
        s.row,
        { justifyContent: mine ? "flex-end" : "flex-start", marginTop: groupStart ? theme.space.sm : theme.space.xxs },
        highlighted ? { backgroundColor: withAlpha(theme.colors.accent, 0.16) } : null,
      ]}
    >
      <Pressable
        onLongPress={onLongPress ? () => onLongPress(message) : undefined}
        disabled={!onLongPress}
        style={bubbleStyle}
        accessible
        accessibilityLabel={a11y}
        accessibilityActions={a11yActions.length ? a11yActions : undefined}
        onAccessibilityAction={
          a11yActions.length
            ? (e) => {
                if (e.nativeEvent.actionName === "reply" && replyable) onReply!(message);
                if (e.nativeEvent.actionName === "longpress" && onLongPress) onLongPress(message);
              }
            : undefined
        }
      >
        {body}
        {failedRow}
      </Pressable>
    </View>
  );
  if (!replyable) return row;
  return (
    <SwipeToReply enabled={swipeToReply} onReply={() => onReply!(message)}>
      {row}
    </SwipeToReply>
  );
});

/** Bubble image with a load spinner until the first frame arrives. */
const BubbleImage = ({ uri, style, spinnerColor, showSpinner }: { uri: string; style: StyleProp<ImageStyle>; spinnerColor: string; showSpinner: boolean }) => {
  const [loading, setLoading] = useState(true);
  return (
    <View>
      <Image source={{ uri }} style={style} resizeMode="cover" onLoadEnd={() => setLoading(false)} onError={() => setLoading(false)} />
      {loading && showSpinner ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} accessibilityLabel="Loading photo">
          <ActivityIndicator color={spinnerColor} />
        </View>
      ) : null}
    </View>
  );
};

/** Invisible text that reserves room for the inline time + ticks on the last line. */
const metaSpacer = (time: string, ticks: TickState | null) => `  ${time}${ticks ? ` ${TICK_GLYPHS[ticks]}` : ""} `;

const Meta = ({ time, ticks, color, theme }: { time: string; ticks: TickState | null; color: string; theme: Theme }) => (
  <View style={{ flexDirection: "row", alignItems: "center" }} accessible={false} importantForAccessibility="no-hide-descendants">
    <Text style={[textStyle(theme, "caption", color), { lineHeight: 15 }]}>{time}</Text>
    {ticks ? (
      <Text
        style={[
          textStyle(theme, "caption", ticks === "read" ? theme.colors.tickReadOut : color, "semibold"),
          { lineHeight: 15, marginLeft: theme.space.xs },
        ]}
      >
        {TICK_GLYPHS[ticks]}
      </Text>
    ) : null}
  </View>
);

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: "row", paddingHorizontal: theme.space.md },
        bubble: {
          borderRadius: theme.radius.bubble,
          paddingHorizontal: theme.space.md,
          paddingTop: theme.space.sm - theme.space.xxs,
          paddingBottom: theme.space.sm - theme.space.xxs,
        },
        imageBubble: { padding: theme.space.xs, paddingTop: theme.space.xs, paddingBottom: theme.space.xs },
        text: textStyle(theme, "body", theme.colors.text),
        caption: { paddingHorizontal: theme.space.sm, paddingTop: theme.space.xs },
        spacer: { color: "transparent", fontSize: theme.font.size.caption },
        metaInline: { position: "absolute", right: 0, bottom: 0 },
        metaRow: { alignSelf: "flex-end", marginTop: theme.space.xxs },
        metaOnImage: {
          position: "absolute",
          right: theme.space.sm,
          bottom: theme.space.sm,
          paddingHorizontal: theme.space.xs + theme.space.xxs,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.overlay,
        },
        image: { borderRadius: theme.radius.bubble - theme.space.xs },
        imagePlaceholder: { alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceSunken },
        fileCard: {
          flexDirection: "row",
          alignItems: "center",
          padding: theme.space.sm,
          borderRadius: theme.radius.md,
          minWidth: 180,
        },
        fileText: { marginLeft: theme.space.sm, flexShrink: 1 },
        fileName: textStyle(theme, "small", theme.colors.text, "semibold"),
        fileSize: textStyle(theme, "caption", theme.colors.textMuted),
        reply: { borderLeftWidth: 3, borderRadius: theme.radius.sm, paddingHorizontal: theme.space.sm, paddingVertical: theme.space.xs, marginBottom: theme.space.xs },
        replyText: textStyle(theme, "small", theme.colors.text),
        replySender: textStyle(theme, "caption", theme.colors.accent, "semibold"),
        play: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.overlay,
          alignItems: "center",
          justifyContent: "center",
        },
        systemWrap: { alignItems: "center", marginVertical: theme.space.sm, paddingHorizontal: theme.space.xl },
        systemChip: {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.md,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.xs,
          maxWidth: "90%",
        },
        systemText: { ...textStyle(theme, "small", theme.colors.textMuted), textAlign: "center" },
        deleted: { fontStyle: "italic" },
        failedRow: { flexDirection: "row", alignItems: "center", alignSelf: "flex-end", marginTop: theme.space.xxs },
        failedText: { ...textStyle(theme, "caption", theme.colors.danger, "semibold"), marginLeft: theme.space.xxs },
        mediaOverlay: {
          ...StyleSheet.absoluteFillObject,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.bubble - theme.space.xs,
          backgroundColor: theme.colors.overlay,
        },
        overlayText: { ...textStyle(theme, "caption", theme.colors.callText, "semibold"), marginTop: theme.space.xs },
        fileBadge: {
          minWidth: 36,
          height: 36,
          paddingHorizontal: theme.space.xs,
          borderRadius: theme.radius.sm,
          alignItems: "center",
          justifyContent: "center",
        },
        fileBadgeText: { ...textStyle(theme, "caption", theme.colors.onAccent, "bold"), lineHeight: 14 },
        duration: {
          position: "absolute",
          left: theme.space.sm,
          bottom: theme.space.sm,
          paddingHorizontal: theme.space.xs + theme.space.xxs,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.overlay,
        },
      }),
    [theme],
  );
