import { slot } from "../theme";
import { memo, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatMessage } from "../chat/types";
import { Icon, useTheme, type Theme } from "../theme";
import { describeCallEntry } from "./callEntryModel";
import { formatMessageTime, type ClockFormat } from "./format";
import { textStyle } from "./primitives";

export interface CallEntryProps {
  message: ChatMessage;
  /** Shows "Call back" (only for finished calls). chat-ui never starts calls itself. */
  onCallBack?: (message: ChatMessage) => void;
  clock?: ClockFormat;
}

/** Centred chip: direction icon, title, detail · time, optional "Call back". */
export const DefaultCallEntry = memo(function CallEntry({ message, onCallBack, clock }: CallEntryProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const call = describeCallEntry(message);
  const time = formatMessageTime(message.timestamp, clock);
  const tint = call.danger ? theme.colors.danger : theme.colors.textMuted;
  const showCallBack = !!onCallBack && call.canCallBack;
  // Callee's missed / declined call: the whole chip is the call-back target ("Tap to call back").
  const tapToCallBack = showCallBack && call.danger;
  const detail = call.danger && !showCallBack ? "Incoming" : call.detail;
  const label = `${call.title}, ${detail}${time ? `, ${time}` : ""}`;
  const chipBody = (
    <>
      <Icon name={call.icon} size={theme.font.size.title} color={tint} />
      <View style={s.text}>
        <Text style={[s.title, call.danger ? { color: theme.colors.danger } : null]} numberOfLines={1}>
          {call.title}
        </Text>
        <Text style={[s.detail, tapToCallBack ? { color: theme.colors.accent } : null]} numberOfLines={1}>
          {time ? `${detail} · ${time}` : detail}
        </Text>
      </View>
    </>
  );
  if (tapToCallBack) {
    return (
      <View style={s.wrap}>
        <Pressable
          onPress={() => onCallBack && onCallBack(message)}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Calls back"
          style={({ pressed }) => [s.chip, pressed ? { opacity: 0.7 } : null]}
        >
          {chipBody}
        </Pressable>
      </View>
    );
  }
  return (
    <View style={s.wrap}>
      <View style={s.chip} accessible accessibilityLabel={label}>
        {chipBody}
      </View>
      {showCallBack ? (
        <Pressable
          onPress={() => onCallBack && onCallBack(message)}
          accessibilityRole="button"
          accessibilityLabel="Call back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [s.callBack, pressed ? { opacity: 0.7 } : null]}
        >
          <Text style={s.callBackText}>Call back</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        wrap: { alignItems: "center", marginVertical: theme.space.sm, paddingHorizontal: theme.space.lg },
        chip: {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          maxWidth: "90%",
        },
        text: { marginLeft: theme.space.sm, flexShrink: 1 },
        title: textStyle(theme, "small", theme.colors.text, "semibold"),
        detail: textStyle(theme, "caption", theme.colors.textMuted),
        callBack: { marginTop: theme.space.xs, minHeight: 28, justifyContent: "center", paddingHorizontal: theme.space.md },
        callBackText: textStyle(theme, "small", theme.colors.accent, "semibold"),
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const CallEntry = slot("CallEntry", DefaultCallEntry);
