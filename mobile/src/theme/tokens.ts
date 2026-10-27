/**
 * Design tokens. Mirrors ../../../design/tokens.json value for value (a test deep-compares them).
 * Change tokens.json first, then this file. Hosts never edit this: they override through
 * `createTheme(overrides)` / `<ThemeProvider theme={...}>`.
 */

export const colorTokens = {
  light: {
    accent: "#4F46E5",
    accentStrong: "#4338CA",
    accentSoft: "#EEF2FF",
    onAccent: "#FFFFFF",
    background: "#F3F4F6",
    surface: "#FFFFFF",
    surfaceAlt: "#F8FAFC",
    surfaceSunken: "#F1F5F9",
    border: "#E5E7EB",
    text: "#0F172A",
    textMuted: "#64748B",
    textSubtle: "#94A3B8",
    wallpaper: "#EEF0F5",
    bubbleIn: "#FFFFFF",
    bubbleInText: "#0F172A",
    bubbleOut: "#4F46E5",
    bubbleOutText: "#FFFFFF",
    tickOut: "#C7D2FE",
    tickReadOut: "#7DD3FC",
    online: "#22C55E",
    success: "#16A34A",
    danger: "#DC2626",
    warning: "#D97706",
    overlay: "rgba(15, 23, 42, 0.55)",
    callBackgroundStart: "#0F172A",
    callBackgroundEnd: "#1E1B4B",
    callText: "#F8FAFC",
    callTextMuted: "#A5B4FC",
    callControl: "rgba(255, 255, 255, 0.14)",
    callControlActive: "#F8FAFC",
    callAccept: "#16A34A",
    callHangup: "#DC2626",
  },
  dark: {
    accent: "#818CF8",
    accentStrong: "#6366F1",
    accentSoft: "#1E1B4B",
    onAccent: "#0B1020",
    background: "#0B0F19",
    surface: "#111827",
    surfaceAlt: "#1A2233",
    surfaceSunken: "#0F1625",
    border: "#243044",
    text: "#E5E7EB",
    textMuted: "#94A3B8",
    textSubtle: "#64748B",
    wallpaper: "#0B1120",
    bubbleIn: "#1F2937",
    bubbleInText: "#E5E7EB",
    bubbleOut: "#4F46E5",
    bubbleOutText: "#FFFFFF",
    tickOut: "#C7D2FE",
    tickReadOut: "#7DD3FC",
    online: "#22C55E",
    success: "#22C55E",
    danger: "#F87171",
    warning: "#FBBF24",
    overlay: "rgba(0, 0, 0, 0.6)",
    callBackgroundStart: "#020617",
    callBackgroundEnd: "#1E1B4B",
    callText: "#F8FAFC",
    callTextMuted: "#A5B4FC",
    callControl: "rgba(255, 255, 255, 0.12)",
    callControlActive: "#F8FAFC",
    callAccept: "#16A34A",
    callHangup: "#DC2626",
  },
};

export type ColorScheme = "light" | "dark";
export type ColorName = keyof typeof colorTokens.light;
export type ColorTokens = Record<ColorName, string>;

export const avatarPalette: string[] = ["#6366F1", "#0EA5E9", "#14B8A6", "#F59E0B", "#EF4444", "#A855F7", "#EC4899", "#64748B"];

export const radius = { sm: 6, md: 10, lg: 16, xl: 22, bubble: 18, pill: 999 };
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export type FontWeight = "400" | "500" | "600" | "700";

export const font = {
  family: 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif',
  size: { caption: 12, small: 13, body: 15, title: 17, heading: 22, display: 28 },
  weight: { regular: "400", medium: "500", semibold: "600", bold: "700" } as Record<"regular" | "medium" | "semibold" | "bold", FontWeight>,
  lineHeight: 1.4,
};

export interface ShadowToken {
  css: string;
  rn: { shadowOpacity: number; shadowRadius: number; shadowOffsetY: number; elevation: number };
}

export const shadow: Record<"sm" | "md" | "lg", ShadowToken> = {
  sm: { css: "0 1px 2px rgba(15, 23, 42, 0.08)", rn: { shadowOpacity: 0.08, shadowRadius: 2, shadowOffsetY: 1, elevation: 1 } },
  md: { css: "0 4px 12px rgba(15, 23, 42, 0.10)", rn: { shadowOpacity: 0.1, shadowRadius: 12, shadowOffsetY: 4, elevation: 4 } },
  lg: { css: "0 12px 32px rgba(15, 23, 42, 0.18)", rn: { shadowOpacity: 0.18, shadowRadius: 32, shadowOffsetY: 12, elevation: 12 } },
};

export type CubicBezier = [number, number, number, number];

export const motion = {
  duration: { fast: 120, base: 200, slow: 320 },
  easing: {
    standard: [0.2, 0, 0, 1] as CubicBezier,
    decelerate: [0, 0, 0, 1] as CubicBezier,
    accelerate: [0.3, 0, 1, 1] as CubicBezier,
  },
};

export const layout = {
  listWidthMin: 300,
  listWidthMax: 400,
  bubbleMaxWidthPct: 72,
  breakpointTablet: 700,
  breakpointDesktop: 1024,
  composerMaxLines: 6,
  tapTarget: 44,
};

/** Chat theme names, in display order (tokens.json -> themePresets.order). */
export type PresetName = "indigo" | "rose" | "emerald" | "ocean" | "amber" | "violet" | "graphite";

/** Colour keys a chat theme preset overrides (on top of color.light / color.dark). */
export type PresetColorKey = "accent" | "accentStrong" | "accentSoft" | "onAccent" | "bubbleOut" | "bubbleOutText" | "tickOut" | "tickReadOut";

export type PresetColors = Record<PresetColorKey, string>;

/** Chat themes. Each preset overrides the accent family + outgoing bubbles; "indigo" equals the base tokens. */
export const themePresets: {
  order: PresetName[];
  labels: Record<PresetName, string>;
  light: Record<PresetName, PresetColors>;
  dark: Record<PresetName, PresetColors>;
} = {
  order: [
    "indigo",
    "rose",
    "emerald",
    "ocean",
    "amber",
    "violet",
    "graphite"
  ],
  labels: {
    indigo: "Indigo",
    rose: "Rose",
    emerald: "Emerald",
    ocean: "Ocean",
    amber: "Amber",
    violet: "Violet",
    graphite: "Graphite"
  },
  light: {
    indigo: {
      accent: "#4F46E5",
      accentStrong: "#4338CA",
      accentSoft: "#EEF2FF",
      onAccent: "#FFFFFF",
      bubbleOut: "#4F46E5",
      bubbleOutText: "#FFFFFF",
      tickOut: "#C7D2FE",
      tickReadOut: "#7DD3FC"
    },
    rose: {
      accent: "#E11D48",
      accentStrong: "#BE123C",
      accentSoft: "#FFE4E6",
      onAccent: "#FFFFFF",
      bubbleOut: "#E11D48",
      bubbleOutText: "#FFFFFF",
      tickOut: "#FECDD3",
      tickReadOut: "#BFDBFE"
    },
    emerald: {
      accent: "#047857",
      accentStrong: "#065F46",
      accentSoft: "#D1FAE5",
      onAccent: "#FFFFFF",
      bubbleOut: "#047857",
      bubbleOutText: "#FFFFFF",
      tickOut: "#A7F3D0",
      tickReadOut: "#BAE6FD"
    },
    ocean: {
      accent: "#0369A1",
      accentStrong: "#075985",
      accentSoft: "#E0F2FE",
      onAccent: "#FFFFFF",
      bubbleOut: "#0369A1",
      bubbleOutText: "#FFFFFF",
      tickOut: "#93C5FD",
      tickReadOut: "#FFFFFF"
    },
    amber: {
      accent: "#B45309",
      accentStrong: "#92400E",
      accentSoft: "#FEF3C7",
      onAccent: "#FFFFFF",
      bubbleOut: "#B45309",
      bubbleOutText: "#FFFFFF",
      tickOut: "#FDE68A",
      tickReadOut: "#BAE6FD"
    },
    violet: {
      accent: "#7C3AED",
      accentStrong: "#6D28D9",
      accentSoft: "#EDE9FE",
      onAccent: "#FFFFFF",
      bubbleOut: "#7C3AED",
      bubbleOutText: "#FFFFFF",
      tickOut: "#DDD6FE",
      tickReadOut: "#7DD3FC"
    },
    graphite: {
      accent: "#334155",
      accentStrong: "#1E293B",
      accentSoft: "#E2E8F0",
      onAccent: "#FFFFFF",
      bubbleOut: "#334155",
      bubbleOutText: "#FFFFFF",
      tickOut: "#CBD5E1",
      tickReadOut: "#7DD3FC"
    }
  },
  dark: {
    indigo: {
      accent: "#818CF8",
      accentStrong: "#6366F1",
      accentSoft: "#1E1B4B",
      onAccent: "#0B1020",
      bubbleOut: "#4F46E5",
      bubbleOutText: "#FFFFFF",
      tickOut: "#C7D2FE",
      tickReadOut: "#7DD3FC"
    },
    rose: {
      accent: "#FB7185",
      accentStrong: "#F43F5E",
      accentSoft: "#4C0519",
      onAccent: "#1F0710",
      bubbleOut: "#BE123C",
      bubbleOutText: "#FFFFFF",
      tickOut: "#FECDD3",
      tickReadOut: "#7DD3FC"
    },
    emerald: {
      accent: "#34D399",
      accentStrong: "#10B981",
      accentSoft: "#022C22",
      onAccent: "#022C22",
      bubbleOut: "#047857",
      bubbleOutText: "#FFFFFF",
      tickOut: "#A7F3D0",
      tickReadOut: "#7DD3FC"
    },
    ocean: {
      accent: "#38BDF8",
      accentStrong: "#0EA5E9",
      accentSoft: "#082F49",
      onAccent: "#04202F",
      bubbleOut: "#0369A1",
      bubbleOutText: "#FFFFFF",
      tickOut: "#93C5FD",
      tickReadOut: "#FFFFFF"
    },
    amber: {
      accent: "#FBBF24",
      accentStrong: "#F59E0B",
      accentSoft: "#451A03",
      onAccent: "#1C1003",
      bubbleOut: "#B45309",
      bubbleOutText: "#FFFFFF",
      tickOut: "#FDE68A",
      tickReadOut: "#7DD3FC"
    },
    violet: {
      accent: "#A78BFA",
      accentStrong: "#8B5CF6",
      accentSoft: "#2E1065",
      onAccent: "#150A2E",
      bubbleOut: "#6D28D9",
      bubbleOutText: "#FFFFFF",
      tickOut: "#DDD6FE",
      tickReadOut: "#7DD3FC"
    },
    graphite: {
      accent: "#CBD5E1",
      accentStrong: "#94A3B8",
      accentSoft: "#1E293B",
      onAccent: "#0F172A",
      bubbleOut: "#334155",
      bubbleOutText: "#FFFFFF",
      tickOut: "#CBD5E1",
      tickReadOut: "#7DD3FC"
    }
  }
};

export interface WallpaperSchemeTokens {
  solids: string[];
  gradients: [string, string][];
  imageDimDefault: number;
}

/** Chat backgrounds: indexed solids/gradients per scheme, image dim limits. */
export const wallpapers: { light: WallpaperSchemeTokens; dark: WallpaperSchemeTokens; imageDimMax: number; imageMaxEdge: number } = {
  light: {
    solids: [
      "#EEF0F5",
      "#E8F1EC",
      "#F3ECE4",
      "#E6EEF6",
      "#F1E8F0",
      "#ECEAF6",
      "#F5F0DC",
      "#E5E7EB"
    ],
    gradients: [
      [
        "#E0E7FF",
        "#FCE7F3"
      ],
      [
        "#DCFCE7",
        "#E0F2FE"
      ],
      [
        "#FEF3C7",
        "#FFE4E6"
      ],
      [
        "#E0F2FE",
        "#EDE9FE"
      ],
      [
        "#F1F5F9",
        "#E2E8F0"
      ]
    ],
    imageDimDefault: 0
  },
  dark: {
    solids: [
      "#0B1120",
      "#0F1F1A",
      "#1C1712",
      "#0C1824",
      "#1C1020",
      "#15132A",
      "#1C1A0E",
      "#111827"
    ],
    gradients: [
      [
        "#1E1B4B",
        "#3B0A2A"
      ],
      [
        "#052E2B",
        "#0C2A43"
      ],
      [
        "#3A2306",
        "#3B0B1A"
      ],
      [
        "#0C2A43",
        "#2E1065"
      ],
      [
        "#0F172A",
        "#1E293B"
      ]
    ],
    imageDimDefault: 0.35
  },
  imageDimMax: 0.8,
  imageMaxEdge: 1600
};

/** Everything in tokens.json except the `$comment` keys. */
export const tokens = {
  color: colorTokens,
  avatarPalette,
  radius,
  space,
  font,
  shadow,
  motion,
  layout,
  themePresets,
  wallpapers,
};

export type Tokens = typeof tokens;
