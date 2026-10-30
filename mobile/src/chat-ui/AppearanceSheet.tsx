/**
 * Appearance bottom sheet: live preview, Mode, Theme swatches, Wallpaper tiles, Dim (images) and,
 * with a `peerId`, Scope ("This chat" / "All chats" + "Reset this chat"). Changes apply instantly
 * through `useAppearance()`; there is no Save button. Needs an <AppearanceProvider> above it.
 */
import { slot } from "../theme";
import { memo, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, type AccessibilityActionEvent } from "react-native";
import {
  announce,
  clampDim,
  Icon,
  ScalePressable,
  themePresets,
  useAppearance,
  useReducedMotion,
  useTheme,
  wallpapers,
  type AppearanceMode,
  type Density,
  type TextSize,
  type Theme,
  type Wallpaper,
} from "../theme";
import { ChatWallpaper, type GradientRenderProps } from "./ChatWallpaper";
import { textStyle } from "./primitives";

export interface PickedWallpaperImage {
  uri: string;
  width?: number;
  height?: number;
}

export interface AppearanceSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Per-chat mode: the chat the "This chat" scope applies to. Omit for global mode. */
  peerId?: string | null;
  /**
   * Picks a wallpaper image (e.g. expo-image-picker). Shows the "Choose image…" tile. Resolve null on
   * cancel. Downscale to `maxEdge` (wallpapers.imageMaxEdge, 1600 px) and copy it somewhere
   * persistent before resolving: the kit stores only the uri.
   */
  pickImage?: (options: { maxEdge: number }) => Promise<PickedWallpaperImage | null>;
  /** Gradient renderer for the tiles / preview (default: expo-linear-gradient if installed). */
  renderGradient?: (props: GradientRenderProps) => ReactNode;
  /** Bottom safe-area inset. */
  insetBottom?: number;
  title?: string;
}

const TEXT_SIZE_LABELS: Array<[TextSize, string]> = [
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
];
const DENSITY_LABELS: Array<[Density, string]> = [
  ["comfortable", "Comfortable"],
  ["compact", "Compact"],
];

const MODES: Array<[AppearanceMode, string]> = [
  ["system", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const DIM_STEP = 0.1;

const sameWallpaper = (a: Wallpaper, b: Wallpaper): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "solid" || a.kind === "gradient") return a.index === (b as typeof a).index;
  if (a.kind === "image") return a.uri === (b as typeof a).uri;
  return true;
};

export const DefaultAppearanceSheet = memo(function AppearanceSheet({
  visible,
  onClose,
  peerId,
  pickImage,
  renderGradient,
  insetBottom = 0,
  title,
}: AppearanceSheetProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const reduced = useReducedMotion();
  const appearance = useAppearance();
  const [scope, setScope] = useState<"chat" | "all">(peerId ? "chat" : "all");
  useEffect(() => {
    if (visible) setScope(peerId ? "chat" : "all");
  }, [visible, peerId]);

  const target = peerId && scope === "chat" ? peerId : null;
  const current: Wallpaper = target ? appearance.wallpaperFor(target) : peerId ? appearance.wallpaperFor(peerId) : appearance.wallpaper;
  const hasOverride = !!peerId && appearance.hasOverride(peerId);

  const choose = useCallback(
    (w: Wallpaper) => {
      if (target) appearance.setWallpaper(w, { peerId: target });
      else {
        appearance.setWallpaper(w);
        // "All chats" from inside a chat: drop this chat's override so the choice shows here too.
        if (peerId && appearance.hasOverride(peerId)) appearance.resetWallpaper(peerId);
      }
    },
    [appearance, target, peerId],
  );

  const [picking, setPicking] = useState(false);
  const onPickImage = useCallback(async () => {
    if (!pickImage || picking) return;
    setPicking(true);
    try {
      const img = await pickImage({ maxEdge: wallpapers.imageMaxEdge });
      if (img && img.uri) choose({ kind: "image", uri: img.uri });
    } catch {
      announce("Couldn't open the image picker");
    } finally {
      setPicking(false);
    }
  }, [pickImage, picking, choose]);

  const dim = current.kind === "image" ? clampDim(current.dim, theme.scheme) : 0;
  const setDim = useCallback(
    (d: number) => {
      if (current.kind !== "image") return;
      choose({ kind: "image", uri: current.uri, dim: clampDim(d, theme.scheme) });
    },
    [current, choose, theme.scheme],
  );

  if (!visible) return null;

  const tiles: Array<{ key: string; label: string; wallpaper: Wallpaper }> = [
    { key: "default", label: "Default wallpaper", wallpaper: { kind: "default" } },
    ...wallpapers[theme.scheme].solids.map((_, i) => ({ key: `solid-${i}`, label: `Colour ${i + 1}`, wallpaper: { kind: "solid", index: i } as Wallpaper })),
    ...wallpapers[theme.scheme].gradients.map((_, i) => ({ key: `gradient-${i}`, label: `Gradient ${i + 1}`, wallpaper: { kind: "gradient", index: i } as Wallpaper })),
  ];
  if (current.kind === "image") tiles.push({ key: "image", label: "Current photo", wallpaper: current });

  return (
    <Modal visible transparent animationType={reduced ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close appearance" />
        <View style={[s.sheet, { paddingBottom: insetBottom + theme.space.lg }]} accessibilityViewIsModal>
          <View style={s.header}>
            <Text style={s.title} accessibilityRole="header">
              {title ?? (peerId ? "Wallpaper" : "Appearance")}
            </Text>
            <ScalePressable onPress={onClose} accessibilityLabel="Done" style={s.done}>
              <Text style={s.doneText}>Done</Text>
            </ScalePressable>
          </View>
          <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
            {/* Live preview */}
            <ChatWallpaper wallpaper={current} renderGradient={renderGradient} style={s.preview} testID="appearance-preview">
              <View style={[s.bubble, s.bubbleIn]} accessible accessibilityLabel="Preview, incoming message">
                <Text style={textStyle(theme, "small", theme.colors.bubbleInText)}>Hi! How does this look?</Text>
              </View>
              <View style={[s.bubble, s.bubbleOut]} accessible accessibilityLabel="Preview, outgoing message">
                <Text style={textStyle(theme, "small", theme.colors.bubbleOutText)}>Looks great 👍</Text>
              </View>
            </ChatWallpaper>

            {/* Mode */}
            <Text style={s.section}>Mode</Text>
            <View style={s.segmented} accessibilityRole="radiogroup" accessibilityLabel="Mode">
              {MODES.map(([mode, label]) => {
                const on = appearance.mode === mode;
                return (
                  <Pressable
                    key={mode}
                    onPress={() => appearance.setMode(mode)}
                    style={[s.segment, on && s.segmentOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={label}
                  >
                    <Text style={[s.segmentText, on && s.segmentTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Text size */}
            <Text style={s.section}>Text size</Text>
            <View style={s.segmented} accessibilityRole="radiogroup" accessibilityLabel="Text size">
              {TEXT_SIZE_LABELS.map(([size, label]) => {
                const on = appearance.textSize === size;
                return (
                  <Pressable key={size} onPress={() => appearance.setTextSize(size)} style={[s.segment, on && s.segmentOn]} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={label}>
                    <Text style={[s.segmentText, on && s.segmentTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Density */}
            <Text style={s.section}>Density</Text>
            <View style={s.segmented} accessibilityRole="radiogroup" accessibilityLabel="Density">
              {DENSITY_LABELS.map(([density, label]) => {
                const on = appearance.density === density;
                return (
                  <Pressable key={density} onPress={() => appearance.setDensity(density)} style={[s.segment, on && s.segmentOn]} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={label}>
                    <Text style={[s.segmentText, on && s.segmentTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Theme */}
            <Text style={s.section}>Theme</Text>
            <View style={s.swatches} accessibilityRole="radiogroup" accessibilityLabel="Theme">
              {themePresets.order.map((name) => {
                const on = appearance.preset === name;
                const colors = themePresets[theme.scheme][name];
                return (
                  <Pressable
                    key={name}
                    onPress={() => appearance.setPreset(name)}
                    style={[s.swatch, { backgroundColor: colors.bubbleOut }, on && { borderColor: theme.colors.text }]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${themePresets.labels[name]} theme`}
                  >
                    {on ? <Icon name="check" size={theme.font.size.title} color={colors.bubbleOutText} /> : null}
                  </Pressable>
                );
              })}
            </View>

            {/* Wallpaper */}
            <Text style={s.section}>Wallpaper</Text>
            <View style={s.tiles} accessibilityRole="radiogroup" accessibilityLabel="Wallpaper">
              {tiles.map((t) => {
                const on = sameWallpaper(current, t.wallpaper);
                return (
                  <Pressable
                    key={t.key}
                    onPress={() => choose(t.wallpaper)}
                    style={[s.tile, on && s.tileOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={t.label}
                  >
                    {t.wallpaper.kind === "image" ? (
                      <Image source={{ uri: t.wallpaper.uri }} resizeMode="cover" style={s.tileFill} />
                    ) : (
                      <ChatWallpaper wallpaper={t.wallpaper} renderGradient={renderGradient} style={s.tileFill} />
                    )}
                    {on ? (
                      <View style={s.tileCheck}>
                        <Icon name="check" size={theme.font.size.small} color={theme.colors.onAccent} />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
              {pickImage ? (
                <Pressable
                  onPress={onPickImage}
                  disabled={picking}
                  style={[s.tile, s.tileAction]}
                  accessibilityRole="button"
                  accessibilityLabel="Choose image…"
                  accessibilityState={{ busy: picking, disabled: picking }}
                >
                  <Icon name="image" size={theme.font.size.title} color={theme.colors.textMuted} />
                  <Text style={s.tileActionText} numberOfLines={2}>
                    Choose image…
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {/* Dim (images only) */}
            {current.kind === "image" ? <DimControl theme={theme} value={dim} onChange={setDim} /> : null}

            {/* Scope (per-chat mode only) */}
            {peerId ? (
              <>
                <Text style={s.section}>Apply to</Text>
                <View style={s.segmented} accessibilityRole="radiogroup" accessibilityLabel="Apply wallpaper to">
                  {(
                    [
                      ["chat", "This chat"],
                      ["all", "All chats"],
                    ] as const
                  ).map(([value, label]) => {
                    const on = scope === value;
                    return (
                      <Pressable
                        key={value}
                        onPress={() => setScope(value)}
                        style={[s.segment, on && s.segmentOn]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={label}
                      >
                        <Text style={[s.segmentText, on && s.segmentTextOn]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <ScalePressable
                  onPress={() => peerId && appearance.resetWallpaper(peerId)}
                  disabled={!hasOverride}
                  accessibilityLabel="Reset this chat"
                  accessibilityHint="Uses the wallpaper for all chats"
                  style={[s.reset, !hasOverride && { opacity: 0.5 }]}
                >
                  <Text style={s.resetText}>Reset this chat</Text>
                </ScalePressable>
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

/** Accessible stepper slider: − / bar / +, adjustable for screen readers (no slider dependency). */
const DimControl = ({ theme, value, onChange }: { theme: Theme; value: number; onChange: (v: number) => void }) => {
  const s = useStyles(theme);
  const max = wallpapers.imageDimMax;
  const pct = Math.round(value * 100);
  const step = (dir: 1 | -1) => onChange(Math.round((value + dir * DIM_STEP) * 100) / 100);
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "increment") step(1);
    if (e.nativeEvent.actionName === "decrement") step(-1);
  };
  return (
    <>
      <Text style={s.section}>Dim</Text>
      <View style={s.dimRow}>
        <ScalePressable onPress={() => step(-1)} disabled={value <= 0} accessibilityLabel="Less dim" style={s.dimButton}>
          <Text style={s.dimButtonText}>−</Text>
        </ScalePressable>
        <View
          style={s.dimTrack}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Dim"
          accessibilityValue={{ min: 0, max: Math.round(max * 100), now: pct, text: `${pct}%` }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={onAction}
          testID="dim-slider"
        >
          <View style={[s.dimFill, { width: `${Math.round((value / max) * 100)}%` as `${number}%` }]} />
        </View>
        <ScalePressable onPress={() => step(1)} disabled={value >= max} accessibilityLabel="More dim" style={s.dimButton}>
          <Text style={s.dimButtonText}>+</Text>
        </ScalePressable>
        <Text style={s.dimValue}>{pct}%</Text>
      </View>
    </>
  );
};

const TILE = 64;

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: theme.colors.overlay },
        sheet: {
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.lg,
          borderTopRightRadius: theme.radius.lg,
          maxHeight: "90%",
        },
        header: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.space.lg, paddingTop: theme.space.md },
        title: { ...textStyle(theme, "title", theme.colors.text, "semibold"), flex: 1 },
        done: { minHeight: theme.layout.tapTarget, minWidth: theme.layout.tapTarget, justifyContent: "center", alignItems: "flex-end" },
        doneText: textStyle(theme, "body", theme.colors.accent, "semibold"),
        content: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.lg },
        preview: { height: 132, borderRadius: theme.radius.md, padding: theme.space.md, justifyContent: "center", marginTop: theme.space.sm },
        bubble: { maxWidth: "75%", paddingHorizontal: theme.space.md, paddingVertical: theme.space.sm, borderRadius: theme.radius.bubble, marginVertical: theme.space.xs },
        bubbleIn: { alignSelf: "flex-start", backgroundColor: theme.colors.bubbleIn },
        bubbleOut: { alignSelf: "flex-end", backgroundColor: theme.colors.bubbleOut },
        section: { ...textStyle(theme, "small", theme.colors.textMuted, "semibold"), marginTop: theme.space.lg, marginBottom: theme.space.sm },
        segmented: { flexDirection: "row", backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.md, padding: theme.space.xxs },
        segment: { flex: 1, minHeight: theme.layout.tapTarget - 4, alignItems: "center", justifyContent: "center", borderRadius: theme.radius.sm },
        segmentOn: { backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
        segmentText: textStyle(theme, "small", theme.colors.textMuted, "medium"),
        segmentTextOn: textStyle(theme, "small", theme.colors.text, "semibold"),
        swatches: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.md },
        swatch: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          borderRadius: theme.radius.pill,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 2,
          borderColor: "transparent",
        },
        tiles: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
        tile: { width: TILE, height: TILE, borderRadius: theme.radius.md, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border },
        tileOn: { borderWidth: 2, borderColor: theme.colors.accent },
        tileFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
        tileCheck: {
          position: "absolute",
          right: theme.space.xs,
          bottom: theme.space.xs,
          width: 20,
          height: 20,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        },
        tileAction: { alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceSunken, padding: theme.space.xs },
        tileActionText: { ...textStyle(theme, "caption", theme.colors.textMuted), textAlign: "center" },
        dimRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
        dimButton: {
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surfaceSunken,
          alignItems: "center",
          justifyContent: "center",
        },
        dimButtonText: textStyle(theme, "title", theme.colors.text, "semibold"),
        dimTrack: { flex: 1, height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.colors.surfaceSunken, overflow: "hidden" },
        dimFill: { height: 8, backgroundColor: theme.colors.accent },
        dimValue: { ...textStyle(theme, "small", theme.colors.textMuted), minWidth: 40, textAlign: "right" },
        reset: { minHeight: theme.layout.tapTarget, justifyContent: "center", marginTop: theme.space.sm },
        resetText: textStyle(theme, "body", theme.colors.danger, "medium"),
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const AppearanceSheet = slot("AppearanceSheet", DefaultAppearanceSheet);
