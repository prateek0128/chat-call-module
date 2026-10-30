import { slot } from "./slots";
import { memo } from "react";
import { Text } from "react-native";
import { DEFAULT_GLYPHS, type IconName } from "./iconNames";
import { useIconRenderer, useTheme } from "./ThemeProvider";

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

/** Glyph icon, or the host's icon via `<ThemeProvider renderIcon>`. Decorative: label the button, not the icon. */
export const DefaultIcon = memo(function Icon({ name, size, color }: IconProps) {
  const theme = useTheme();
  const render = useIconRenderer();
  const s = size ?? theme.font.size.title;
  const c = color ?? theme.colors.text;
  const custom = render ? render(name, { size: s, color: c }) : undefined;
  if (custom !== undefined && custom !== null) return <>{custom}</>;
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      allowFontScaling={false}
      style={{ fontSize: s, lineHeight: Math.round(s * 1.2), color: c, textAlign: "center", fontFamily: theme.font.nativeFamily }}
    >
      {DEFAULT_GLYPHS[name]}
    </Text>
  );
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const Icon = slot("Icon", DefaultIcon);
