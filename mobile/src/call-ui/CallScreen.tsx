import { slot } from "../theme";
import { memo, ReactNode, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { announce, Icon, lineHeightFor, ScalePressable, useReducedMotion, useSafeInsets, useTheme, type EdgeInsets } from "../theme";
import { CallBackground } from "./CallBackground";
import { CallControls } from "./CallControls";
import type { CallScreenModel } from "./callScreenState";
import { useCallTimer } from "./hooks";
import { PulseAvatar } from "./PulseAvatar";

export interface CallScreenProps {
  model: CallScreenModel;
  /** Epoch ms when audio connected (active timer). */
  connectedAt?: number | null;
  isMuted?: boolean;
  isSpeakerOn?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onHangup?: () => void;
  onToggleMute?: () => void;
  onToggleSpeaker?: () => void;
  onClose?: () => void;
  onCallAgain?: () => void;
  /** "Message" on ended / failed screens (chat in combined mode). */
  onMessage?: () => void;
  /** Shows a minimise button (native "back" -> Return-to-call pill). */
  onMinimise?: () => void;
  insets?: Partial<EdgeInsets>;
  /** Replace the default banded gradient (e.g. with expo-linear-gradient). Render absolute-fill. */
  renderBackground?: () => ReactNode;
}

/**
 * Full-screen call UI for every phase: outgoing (Calling…/Ringing…), incoming (Decline/Accept),
 * connecting, active (timer, Mute, Speaker, Hang up), ended (summary), failed (reason + Close/Call again).
 * Presentational: CallOverlay wires it to `useCall()`.
 */
export const DefaultCallScreen = memo(function CallScreen({
  model,
  connectedAt,
  isMuted = false,
  isSpeakerOn = false,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleSpeaker,
  onClose,
  onCallAgain,
  onMessage,
  onMinimise,
  insets,
  renderBackground,
}: CallScreenProps) {
  const theme = useTheme();
  const safe = useSafeInsets(insets);
  const reduced = useReducedMotion();
  const timer = useCallTimer(model.showTimer ? connectedAt : null);
  const statusText = model.showTimer ? timer || "00:00" : model.status;
  const name = model.peerName || "Unknown";

  // Status line cross-fade (base) on phase / status changes.
  const fade = useRef(new Animated.Value(1)).current;
  const statusKey = `${model.phase}|${model.status}`;
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
    } else if (!reduced) {
      fade.setValue(0);
      Animated.timing(fade, { toValue: 1, duration: theme.motion.duration.base, useNativeDriver: true }).start();
    }
    // Screen readers: announce call status changes.
    const spoken =
      model.phase === "active" ? `Call with ${name} connected` : model.phase === "incoming" ? `${model.status} from ${name}` : model.status;
    announce(model.hint ? `${spoken}. ${model.hint}` : spoken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey]);

  const textColor = theme.colors.callText;
  const muted = theme.colors.callTextMuted;

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.callBackgroundStart }]} accessibilityViewIsModal>
      {renderBackground ? renderBackground() : <CallBackground />}
      <View style={[styles.fill, { paddingTop: safe.top, paddingBottom: safe.bottom, paddingLeft: safe.left, paddingRight: safe.right }]}>
        <View style={{ height: theme.layout.tapTarget + theme.space.sm, flexDirection: "row", alignItems: "center", paddingHorizontal: theme.space.sm }}>
          {onMinimise && model.canMinimise ? (
            <ScalePressable
              onPress={onMinimise}
              accessibilityLabel="Minimise call"
              accessibilityHint="Returns to the app; the call continues"
              style={{ width: theme.layout.tapTarget, height: theme.layout.tapTarget, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="minimise" size={theme.font.size.heading} color={textColor} />
            </ScalePressable>
          ) : null}
        </View>

        <View style={[styles.fill, { alignItems: "center", justifyContent: "center", paddingHorizontal: theme.space.xl }]}>
          <PulseAvatar name={name} id={model.peerId} uri={model.peerAvatar} size={128} pulsing={model.pulse} />
          <Text
            style={{
              marginTop: theme.space.lg,
              fontSize: theme.font.size.display,
              lineHeight: lineHeightFor(theme, theme.font.size.display),
              fontWeight: theme.font.weight.semibold,
              fontFamily: theme.font.nativeFamily,
              color: textColor,
              textAlign: "center",
            }}
            numberOfLines={2}
            accessibilityRole="header"
          >
            {name}
          </Text>
          <Animated.View style={{ opacity: fade, marginTop: theme.space.sm }} accessibilityLiveRegion="polite">
            <Text
              style={{
                fontSize: theme.font.size.title,
                lineHeight: lineHeightFor(theme, theme.font.size.title),
                color: model.tone === "danger" ? textColor : muted,
                fontWeight: model.tone === "danger" ? theme.font.weight.semibold : theme.font.weight.regular,
                fontFamily: theme.font.nativeFamily,
                textAlign: "center",
                fontVariant: model.showTimer ? ["tabular-nums"] : undefined,
              }}
              accessibilityLabel={model.showTimer ? `Call duration ${statusText}` : statusText}
            >
              {statusText}
            </Text>
          </Animated.View>
          {model.hint ? (
            <Text
              style={{
                marginTop: theme.space.md,
                fontSize: theme.font.size.small,
                lineHeight: lineHeightFor(theme, theme.font.size.small),
                color: muted,
                fontFamily: theme.font.nativeFamily,
                textAlign: "center",
                maxWidth: 320,
              }}
            >
              {model.hint}
            </Text>
          ) : null}
        </View>

        <View style={{ paddingBottom: theme.space.xxl, paddingTop: theme.space.lg, minHeight: 120 }}>
          <CallControls
            controls={model.controls}
            isMuted={isMuted}
            isSpeakerOn={isSpeakerOn}
            peerName={name}
            onMute={onToggleMute}
            onSpeaker={onToggleSpeaker}
            onHangup={onHangup}
            onDecline={onDecline}
            onAccept={onAccept}
            onClose={onClose}
            onCallAgain={onCallAgain}
            onMessage={onMessage}
          />
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({ fill: { flex: 1 } });

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const CallScreen = slot("CallScreen", DefaultCallScreen);
