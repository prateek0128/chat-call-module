import { memo, useEffect, useState } from "react";
import { Image, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { avatarColor, initialsOf } from "./avatarColors";
import { useTheme } from "./ThemeProvider";

export interface AvatarProps {
  /** Display name (initials + accessibility label). */
  name?: string | null;
  /** Stable key for the palette colour (user id). Defaults to `name`. */
  id?: string | null;
  uri?: string | null;
  /** Diameter (default 48: list rows; 40 headers; 128 call screens). */
  size?: number;
  /** Shows a presence dot when true (online). */
  online?: boolean;
  /** Ring colour around the presence dot (the surface the avatar sits on). */
  ringColor?: string;
  style?: StyleProp<ViewStyle>;
}

/** Image avatar with an initials fallback on a palette colour, plus an optional presence dot. */
export const Avatar = memo(function Avatar({ name, id, uri, size = 48, online, ringColor, style }: AvatarProps) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const bg = avatarColor(id || name || "", theme.avatarPalette);
  const dot = Math.max(10, Math.round(size * 0.26));
  const showImage = !!uri && !failed;
  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {showImage ? (
        <Image
          source={{ uri: uri as string }}
          onError={() => setFailed(true)}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.surfaceSunken }}
        />
      ) : (
        <View
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}
        >
          <Text
            allowFontScaling={false}
            style={{ color: theme.colors.callText, fontSize: Math.round(size * 0.38), fontWeight: theme.font.weight.semibold, fontFamily: theme.font.nativeFamily }}
          >
            {initialsOf(name)}
          </Text>
        </View>
      )}
      {online ? (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: theme.colors.online,
            borderWidth: 2,
            borderColor: ringColor || theme.colors.surface,
          }}
        />
      ) : null}
    </View>
  );
});
