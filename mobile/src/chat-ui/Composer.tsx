import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import { Icon, lineHeightFor, ScalePressable, useTheme, type Theme } from "../theme";
import { canSendText, clampComposerHeight } from "./composerLayout";
import { blockedComposerText, type BlockedComposerKind } from "./moderationModel";
import { textStyle } from "./primitives";
import { ReplyBar } from "./ReplyBar";

export interface ComposerProps {
  /**
   * Send the text. Return `false` to keep the text in the field (e.g. not connected);
   * anything else clears it.
   */
  onSend: (text: string) => boolean | void;
  /** Shows the attach button. */
  onAttach?: () => void;
  /** Typing state changes (throttled: true on first keystroke, false after 3 s idle / on send / on blur). */
  onTypingChange?: (typing: boolean) => void;
  /** When set, the composer is replaced by this message (e.g. "Chat is not enabled"). */
  disabledReason?: string | null;
  placeholder?: string;
  /** Max visible lines before scrolling (default `layout.composerMaxLines`). */
  maxLines?: number;
  maxLength?: number;
  /** Bottom safe-area inset (when the keyboard is closed). */
  insetBottom?: number;
  /** Initial text (drafts). */
  initialText?: string;
  attachDisabled?: boolean;
  /**
   * Blocked conversation (moderation): "You blocked {name}. Unblock" (with `onUnblock`) or
   * "You can't reply to this conversation". Wins over `disabledReason`.
   */
  blockedState?: { kind: BlockedComposerKind; name?: string | null; onUnblock?: () => void } | null;
  /** Shows the reply bar ("{senderName}: {snippet}" + cancel ✕) above the field. */
  replyTo?: { senderName: string; snippet: string } | null;
  /** Cancel ✕ on the reply bar. */
  onCancelReply?: () => void;
}

const TYPING_IDLE_MS = 3000;

/**
 * Attach button, auto-growing field (1..maxLines lines), Send button (accent; disabled when empty).
 * Place it at the bottom of a KeyboardAvoidingView (ChatScreen does).
 */
export const Composer = memo(function Composer({
  onSend,
  onAttach,
  onTypingChange,
  disabledReason,
  placeholder = "Message",
  maxLines,
  maxLength = 4000,
  insetBottom = 0,
  initialText = "",
  attachDisabled = false,
  blockedState,
  replyTo,
  onCancelReply,
}: ComposerProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const [text, setText] = useState(initialText);
  const lineHeight = lineHeightFor(theme, theme.font.size.body);
  const padV = theme.space.sm;
  const lines = maxLines ?? theme.layout.composerMaxLines;
  const [size, setSize] = useState(() => clampComposerHeight(0, { lineHeight, maxLines: lines, paddingVertical: padV }));

  // ---- typing (throttled) ------------------------------------------------
  const typingRef = useRef(false);
  const idleTimer = useRef<any>(null);
  const setTyping = useCallback(
    (v: boolean) => {
      if (typingRef.current === v) return;
      typingRef.current = v;
      onTypingChange?.(v);
    },
    [onTypingChange],
  );
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (typingRef.current) onTypingChange?.(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChangeText = useCallback(
    (t: string) => {
      setText(t);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (!t) return setTyping(false);
      setTyping(true);
      idleTimer.current = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
    },
    [setTyping],
  );

  const onContentSizeChange = useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const next = clampComposerHeight(e.nativeEvent.contentSize.height, { lineHeight, maxLines: lines, paddingVertical: padV });
      setSize((prev) => (prev.height === next.height && prev.scrollEnabled === next.scrollEnabled ? prev : next));
    },
    [lineHeight, lines, padV],
  );

  const sendEnabled = canSendText(text);
  const send = useCallback(() => {
    const value = text.trim();
    if (!value) return;
    const result = onSend(value);
    if (result === false) return; // keep the draft
    setText("");
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setTyping(false);
  }, [text, onSend, setTyping]);

  if (blockedState) {
    const text = blockedComposerText(blockedState.kind, blockedState.name);
    return (
      <View style={[s.disabled, s.blockedRow, { paddingBottom: theme.space.md + insetBottom }]} accessibilityLiveRegion="polite">
        <Text style={s.disabledText}>{text}</Text>
        {blockedState.kind === "blocked" && blockedState.onUnblock ? (
          <ScalePressable onPress={blockedState.onUnblock} accessibilityLabel={`Unblock ${blockedState.name || "this contact"}`} style={s.unblock}>
            <Text style={s.unblockText}>Unblock</Text>
          </ScalePressable>
        ) : null}
      </View>
    );
  }

  if (disabledReason) {
    return (
      <View style={[s.disabled, { paddingBottom: theme.space.md + insetBottom }]} accessibilityRole="text" accessibilityLiveRegion="polite">
        <Text style={s.disabledText}>{disabledReason}</Text>
      </View>
    );
  }

  const bar = (
    <View style={[s.bar, { paddingBottom: theme.space.sm + insetBottom }, replyTo ? { borderTopWidth: 0 } : null]}>
      {onAttach ? (
        <ScalePressable onPress={onAttach} disabled={attachDisabled} accessibilityLabel="Attach file" style={s.iconButton}>
          <Icon name="attach" size={theme.font.size.heading} color={attachDisabled ? theme.colors.textSubtle : theme.colors.textMuted} />
        </ScalePressable>
      ) : null}
      <View style={s.field}>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          onBlur={() => setTyping(false)}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textSubtle}
          multiline
          maxLength={maxLength}
          scrollEnabled={size.scrollEnabled}
          onContentSizeChange={onContentSizeChange}
          accessibilityLabel="Message"
          style={[s.input, { height: size.height, lineHeight, paddingVertical: padV, textAlignVertical: "top" }]}
          underlineColorAndroid="transparent"
        />
      </View>
      <ScalePressable
        onPress={send}
        disabled={!sendEnabled}
        accessibilityLabel="Send message"
        style={[s.send, { backgroundColor: sendEnabled ? theme.colors.accent : theme.colors.surfaceSunken }]}
      >
        <Icon name="send" size={theme.font.size.title} color={sendEnabled ? theme.colors.onAccent : theme.colors.textSubtle} />
      </ScalePressable>
    </View>
  );
  // Same tree with or without the reply bar, so the field keeps focus when a reply starts / ends.
  return (
    <View>
      {replyTo ? <ReplyBar senderName={replyTo.senderName} snippet={replyTo.snippet} onCancel={onCancelReply || noop} /> : null}
      {bar}
    </View>
  );
});

const noop = () => undefined;

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        bar: {
          flexDirection: "row",
          alignItems: "flex-end",
          paddingHorizontal: theme.space.sm,
          paddingTop: theme.space.sm,
          backgroundColor: theme.colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.colors.border,
        },
        iconButton: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.pill,
        },
        field: {
          flex: 1,
          marginHorizontal: theme.space.xs,
          borderRadius: theme.radius.xl,
          backgroundColor: theme.colors.surfaceSunken,
          paddingHorizontal: theme.space.md,
          minHeight: theme.layout.tapTarget,
          justifyContent: "center",
        },
        input: { ...textStyle(theme, "body", theme.colors.text), padding: 0, margin: 0 },
        send: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          borderRadius: theme.radius.pill,
          alignItems: "center",
          justifyContent: "center",
        },
        disabled: {
          alignItems: "center",
          paddingTop: theme.space.md,
          paddingHorizontal: theme.space.lg,
          backgroundColor: theme.colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.colors.border,
        },
        disabledText: { ...textStyle(theme, "small", theme.colors.textMuted), textAlign: "center" },
        blockedRow: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap" },
        unblock: { minHeight: theme.layout.tapTarget, justifyContent: "center", paddingHorizontal: theme.space.sm, marginTop: -theme.space.md },
        unblockText: textStyle(theme, "small", theme.colors.accent, "semibold"),
      }),
    [theme],
  );
