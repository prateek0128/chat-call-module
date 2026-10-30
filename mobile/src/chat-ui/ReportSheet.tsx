import { slot } from "../theme";
import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useOptionalBlocking } from "../moderation/hooks";
import type { ReportCategory, ReportInput } from "../moderation/ModerationStore";
import { announce, ScalePressable, useTheme, type Theme } from "../theme";
import { canSubmitReport, reportCategoryOptions } from "./moderationModel";
import { textStyle } from "./primitives";

export interface ReportSheetProps {
  visible: boolean;
  peerId: string;
  /** Shown in the title and the "Also block" toggle. */
  name?: string;
  /** Reporting one message (optional). */
  messageId?: string | number;
  onClose: () => void;
  /** After a successful report (e.g. leave the chat when blocked). */
  onSubmitted?: (result: { reportId: string | null; blocked: boolean }) => void;
  /** Default: `useBlocking().report` from <ModerationProvider>. */
  submit?: (input: ReportInput) => Promise<unknown>;
  categories?: readonly ReportCategory[];
  insetBottom?: number;
}

/** Report a user: category (§7), optional reason, "Also block" (default on), then a confirmation. */
export const DefaultReportSheet = memo(function ReportSheet({
  visible,
  peerId,
  name,
  messageId,
  onClose,
  onSubmitted,
  submit,
  categories,
  insetBottom = 0,
}: ReportSheetProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const blocking = useOptionalBlocking();
  const options = useMemo(() => reportCategoryOptions(categories), [categories]);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [reason, setReason] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [state, setState] = useState<"form" | "sending" | "done" | "error">("form");

  useEffect(() => {
    if (!visible) return;
    setCategory(null);
    setReason("");
    setAlsoBlock(true);
    setState("form");
  }, [visible, peerId]);

  if (!visible) return null;
  const who = name || "this user";
  const send = submit || blocking?.report;
  const ready = canSubmitReport(category, reason) && !!send && state !== "sending";

  const onSubmit = async () => {
    if (!ready || !send || !category) return;
    setState("sending");
    try {
      const res: any = await send({ peerId, category, reason: reason.trim(), messageId, block: alsoBlock });
      setState("done");
      announce(alsoBlock ? `Report sent. ${who} is blocked.` : "Report sent.");
      onSubmitted?.({ reportId: res?.reportId ?? null, blocked: alsoBlock });
    } catch {
      setState("error");
      announce("Couldn't send the report. Try again.");
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={s.overlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[s.sheet, { paddingBottom: theme.space.lg + insetBottom }]} accessibilityViewIsModal>
        {state === "done" ? (
          <View style={s.done}>
            <Text style={s.title} accessibilityRole="header">
              Thanks for letting us know
            </Text>
            <Text style={s.body}>{alsoBlock ? `We'll review your report. ${who} can no longer message or call you.` : "We'll review your report."}</Text>
            <ScalePressable onPress={onClose} accessibilityLabel="Done" style={[s.button, s.primary]}>
              <Text style={s.primaryText}>Done</Text>
            </ScalePressable>
          </View>
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.title} accessibilityRole="header">
              Report {who}
            </Text>
            <Text style={s.body}>Why are you reporting? They won't be told who reported them.</Text>
            <View accessibilityRole="radiogroup" style={s.options}>
              {options.map((o) => {
                const selected = category === o.id;
                return (
                  <Pressable
                    key={o.id}
                    onPress={() => setCategory(o.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={o.label}
                    style={[s.option, selected && { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft }]}
                  >
                    <Text style={s.optionText}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder={category === "other" ? "Tell us what happened (required)" : "Add details (optional)"}
              placeholderTextColor={theme.colors.textSubtle}
              multiline
              maxLength={1000}
              accessibilityLabel="Details"
              style={s.input}
            />
            <Pressable
              onPress={() => setAlsoBlock((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: alsoBlock }}
              accessibilityLabel={`Also block ${who}`}
              style={s.toggleRow}
            >
              <Text style={[s.optionText, { flex: 1 }]}>Also block {who}</Text>
              <View style={[s.toggle, { backgroundColor: alsoBlock ? theme.colors.accent : theme.colors.surfaceSunken }]}>
                <View style={[s.knob, { alignSelf: alsoBlock ? "flex-end" : "flex-start" }]} />
              </View>
            </Pressable>
            {state === "error" ? (
              <Text style={s.error} accessibilityRole="alert">
                Couldn't send the report. Try again.
              </Text>
            ) : null}
            <View style={s.buttons}>
              <ScalePressable onPress={onClose} accessibilityLabel="Cancel" style={[s.button, s.secondary]}>
                <Text style={s.secondaryText}>Cancel</Text>
              </ScalePressable>
              <ScalePressable
                onPress={onSubmit}
                disabled={!ready}
                accessibilityLabel="Send report"
                accessibilityState={{ disabled: !ready, busy: state === "sending" }}
                style={[s.button, ready ? s.danger : s.secondary]}
              >
                {state === "sending" ? (
                  <ActivityIndicator color={theme.colors.onAccent} />
                ) : (
                  <Text style={ready ? s.primaryText : s.secondaryText}>Report</Text>
                )}
              </ScalePressable>
            </View>
          </ScrollView>
        )}
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
          maxHeight: "90%",
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingTop: theme.space.lg,
          paddingHorizontal: theme.space.lg,
        },
        done: { alignItems: "center" },
        title: { ...textStyle(theme, "title", theme.colors.text, "semibold"), marginBottom: theme.space.xs },
        body: { ...textStyle(theme, "small", theme.colors.textMuted), marginBottom: theme.space.md },
        options: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
        option: {
          minHeight: theme.layout.tapTarget,
          justifyContent: "center",
          paddingHorizontal: theme.space.md,
          borderRadius: theme.radius.pill,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        optionText: textStyle(theme, "body", theme.colors.text),
        input: {
          ...textStyle(theme, "body", theme.colors.text),
          marginTop: theme.space.md,
          minHeight: 72,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceSunken,
          padding: theme.space.md,
          textAlignVertical: "top",
        },
        toggleRow: { flexDirection: "row", alignItems: "center", minHeight: theme.layout.tapTarget, marginTop: theme.space.sm },
        toggle: { width: 48, height: 28, borderRadius: 14, padding: 3 },
        knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: theme.colors.surface },
        error: { ...textStyle(theme, "small", theme.colors.danger), marginTop: theme.space.sm },
        buttons: { flexDirection: "row", marginTop: theme.space.lg },
        button: {
          flex: 1,
          minHeight: theme.layout.tapTarget,
          borderRadius: theme.radius.md,
          alignItems: "center",
          justifyContent: "center",
          marginHorizontal: theme.space.xs,
          alignSelf: "stretch",
        },
        primary: { backgroundColor: theme.colors.accent },
        danger: { backgroundColor: theme.colors.danger },
        secondary: { backgroundColor: theme.colors.surfaceSunken },
        primaryText: textStyle(theme, "body", theme.colors.onAccent, "semibold"),
        secondaryText: textStyle(theme, "body", theme.colors.text, "semibold"),
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const ReportSheet = slot("ReportSheet", DefaultReportSheet);
