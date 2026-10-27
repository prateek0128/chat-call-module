import { memo } from "react";
import { Text } from "react-native";
import { Icon, ScalePressable, shadowStyle, useTheme } from "../theme";
import { useCallTimer } from "./hooks";

export interface ReturnToCallPillProps {
  onPress: () => void;
  peerName?: string;
  /** Epoch ms when connected: shows the running timer. */
  connectedAt?: number | null;
  /** Shown instead of the timer before the call connects ("Calling…"). */
  status?: string;
}

/** "Return to call · 01:23" pill shown while the call screen is minimised. */
export const ReturnToCallPill = memo(function ReturnToCallPill({ onPress, peerName, connectedAt, status }: ReturnToCallPillProps) {
  const theme = useTheme();
  const timer = useCallTimer(connectedAt);
  const detail = connectedAt ? timer : status || "";
  const label = `Return to call${peerName ? ` with ${peerName}` : ""}${detail ? `, ${detail}` : ""}`;
  return (
    <ScalePressable
      onPress={onPress}
      accessibilityLabel={label}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "center",
          minHeight: theme.layout.tapTarget,
          paddingHorizontal: theme.space.lg,
          borderRadius: theme.radius.pill,
          // Dark call surface keeps callText above 4.5:1 in both schemes.
          backgroundColor: theme.colors.callBackgroundEnd,
        },
        shadowStyle(theme, "md"),
      ]}
    >
      <Icon name="call" size={theme.font.size.body} color={theme.colors.callAccept} />
      <Text
        style={{
          marginLeft: theme.space.sm,
          color: theme.colors.callText,
          fontSize: theme.font.size.small,
          fontWeight: theme.font.weight.semibold,
          fontFamily: theme.font.nativeFamily,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
      >
        {`Return to call${detail ? ` · ${detail}` : ""}`}
      </Text>
    </ScalePressable>
  );
});
