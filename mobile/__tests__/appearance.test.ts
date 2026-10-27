/** Appearance: theme presets, wallpaper render model, per-chat overrides, persistence. */
import { colorTokens, themePresets, wallpapers } from "../src/theme/tokens";
import { createTheme, isPresetName } from "../src/theme/createTheme";
import {
  applyWallpaper,
  clampDim,
  DEFAULT_APPEARANCE,
  parseAppearance,
  removeWallpaperOverride,
  resolveWallpaper,
  sanitizeWallpaper,
  serializeAppearance,
  wallpaperForPeer,
  type AppearanceState,
} from "../src/theme/appearance";
import { createMemoryStorage, loadAppearance, saveAppearance, APPEARANCE_STORAGE_KEY } from "../src/theme/appearanceStorage";
import { parseColor } from "../src/theme/color";

const PRESET_KEYS = ["accent", "accentStrong", "accentSoft", "onAccent", "bubbleOut", "bubbleOutText", "tickOut", "tickReadOut"] as const;

describe("theme presets", () => {
  it.each(["light", "dark"] as const)("indigo equals the %s base", (scheme) => {
    expect(createTheme({ preset: "indigo" }, scheme).colors).toEqual(colorTokens[scheme]);
    for (const k of PRESET_KEYS) expect(themePresets[scheme].indigo[k]).toBe(colorTokens[scheme][k]);
  });

  it.each(["light", "dark"] as const)("rose changes accent + outgoing bubble only (%s)", (scheme) => {
    const t = createTheme({ preset: "rose" }, scheme);
    expect(t.colors.accent).toBe(themePresets[scheme].rose.accent);
    expect(t.colors.bubbleOut).toBe(themePresets[scheme].rose.bubbleOut);
    expect(t.colors.accent).not.toBe(colorTokens[scheme].accent);
    expect(t.colors.bubbleOut).not.toBe(colorTokens[scheme].bubbleOut);
    expect(t.colors.surface).toBe(colorTokens[scheme].surface);
    expect(t.colors.wallpaper).toBe(colorTokens[scheme].wallpaper);
    expect(t.colors.bubbleIn).toBe(colorTokens[scheme].bubbleIn);
  });

  it("every preset applies all its keys in both schemes; host colour overrides still win", () => {
    for (const scheme of ["light", "dark"] as const)
      for (const name of themePresets.order) {
        const t = createTheme({ preset: name }, scheme);
        for (const k of PRESET_KEYS) expect(t.colors[k]).toBe(themePresets[scheme][name][k]);
      }
    expect(createTheme({ preset: "rose", colors: { accent: "#123456" } }, "light").colors.accent).toBe("#123456");
  });

  it("unknown preset falls back to the base", () => {
    expect(createTheme({ preset: "nope" as any }, "light").colors).toEqual(colorTokens.light);
    expect(isPresetName("ocean")).toBe(true);
    expect(isPresetName("constructor")).toBe(false);
  });

  it("white bubble text reaches 4.5:1 on every outgoing bubble", () => {
    const lum = (hex: string) => {
      const c = parseColor(hex)!;
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    for (const scheme of ["light", "dark"] as const)
      for (const name of themePresets.order) {
        const p = themePresets[scheme][name];
        expect(ratio(p.bubbleOutText, p.bubbleOut)).toBeGreaterThanOrEqual(4.5);
      }
  });
});

describe("resolveWallpaper", () => {
  it.each(["light", "dark"] as const)("default = theme wallpaper colour + pattern (%s)", (scheme) => {
    expect(resolveWallpaper({ kind: "default" }, scheme)).toEqual({ kind: "color", color: colorTokens[scheme].wallpaper, pattern: true });
    expect(resolveWallpaper(null, scheme, "#ABCDEF")).toEqual({ kind: "color", color: "#ABCDEF", pattern: true });
  });

  it.each(["light", "dark"] as const)("solid / gradient indexes follow the scheme (%s)", (scheme) => {
    expect(resolveWallpaper({ kind: "solid", index: 2 }, scheme)).toEqual({ kind: "color", color: wallpapers[scheme].solids[2], pattern: false });
    const g = resolveWallpaper({ kind: "gradient", index: 1 }, scheme);
    expect(g).toEqual({
      kind: "gradient",
      colors: wallpapers[scheme].gradients[1],
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      fallbackColor: wallpapers[scheme].gradients[1][0],
    });
  });

  it("out-of-range indexes fall back to default", () => {
    expect(resolveWallpaper({ kind: "solid", index: 99 }, "light")).toMatchObject({ kind: "color", pattern: true });
    expect(resolveWallpaper({ kind: "gradient", index: -1 }, "dark")).toMatchObject({ kind: "color", pattern: true });
  });

  it("image: white overlay in light, black in dark, scheme default dim, clamped", () => {
    expect(resolveWallpaper({ kind: "image", uri: "file:///a.jpg" }, "light")).toEqual({
      kind: "image",
      uri: "file:///a.jpg",
      fallbackColor: colorTokens.light.wallpaper,
      overlayColor: "#FFFFFF",
      overlayOpacity: 0,
    });
    expect(resolveWallpaper({ kind: "image", uri: "file:///a.jpg" }, "dark")).toMatchObject({ overlayColor: "#000000", overlayOpacity: 0.35 });
    expect(resolveWallpaper({ kind: "image", uri: "file:///a.jpg", dim: 5 }, "dark")).toMatchObject({ overlayOpacity: wallpapers.imageDimMax });
    expect(resolveWallpaper({ kind: "image", uri: "file:///a.jpg", dim: 0.5 }, "light")).toMatchObject({ overlayOpacity: 0.5 });
    expect(resolveWallpaper({ kind: "image", uri: "" }, "light")).toMatchObject({ kind: "color", pattern: true });
  });

  it("clampDim", () => {
    expect(clampDim(-1)).toBe(0);
    expect(clampDim(0.8)).toBe(0.8);
    expect(clampDim(0.95)).toBe(0.8);
    expect(clampDim(undefined, "dark")).toBe(0.35);
    expect(clampDim(NaN, "light")).toBe(0);
    expect(clampDim("0.5" as any, "dark")).toBe(0.35);
  });
});

describe("per-chat wallpaper", () => {
  const base: AppearanceState = { ...DEFAULT_APPEARANCE, perChat: {} };

  it("override wins over the global wallpaper; reset removes it", () => {
    let s = applyWallpaper(base, { kind: "solid", index: 1 });
    s = applyWallpaper(s, { kind: "gradient", index: 0 }, "peer-1");
    expect(wallpaperForPeer(s, "peer-1")).toEqual({ kind: "gradient", index: 0 });
    expect(wallpaperForPeer(s, "peer-2")).toEqual({ kind: "solid", index: 1 });
    expect(wallpaperForPeer(s)).toEqual({ kind: "solid", index: 1 });
    // A later global change does not touch the override.
    s = applyWallpaper(s, { kind: "solid", index: 3 });
    expect(wallpaperForPeer(s, "peer-1")).toEqual({ kind: "gradient", index: 0 });
    s = removeWallpaperOverride(s, "peer-1");
    expect(wallpaperForPeer(s, "peer-1")).toEqual({ kind: "solid", index: 3 });
    expect(removeWallpaperOverride(s, "peer-1")).toBe(s);
  });

  it("does not mutate the previous state", () => {
    const s = applyWallpaper(base, { kind: "solid", index: 1 }, "p");
    expect(base.perChat).toEqual({});
    expect(s.perChat.p).toEqual({ kind: "solid", index: 1 });
  });

  it("sanitizes untrusted wallpapers", () => {
    expect(sanitizeWallpaper({ kind: "image", uri: "x", dim: 9 })).toEqual({ kind: "image", uri: "x", dim: 0.8 });
    expect(sanitizeWallpaper({ kind: "solid", index: 1.5 })).toEqual({ kind: "default" });
    expect(sanitizeWallpaper("solid")).toEqual({ kind: "default" });
  });
});

describe("persistence", () => {
  const state: AppearanceState = {
    mode: "dark",
    preset: "emerald",
    wallpaper: { kind: "gradient", index: 2 },
    perChat: { "peer-1": { kind: "image", uri: "file:///w.jpg", dim: 0.4 }, "peer-2": { kind: "solid", index: 0 } },
  };

  it("serialize/parse round-trips", () => {
    expect(parseAppearance(serializeAppearance(state))).toEqual(state);
  });

  it("corrupted or foreign data falls back to safe defaults", () => {
    expect(parseAppearance("{not json")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("42")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(JSON.stringify({ mode: "neon", preset: "pink", wallpaper: { kind: "solid", index: 100 }, perChat: [1] }))).toEqual(DEFAULT_APPEARANCE);
    // Partially valid data keeps the valid parts.
    expect(parseAppearance(JSON.stringify({ mode: "light", perChat: { a: { kind: "bogus" } } }))).toEqual({
      ...DEFAULT_APPEARANCE,
      mode: "light",
      perChat: { a: { kind: "default" } },
    });
  });

  it("storage round-trip through an adapter; read errors and corrupted values -> defaults", async () => {
    const storage = createMemoryStorage();
    await saveAppearance(storage, state);
    expect(typeof storage.data[APPEARANCE_STORAGE_KEY]).toBe("string");
    expect(await loadAppearance(storage)).toEqual(state);
    storage.data[APPEARANCE_STORAGE_KEY] = "\u0000garbage";
    expect(await loadAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
    const failing = { getItem: () => Promise.reject(new Error("io")), setItem: () => Promise.reject(new Error("full")), removeItem: () => Promise.resolve() };
    expect(await loadAppearance(failing)).toEqual(DEFAULT_APPEARANCE);
    await expect(saveAppearance(failing, state)).rejects.toThrow("full");
  });
});
