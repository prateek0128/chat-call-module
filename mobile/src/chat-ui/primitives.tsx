/** Small internal building blocks shared by chat-ui components. */
import { slot } from "../theme";
import { memo } from "react";
import { View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { lineHeightFor, type Theme } from "../theme";

export type FontSizeName = keyof Theme["font"]["size"];
export type FontWeightName = keyof Theme["font"]["weight"];

/** Text style from tokens: size, line height, colour, weight, native family. */
export const textStyle = (theme: Theme, size: FontSizeName, color: string, weight: FontWeightName = "regular"): TextStyle => ({
  fontSize: theme.font.size[size],
  lineHeight: lineHeightFor(theme, theme.font.size[size]),
  color,
  fontWeight: theme.font.weight[weight],
  fontFamily: theme.font.nativeFamily,
});

export interface SkeletonBoxProps {
  theme: Theme;
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/** Static placeholder block (no shimmer: calm motion, nothing to stop for reduced motion). */
export const DefaultSkeletonBox = memo(function SkeletonBox({ theme, width, height, radius, style }: SkeletonBoxProps) {
  return <View style={[{ width, height, borderRadius: radius ?? theme.radius.sm, backgroundColor: theme.colors.surfaceSunken }, style]} />;
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const SkeletonBox = slot("SkeletonBox", DefaultSkeletonBox);
