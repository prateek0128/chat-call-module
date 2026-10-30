/**
 * Appearance render smoke tests (react-native stand-in from __tests__/rn-mock): AppearanceProvider
 * driving the theme + persistence, ChatWallpaper kinds, AppearanceSheet sections and setters,
 * and the optional entry points in ChatHeader / ConversationListScreen.
 */
import { act, type ReactElement } from "react";
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CommsProvider } from "../src/core/CommsProvider";
import { ChatProvider } from "../src/chat/ChatProvider";
import { AppearanceProvider, useAppearance, type AppearanceController } from "../src/theme/AppearanceProvider";
import { useTheme } from "../src/theme/ThemeProvider";
import { createMemoryStorage, APPEARANCE_STORAGE_KEY } from "../src/theme/appearanceStorage";
import { colorTokens, themePresets, wallpapers } from "../src/theme/tokens";
import type { Theme } from "../src/theme/createTheme";
import { AppearanceSheet, ChatHeader, ChatWallpaper, ConversationListScreen, MessageList } from "../src/chat-ui";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: ReactTestRenderer[] = [];
const render = (el: ReactElement): ReactTestRenderer => {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  mounted.push(r);
  return r;
};
afterEach(() => {
  act(() => mounted.splice(0).forEach((r) => r.unmount()));
});
const realError = console.error;
const RNMock = require("react-native");
const realReduceMotion = RNMock.AccessibilityInfo.isReduceMotionEnabled;
beforeAll(() => {
  RNMock.AccessibilityInfo.isReduceMotionEnabled = () => ({ then: (cb: (v: boolean) => void) => (cb(false), { catch: () => undefined }) });
  console.error = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
    realError(...args);
  };
});
afterAll(() => {
  RNMock.AccessibilityInfo.isReduceMotionEnabled = realReduceMotion;
  console.error = realError;
});

const flush = () => act(async () => {});
const flat = (style: any): Record<string, any> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? style : {};
const byLabel = (r: ReactTestRenderer, label: string): ReactTestInstance =>
  r.root.find((n) => typeof n.type === "string" && n.props.accessibilityLabel === label);
const hasLabel = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => typeof n.type === "string" && n.props.accessibilityLabel === label).length > 0;
const byTestId = (r: ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props.testID === id);
const press = (r: ReactTestRenderer, label: string) => act(() => byLabel(r, label).props.onPress());

/** Captures the live controller + theme. */
const probe: { a?: AppearanceController; t?: Theme } = {};
const Probe = () => {
  probe.a = useAppearance();
  probe.t = useTheme();
  return null;
};

describe("AppearanceProvider", () => {
  it("drives ThemeProvider live: preset and mode", async () => {
    render(
      <AppearanceProvider storage={null}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(probe.t!.colors.accent).toBe(colorTokens.light.accent);
    act(() => probe.a!.setPreset("rose"));
    expect(probe.t!.colors.accent).toBe(themePresets.light.rose.accent);
    expect(probe.t!.colors.bubbleOut).toBe(themePresets.light.rose.bubbleOut);
    act(() => probe.a!.setMode("dark"));
    expect(probe.t!.scheme).toBe("dark");
    expect(probe.t!.colors.accent).toBe(themePresets.dark.rose.accent);
    expect(probe.t!.colors.surface).toBe(colorTokens.dark.surface);
  });

  it("hydrates from storage, persists changes, falls back on corrupted data", async () => {
    const storage = createMemoryStorage({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ mode: "dark", preset: "ocean", wallpaper: { kind: "solid", index: 3 }, perChat: { p1: { kind: "gradient", index: 1 } } }),
    });
    render(
      <AppearanceProvider storage={storage}>
        <Probe />
      </AppearanceProvider>,
    );
    await flush();
    expect(probe.a!.ready).toBe(true);
    expect(probe.a!.preset).toBe("ocean");
    expect(probe.t!.scheme).toBe("dark");
    expect(probe.a!.wallpaperFor("p1")).toEqual({ kind: "gradient", index: 1 });
    expect(probe.a!.wallpaperFor("p2")).toEqual({ kind: "solid", index: 3 });
    act(() => probe.a!.setWallpaper({ kind: "solid", index: 0 }, { peerId: "p2" }));
    await flush();
    expect(JSON.parse(storage.data[APPEARANCE_STORAGE_KEY]).perChat.p2).toEqual({ kind: "solid", index: 0 });
    act(() => probe.a!.resetWallpaper("p2"));
    await flush();
    expect(JSON.parse(storage.data[APPEARANCE_STORAGE_KEY]).perChat.p2).toBeUndefined();

    const bad = createMemoryStorage({ [APPEARANCE_STORAGE_KEY]: "{oops" });
    render(
      <AppearanceProvider storage={bad}>
        <Probe />
      </AppearanceProvider>,
    );
    await flush();
    expect(probe.a!.preset).toBe("indigo");
    expect(probe.a!.wallpaper).toEqual({ kind: "default" });
  });

  it("reports storage write failures and keeps the choice for the session", async () => {
    const errors: unknown[] = [];
    const full = { getItem: async () => null, setItem: async () => Promise.reject(new Error("full")), removeItem: async () => undefined };
    render(
      <AppearanceProvider storage={full} onStorageError={(e) => errors.push(e)}>
        <Probe />
      </AppearanceProvider>,
    );
    await flush();
    act(() => probe.a!.setWallpaper({ kind: "image", uri: "file:///big.jpg" }));
    await flush();
    expect(errors).toHaveLength(1);
    expect(probe.a!.wallpaper).toEqual({ kind: "image", uri: "file:///big.jpg" });
  });

  it("controlled mode reports changes through onChange", () => {
    const seen: string[] = [];
    render(
      <AppearanceProvider value={{ mode: "light", preset: "amber", textSize: "medium", density: "comfortable", wallpaper: { kind: "default" }, perChat: {} }} onChange={(n) => seen.push(n.preset)}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(probe.t!.colors.accent).toBe(themePresets.light.amber.accent);
    act(() => probe.a!.setPreset("violet"));
    expect(seen).toEqual(["violet"]);
    expect(probe.a!.preset).toBe("amber"); // host did not apply it
  });

  it("useAppearance without a provider: defaults and no-op setters", () => {
    render(<Probe />);
    expect(probe.a!.available).toBe(false);
    act(() => probe.a!.setPreset("rose"));
    expect(probe.a!.preset).toBe("indigo");
  });
});

describe("ChatWallpaper", () => {
  const wrap = (el: ReactElement, mode: "light" | "dark" = "light") =>
    render(<AppearanceProvider storage={null} initial={{ mode }}>{el}</AppearanceProvider>);
  const rootBg = (r: ReactTestRenderer) => flat(byTestId(r, "wp")[0].props.style).backgroundColor;

  it("default: wallpaper colour + dot pattern", () => {
    const r = wrap(<ChatWallpaper testID="wp" />);
    expect(rootBg(r)).toBe(colorTokens.light.wallpaper);
    expect(byTestId(r, "wallpaper-pattern")).toHaveLength(1);
  });

  it("solid follows the scheme by index", () => {
    expect(rootBg(wrap(<ChatWallpaper testID="wp" wallpaper={{ kind: "solid", index: 4 }} />, "dark"))).toBe(wallpapers.dark.solids[4]);
  });

  it("gradient: renderGradient, else first-stop fallback (expo-linear-gradient not installed)", () => {
    const calls: any[] = [];
    wrap(<ChatWallpaper testID="wp" wallpaper={{ kind: "gradient", index: 2 }} renderGradient={(p) => (calls.push(p), null)} />);
    expect(calls[0].colors).toEqual(wallpapers.light.gradients[2]);
    const r = wrap(<ChatWallpaper testID="wp" wallpaper={{ kind: "gradient", index: 2 }} />);
    expect(rootBg(r)).toBe(wallpapers.light.gradients[2][0]);
  });

  it("image: cover image + dim overlay; falls back to the base colour on error", () => {
    const r = wrap(<ChatWallpaper testID="wp" wallpaper={{ kind: "image", uri: "file:///w.jpg", dim: 0.5 }} />, "dark");
    const img = byTestId(r, "wallpaper-image")[0];
    expect(img.props.resizeMode).toBe("cover");
    expect(img.props.source).toEqual({ uri: "file:///w.jpg" });
    expect(flat(byTestId(r, "wallpaper-dim")[0].props.style)).toMatchObject({ backgroundColor: "#000000", opacity: 0.5 });
    act(() => img.props.onError());
    expect(byTestId(r, "wallpaper-image")).toHaveLength(0);
    expect(rootBg(r)).toBe(colorTokens.dark.wallpaper);
  });

  it("MessageList uses the chat's override", () => {
    const r = render(
      <AppearanceProvider storage={null} initial={{ perChat: { p1: { kind: "solid", index: 1 } } }}>
        <MessageList messages={[]} peerId="p1" />
      </AppearanceProvider>,
    );
    const bgs = r.root.findAll((n) => typeof n.type === "string" && flat(n.props.style).backgroundColor === wallpapers.light.solids[1]);
    expect(bgs.length).toBeGreaterThan(0);
  });
});

describe("AppearanceSheet", () => {
  it("global mode: sections render and call the setters", async () => {
    const picks: any[] = [];
    const r = render(
      <AppearanceProvider storage={null}>
        <Probe />
        <AppearanceSheet visible onClose={() => {}} pickImage={async (o) => (picks.push(o), { uri: "file:///picked.jpg" })} />
      </AppearanceProvider>,
    );
    expect(byTestId(r, "appearance-preview")).toHaveLength(1);
    for (const label of ["Mode", "Text size", "Density", "Large", "Compact", "Theme", "Wallpaper", "Auto", "Light", "Dark", "Rose theme", "Graphite theme", "Default wallpaper", "Colour 1", "Gradient 5", "Choose image…"])
      expect(hasLabel(r, label)).toBe(true);
    expect(hasLabel(r, "This chat")).toBe(false);
    expect(byLabel(r, "Indigo theme").props.accessibilityRole).toBe("radio");
    expect(byLabel(r, "Indigo theme").props.accessibilityState).toEqual({ checked: true });

    press(r, "Rose theme");
    expect(probe.a!.preset).toBe("rose");
    expect(byLabel(r, "Rose theme").props.accessibilityState).toEqual({ checked: true });
    press(r, "Dark");
    expect(probe.a!.mode).toBe("dark");
    press(r, "Colour 2");
    expect(probe.a!.wallpaper).toEqual({ kind: "solid", index: 1 });
    expect(hasLabel(r, "Dim")).toBe(false);

    await act(async () => byLabel(r, "Choose image…").props.onPress());
    expect(picks).toEqual([{ maxEdge: 1600 }]);
    expect(probe.a!.wallpaper).toEqual({ kind: "image", uri: "file:///picked.jpg" });
    expect(hasLabel(r, "Current photo")).toBe(true);
    const slider = byTestId(r, "dim-slider")[0];
    expect(slider.props.accessibilityRole).toBe("adjustable");
    expect(slider.props.accessibilityValue).toMatchObject({ min: 0, max: 80, now: 35 }); // dark default
    act(() => slider.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
    expect(probe.a!.wallpaper).toEqual({ kind: "image", uri: "file:///picked.jpg", dim: 0.45 });
    press(r, "Less dim");
    expect((probe.a!.wallpaper as any).dim).toBe(0.35);
  });

  it("per-chat mode: This chat by default, All chats, Reset", () => {
    const r = render(
      <AppearanceProvider storage={null}>
        <Probe />
        <AppearanceSheet visible onClose={() => {}} peerId="p1" />
      </AppearanceProvider>,
    );
    expect(byLabel(r, "This chat").props.accessibilityState).toEqual({ checked: true });
    expect(hasLabel(r, "Choose image…")).toBe(false);
    press(r, "Gradient 1");
    expect(probe.a!.wallpaperFor("p1")).toEqual({ kind: "gradient", index: 0 });
    expect(probe.a!.wallpaper).toEqual({ kind: "default" });
    press(r, "Reset this chat");
    expect(probe.a!.hasOverride("p1")).toBe(false);
    press(r, "Colour 3");
    press(r, "All chats");
    press(r, "Colour 4");
    expect(probe.a!.wallpaper).toEqual({ kind: "solid", index: 3 });
    expect(probe.a!.hasOverride("p1")).toBe(false);
  });

  it("hidden when not visible; Done closes", () => {
    let closed = 0;
    const hidden = render(<AppearanceSheet visible={false} onClose={() => {}} />);
    expect(hidden.toJSON()).toBeNull();
    const r = render(<AppearanceSheet visible onClose={() => closed++} />);
    press(r, "Done");
    expect(closed).toBe(1);
  });
});

describe("entry points", () => {
  it("ChatHeader: overflow menu shows Wallpaper only when asked", () => {
    const plain = render(<ChatHeader peerId="p1" name="Asha" />);
    expect(hasLabel(plain, "More options")).toBe(false);
    let opened = 0;
    const r = render(<ChatHeader peerId="p1" name="Asha" onOpenAppearance={() => opened++} />);
    press(r, "More options");
    press(r, "Wallpaper");
    expect(opened).toBe(1);
    expect(hasLabel(r, "Wallpaper")).toBe(false);
  });

  it("ConversationListScreen: optional Appearance action opens the sheet", () => {
    const config = { baseUrl: "https://api.example.com", getToken: () => null, getUserId: () => "me" };
    const tree = (extra: object) => (
      <AppearanceProvider storage={null}>
        <CommsProvider config={config} autoConnect={false}>
          <ChatProvider>
            <ConversationListScreen onOpenConversation={() => {}} {...extra} />
          </ChatProvider>
        </CommsProvider>
      </AppearanceProvider>
    );
    expect(hasLabel(render(tree({})), "Appearance")).toBe(false);
    const r = render(tree({ showAppearanceAction: true }));
    expect(hasLabel(r, "Rose theme")).toBe(false);
    press(r, "Appearance");
    expect(hasLabel(r, "Rose theme")).toBe(true);
    let custom = 0;
    const r2 = render(tree({ showAppearanceAction: true, onOpenAppearance: () => custom++ }));
    press(r2, "Appearance");
    expect(custom).toBe(1);
  });
});
