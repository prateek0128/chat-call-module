import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider, AppearanceSheet, ChatWallpaper, APPEARANCE_STORAGE_KEY, themeCssVars, useAppearance, useTheme, type AppearanceController, type SyncStorage } from "../src";
import { createTheme } from "commskit/engine";

let ctl: AppearanceController;
const Probe = () => {
  ctl = useAppearance();
  const theme = useTheme();
  return <span data-testid="accent">{theme.colors.accent}</span>;
};

const memory = (initial: Record<string, string> = {}): SyncStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v), removeItem: (k) => void delete data[k] };
};

const root = () => document.querySelector(".ck-root") as HTMLElement;

describe("AppearanceProvider", () => {
  it("defaults: system mode, indigo preset, default wallpaper; tokens become CSS variables", () => {
    render(
      <AppearanceProvider storage={null}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(ctl.mode).toBe("system");
    expect(ctl.preset).toBe("indigo");
    expect(ctl.wallpaper).toEqual({ kind: "default" });
    expect(root().getAttribute("data-ck-scheme")).toBe("light");
    expect(root().style.getPropertyValue("--ck-accent")).toBe("#4F46E5");
    expect(root().style.getPropertyValue("--ck-radius-bubble")).toBe("18px");
  });

  it("mode and preset re-theme live (dark rose) and persist to storage", () => {
    const storage = memory();
    render(
      <AppearanceProvider storage={storage}>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => ctl.setMode("dark"));
    act(() => ctl.setPreset("rose"));
    expect(root().getAttribute("data-ck-scheme")).toBe("dark");
    expect(root().getAttribute("data-ck-preset")).toBe("rose");
    expect(screen.getByTestId("accent").textContent).toBe("#FB7185");
    expect(JSON.parse(storage.data[APPEARANCE_STORAGE_KEY])).toMatchObject({ mode: "dark", preset: "rose" });
  });

  it("saved preferences are restored on the next mount (persistence round trip)", () => {
    const storage = memory();
    const first = render(
      <AppearanceProvider storage={storage}>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => ctl.setPreset("emerald"));
    act(() => ctl.setWallpaper({ kind: "gradient", index: 2 }));
    act(() => ctl.setWallpaper({ kind: "solid", index: 3 }, { peerId: "U2" }));
    first.unmount();
    render(
      <AppearanceProvider storage={storage}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(ctl.preset).toBe("emerald");
    expect(ctl.wallpaper).toEqual({ kind: "gradient", index: 2 });
    expect(ctl.wallpaperFor("U2")).toEqual({ kind: "solid", index: 3 });
    expect(ctl.wallpaperFor("U9")).toEqual({ kind: "gradient", index: 2 });
    act(() => ctl.resetWallpaper("U2"));
    expect(ctl.wallpaperFor("U2")).toEqual({ kind: "gradient", index: 2 });
  });

  it("works with real localStorage by default", () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => ctl.setPreset("ocean"));
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) as string).preset).toBe("ocean");
  });

  it("quota failure: the choice still applies for the session, onStorageError fires and storageFailed is set", () => {
    const onStorageError = vi.fn();
    const full: SyncStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    render(
      <AppearanceProvider storage={full} onStorageError={onStorageError}>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => ctl.setWallpaper({ kind: "image", uri: "data:image/jpeg;base64,AAAA" }));
    expect(ctl.wallpaper).toEqual({ kind: "image", uri: "data:image/jpeg;base64,AAAA" });
    expect(ctl.storageFailed).toBe(true);
    expect(onStorageError).toHaveBeenCalledTimes(1);
  });

  it("a throwing getItem or corrupted JSON falls back to defaults without crashing", () => {
    const broken: SyncStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    render(
      <AppearanceProvider storage={broken}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(ctl.preset).toBe("indigo");
    render(
      <AppearanceProvider storage={memory({ [APPEARANCE_STORAGE_KEY]: "{not json" })}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(ctl.mode).toBe("system");
  });

  it("controlled mode: the host owns the state and no storage is used", () => {
    const onChange = vi.fn();
    const storage = memory();
    render(
      <AppearanceProvider storage={storage} value={{ mode: "dark", preset: "amber", wallpaper: { kind: "default" }, perChat: {} }} onChange={onChange}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(root().getAttribute("data-ck-preset")).toBe("amber");
    act(() => ctl.setPreset("violet"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ preset: "violet" }));
    expect(storage.data).toEqual({});
  });

  it("system mode follows prefers-color-scheme", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("dark"), media: q, addEventListener() {}, removeEventListener() {} })) as any;
    render(
      <AppearanceProvider storage={null}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(root().getAttribute("data-ck-scheme")).toBe("dark");
    window.matchMedia = original;
  });
});

describe("design tokens", () => {
  const tokens = JSON.parse(readFileSync(path.resolve(__dirname, "../../design/tokens.json"), "utf8"));

  it("CSS variables carry exactly the values of design/tokens.json for light and dark", () => {
    for (const scheme of ["light", "dark"] as const) {
      const vars = themeCssVars(createTheme({}, scheme));
      for (const [name, value] of Object.entries(tokens.color[scheme])) {
        const key = `--ck-${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
        expect(vars[key], `${scheme} ${name}`).toBe(value);
      }
    }
    const vars = themeCssVars(createTheme({}, "light"));
    for (const [k, v] of Object.entries(tokens.radius)) expect(vars[`--ck-radius-${k}`]).toBe(`${v}px`);
    for (const [k, v] of Object.entries(tokens.space)) expect(vars[`--ck-space-${k}`]).toBe(`${v}px`);
    expect(vars["--ck-tap"]).toBe(`${tokens.layout.tapTarget}px`);
  });

  it("all 7 presets apply exactly their accent family in both schemes", () => {
    expect(tokens.themePresets.order).toHaveLength(7);
    for (const scheme of ["light", "dark"] as const) {
      for (const name of tokens.themePresets.order) {
        const vars = themeCssVars(createTheme({ preset: name }, scheme));
        for (const [k, v] of Object.entries(tokens.themePresets[scheme][name])) {
          const key = `--ck-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
          expect(vars[key], `${scheme}/${name}/${k}`).toBe(v);
        }
      }
    }
  });

  it("styles.css has no hard-coded token colours (only CSS variables)", () => {
    const css = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
    for (const hex of ["#4F46E5", "#4338CA", "#EEF2FF", "#0F172A", "#E5E7EB"]) expect(css.toUpperCase()).not.toContain(hex);
  });
});

describe("wallpapers and AppearanceSheet", () => {
  it("ChatWallpaper renders default dots, solid, gradient and image with a dim overlay", () => {
    const view = (w: any) =>
      render(
        <AppearanceProvider storage={null}>
          <ChatWallpaper wallpaper={w} />
        </AppearanceProvider>,
      );
    let r = view({ kind: "default" });
    expect(r.container.querySelector(".ck-wallpaper")?.getAttribute("data-kind")).toBe("dots");
    r.unmount();
    r = view({ kind: "solid", index: 1 });
    expect((r.container.querySelector(".ck-wallpaper") as HTMLElement).style.backgroundColor).toBe("rgb(232, 241, 236)"); // #E8F1EC
    r.unmount();
    r = view({ kind: "gradient", index: 0 });
    expect((r.container.querySelector(".ck-wallpaper") as HTMLElement).style.backgroundImage).toContain("linear-gradient(135deg");
    r.unmount();
    r = view({ kind: "image", uri: "data:image/png;base64,AAAA", dim: 0.5 });
    expect((r.container.querySelector(".ck-wallpaper-dim") as HTMLElement).style.opacity).toBe("0.5");
  });

  it("sheet: 7 named theme swatches, mode radios, 8 solids + 5 gradients, live preview and per-chat scope", () => {
    const onClose = vi.fn();
    render(
      <AppearanceProvider storage={memory()}>
        <Probe />
        <AppearanceSheet peerId="U2" peerName="Bob" onClose={onClose} />
      </AppearanceProvider>,
    );
    const dlg = screen.getByRole("dialog", { name: "Appearance" });
    for (const n of ["Indigo", "Rose", "Emerald", "Ocean", "Amber", "Violet", "Graphite"]) expect(within(dlg).getByRole("button", { name: `${n} theme` })).toBeTruthy();
    expect(within(dlg).getAllByRole("button", { name: /^Solid \d wallpaper$/ })).toHaveLength(8);
    expect(within(dlg).getAllByRole("button", { name: /^Gradient \d wallpaper$/ })).toHaveLength(5);
    expect(within(dlg).getByLabelText("Preview")).toBeTruthy();
    // per-chat by default
    fireEvent.click(within(dlg).getByRole("button", { name: "Solid 3 wallpaper" }));
    expect(ctl.wallpaperFor("U2")).toEqual({ kind: "solid", index: 2 });
    expect(ctl.wallpaper).toEqual({ kind: "default" });
    fireEvent.click(within(dlg).getByRole("radio", { name: "All chats" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Gradient 1 wallpaper" }));
    expect(ctl.wallpaper).toEqual({ kind: "gradient", index: 0 });
    fireEvent.click(within(dlg).getByRole("radio", { name: "This chat" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Reset this chat" }));
    expect(ctl.hasOverride("U2")).toBe(false);
    fireEvent.click(within(dlg).getByRole("button", { name: "Rose theme" }));
    expect(screen.getByTestId("accent").textContent).toBe("#E11D48");
    fireEvent.click(within(dlg).getByRole("radio", { name: "Dark" }));
    expect(ctl.mode).toBe("dark");
    fireEvent.click(within(dlg).getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("sheet warns when storage is full", () => {
    const full: SyncStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    render(
      <AppearanceProvider storage={full}>
        <AppearanceSheet onClose={() => {}} />
      </AppearanceProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rose theme" }));
    expect(screen.getByText(/Storage is full/)).toBeTruthy();
  });

  it("a non-image file is rejected with a notice", async () => {
    const onNotice = vi.fn();
    render(
      <AppearanceProvider storage={memory()}>
        <AppearanceSheet onClose={() => {}} onNotice={onNotice} />
      </AppearanceProvider>,
    );
    const input = screen.getByTestId("wallpaper-file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.txt", { type: "text/plain" })] } });
    await screen.findByText("Choose an image file.");
    expect(onNotice).toHaveBeenCalledWith("Choose an image file.");
  });
});
