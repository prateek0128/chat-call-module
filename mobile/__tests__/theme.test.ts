/** Theme layer: tokens mirror design/tokens.json; createTheme, colours, layout, avatar helpers. */
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

import { tokens } from "../src/theme/tokens";
import { createTheme, darkTheme, lightTheme, resolveScheme, shadowStyle } from "../src/theme/createTheme";
import { gradientStops, mixColor, parseColor, withAlpha } from "../src/theme/color";
import { decideLayout } from "../src/theme/layout";
import { avatarColor, initialsOf } from "../src/theme/avatarColors";
import { slopFor } from "../src/theme/touch";

const designTokens = (() => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "design", "tokens.json"), "utf8"));
  // Drop every `$comment` (top level and inside groups such as themePresets / wallpapers).
  const strip = (o: any): any => {
    if (o && typeof o === "object" && !Array.isArray(o)) for (const k of Object.keys(o)) k === "$comment" ? delete o[k] : strip(o[k]);
    return o;
  };
  return strip(raw);
})();

describe("tokens.ts mirrors design/tokens.json", () => {
  it("deep-equals every token group", () => {
    // Round-trip through JSON so `as const` / typed records compare as plain data.
    expect(JSON.parse(JSON.stringify(tokens))).toEqual(designTokens);
  });

  it.each(["light", "dark"])("has exactly the %s colour set", (scheme) => {
    expect(tokens.color[scheme as "light" | "dark"]).toEqual(designTokens.color[scheme]);
    expect(Object.keys(tokens.color[scheme as "light" | "dark"]).sort()).toEqual(Object.keys(designTokens.color[scheme]).sort());
  });

  it.each(["radius", "space", "motion", "layout", "shadow", "avatarPalette", "themePresets", "wallpapers"])("%s matches", (group) => {
    expect((tokens as any)[group]).toEqual(designTokens[group]);
  });

  it("font sizes, weights and line height match", () => {
    expect(tokens.font.size).toEqual(designTokens.font.size);
    expect(tokens.font.weight).toEqual(designTokens.font.weight);
    expect(tokens.font.lineHeight).toBe(designTokens.font.lineHeight);
    expect(tokens.font.family).toBe(designTokens.font.family);
  });
});

describe("createTheme", () => {
  it("builds light and dark from the tokens", () => {
    expect(lightTheme.scheme).toBe("light");
    expect(lightTheme.colors).toEqual(designTokens.color.light);
    expect(darkTheme.colors).toEqual(designTokens.color.dark);
    expect(lightTheme.layout.tapTarget).toBe(44);
  });

  it("applies overrides: shared colours, per-scheme colours, nested groups", () => {
    const t = createTheme({ colors: { accent: "#FF0000" }, schemes: { dark: { accent: "#00FF00" } }, radius: { bubble: 12 }, layout: { composerMaxLines: 4 } }, "light");
    expect(t.colors.accent).toBe("#FF0000");
    expect(t.colors.surface).toBe(designTokens.color.light.surface);
    expect(t.radius.bubble).toBe(12);
    expect(t.radius.sm).toBe(6);
    expect(t.layout.composerMaxLines).toBe(4);
    const d = createTheme({ colors: { accent: "#FF0000" }, schemes: { dark: { accent: "#00FF00" } } }, "dark");
    expect(d.colors.accent).toBe("#00FF00");
  });

  it("never mutates the shared tokens", () => {
    createTheme({ radius: { sm: 99 }, colors: { text: "#123456" }, avatarPalette: ["#000000"] });
    expect(tokens.radius.sm).toBe(6);
    expect(tokens.color.light.text).toBe("#0F172A");
    expect(tokens.avatarPalette.length).toBe(8);
  });

  it("resolves the colour scheme preference", () => {
    expect(resolveScheme("system", "dark")).toBe("dark");
    expect(resolveScheme("system", null)).toBe("light");
    expect(resolveScheme(undefined, "dark")).toBe("dark");
    expect(resolveScheme("light", "dark")).toBe("light");
    expect(resolveScheme("dark", "light")).toBe("dark");
  });

  it("maps shadow tokens to native shadow styles", () => {
    expect(shadowStyle(lightTheme, "md")).toEqual({
      shadowColor: "rgb(15, 23, 42)",
      shadowOpacity: 0.1,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    });
  });
});

describe("colour helpers", () => {
  it("parses hex and rgba", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#4F46E5")).toEqual({ r: 79, g: 70, b: 229, a: 1 });
    expect(parseColor("rgba(15, 23, 42, 0.55)")).toEqual({ r: 15, g: 23, b: 42, a: 0.55 });
    expect(parseColor("nope")).toBeNull();
  });

  it("mixes and builds gradient stops", () => {
    expect(mixColor("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(mixColor("#000000", "#FFFFFF", 0)).toBe("#000000");
    const stops = gradientStops(tokens.color.light.callBackgroundStart, tokens.color.light.callBackgroundEnd, 4);
    expect(stops).toHaveLength(4);
    expect(stops[0]).toBe("#0F172A");
    expect(stops[3]).toBe("#1E1B4B");
    expect(withAlpha("#4F46E5", 0.14)).toBe("rgba(79, 70, 229, 0.14)");
  });
});

describe("responsive layout decision", () => {
  it("single pane below the tablet breakpoint", () => {
    expect(decideLayout(390)).toMatchObject({ mode: "single", listWidth: 390, bubbleMaxWidth: Math.round(390 * 0.85) });
    expect(decideLayout(699).mode).toBe("single");
    expect(decideLayout(320).mode).toBe("single");
  });

  it("split with the minimum list width on tablets", () => {
    expect(decideLayout(700)).toMatchObject({ mode: "split", listWidth: 300, chatWidth: 400 });
    expect(decideLayout(1023)).toMatchObject({ mode: "split", listWidth: 300 });
  });

  it("split with clamp(300, 30%, 400) and max 1440 on desktop widths", () => {
    expect(decideLayout(1024).listWidth).toBe(307);
    expect(decideLayout(1200).listWidth).toBe(360);
    expect(decideLayout(1600)).toMatchObject({ listWidth: 400, contentWidth: 1440, chatWidth: 1040 });
  });

  it("uses theme breakpoints when overridden", () => {
    const custom = { ...tokens.layout, breakpointTablet: 800 };
    expect(decideLayout(750, custom).mode).toBe("single");
  });
});

describe("avatar helpers", () => {
  it("initials", () => {
    expect(initialsOf("Asha Rao")).toBe("AR");
    expect(initialsOf("bob")).toBe("B");
    expect(initialsOf("  mary   jane  watson ")).toBe("MW");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf("😀 Zed")).toBe("Z");
    expect(initialsOf("Émile Zola")).toBe("ÉZ");
  });

  it("palette colour is stable per key", () => {
    const a = avatarColor("user-42", tokens.avatarPalette);
    expect(tokens.avatarPalette).toContain(a);
    expect(avatarColor("user-42", tokens.avatarPalette)).toBe(a);
    expect(avatarColor("", [])).toBe("");
  });

  it("hitSlop grows small targets to 44pt", () => {
    expect(slopFor(32, 44)).toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
    expect(slopFor(44, 44)).toBeUndefined();
    expect(slopFor(undefined, 44)).toBeUndefined();
  });
});
