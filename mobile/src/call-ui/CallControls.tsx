import { slot } from "../theme";
import { memo } from "react";
import { View } from "react-native";
import { useTheme, type IconName } from "../theme";
import { CallButton, type CallButtonVariant } from "./CallButton";
import { controlCaption, controlLabel, type CallControlId } from "./callScreenState";

export interface CallControlsProps {
  controls: CallControlId[];
  isMuted?: boolean;
  isSpeakerOn?: boolean;
  peerName?: string;
  onMute?: () => void;
  onSpeaker?: () => void;
  onHangup?: () => void;
  onDecline?: () => void;
  onAccept?: () => void;
  onClose?: () => void;
  onCallAgain?: () => void;
  onMessage?: () => void;
}

const ICONS: Record<CallControlId, IconName> = {
  mute: "micOff",
  speaker: "speaker",
  hangup: "callEnd",
  decline: "callEnd",
  accept: "call",
  close: "close",
  callAgain: "call",
  message: "message",
};

const VARIANTS: Partial<Record<CallControlId, CallButtonVariant>> = { hangup: "hangup", decline: "hangup", accept: "accept", callAgain: "accept" };

/** Row of call buttons for the current phase (order from the state mapping). */
export const DefaultCallControls = memo(function CallControls(props: CallControlsProps) {
  const theme = useTheme();
  const { controls, isMuted = false, isSpeakerOn = false, peerName } = props;
  const handler: Record<CallControlId, (() => void) | undefined> = {
    mute: props.onMute,
    speaker: props.onSpeaker,
    hangup: props.onHangup,
    decline: props.onDecline,
    accept: props.onAccept,
    close: props.onClose,
    callAgain: props.onCallAgain,
    message: props.onMessage,
  };
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "flex-start", paddingHorizontal: theme.space.lg }}>
      {controls
        .filter((id) => !!handler[id])
        .map((id) => {
          const toggle = id === "mute" || id === "speaker";
          const active = id === "mute" ? isMuted : id === "speaker" ? isSpeakerOn : false;
          return (
            <CallButton
              key={id}
              icon={id === "mute" ? (isMuted ? "micOff" : "mic") : id === "speaker" ? (isSpeakerOn ? "speaker" : "speakerOff") : ICONS[id]}
              caption={controlCaption(id, { muted: isMuted, speaker: isSpeakerOn })}
              // Toggles keep a stable label; the on/off state is reported as `checked`.
              accessibilityLabel={controlLabel(id, { peerName })}
              onPress={handler[id] as () => void}
              variant={VARIANTS[id] || "control"}
              active={active}
              toggle={toggle}
              bounce={id === "accept"}
              size={id === "hangup" || id === "accept" || id === "decline" ? 72 : 64}
            />
          );
        })}
    </View>
  );
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const CallControls = slot("CallControls", DefaultCallControls);
