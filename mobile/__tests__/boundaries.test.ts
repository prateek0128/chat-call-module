/**
 * Import-boundary rules (dependency-cruiser-free scanner):
 * 1. chat and call import only core; neither imports the other; core imports neither.
 * 2. Only src/call may import @stream-io/react-native-webrtc / react-native-incall-manager.
 * 3. Only src/chat/media.ts may import expo-file-system.
 * 4. Pure modules (everything except *.tsx and hooks.ts) import neither react nor
 *    react-native, and only import other pure modules — so they run under plain ts-jest.
 * 5. No app coupling leaks into the kit.
 * 6. package.json "exports" point at existing files.
 * 7. UI layers: theme imports only react / react-native (no core/chat/call/*-ui);
 *    chat-ui imports theme/core/chat (never call / call-ui); call-ui imports theme/core/call
 *    (never chat / chat-ui); engine folders (core/chat/call) import no UI layer.
 * 8. react-native-safe-area-context is optional: only lazily required in src/theme/safeArea.tsx.
 * 9. Appearance optional peers: @react-native-async-storage/async-storage only lazily required in
 *    src/theme/appearanceStorage.ts (and src/call-native/session.ts); expo-linear-gradient only in
 *    src/chat-ui/ChatWallpaper.tsx.
 * 11. Rich chat optional peers (gesture handler, haptics, clipboard, video, audio, sharing, media
 *    library, and chat-ui's use of expo-file-system) are lazily required only from
 *    src/chat-ui/optionalPeers.ts; chat-ui still never imports call / call-ui.
 * 10. Add-on entries: notifications and moderation import only core; call-native imports core + call
 *    (never chat). chat-ui and call-ui may import moderation. Their native libs are optional peers,
 *    each lazily required from one home file per entry point.
 */
// Node built-ins via require (keeps @types/node out of the package typecheck).
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e: any): string[] => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "types" && dir === SRC ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const importsOf = (file: string): string[] => {
  const code = stripComments(fs.readFileSync(file, "utf8"));
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+[^'"]*?from\s*["']([^"']+)["']/g,
    /\bexport\s+[^'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) specs.add(m[1] as string);
  return Array.from(specs);
};

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const layerOf = (file: string) => rel(file).split("/")[0]; // core | chat | call | theme | chat-ui | call-ui | index.ts

const resolveLocal = (from: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error(`${rel(from)}: cannot resolve ${spec}`);
};

const files = walk(SRC);

/** Optional peers and the one file allowed to (lazily) require each. */
const OPTIONAL_PEER_HOME: Record<string, string[]> = {
  "react-native-safe-area-context": ["theme/safeArea.tsx"],
  "@react-native-async-storage/async-storage": ["theme/appearanceStorage.ts", "call-native/session.ts"],
  "expo-linear-gradient": ["chat-ui/ChatWallpaper.tsx"],
  // one home per entry point: commskit/notifications and commskit/call-native are independent
  "expo-notifications": ["notifications/expo.ts", "call-native/background.ts"],
  "expo-device": ["notifications/expo.ts"],
  "expo-task-manager": ["call-native/background.ts"],
  "react-native-callkeep": ["call-native/callkit.ts"],
  "react-native-voip-push-notification": ["call-native/voip.ts"],
  "@notifee/react-native": ["call-native/android.ts"],
  // rich chat features: one home for every chat-ui optional peer
  "react-native-gesture-handler": ["chat-ui/optionalPeers.ts"],
  "expo-haptics": ["chat-ui/optionalPeers.ts"],
  "expo-clipboard": ["chat-ui/optionalPeers.ts"],
  "expo-video": ["chat-ui/optionalPeers.ts"],
  "expo-audio": ["chat-ui/optionalPeers.ts"],
  "expo-av": ["chat-ui/optionalPeers.ts"],
  "expo-sharing": ["chat-ui/optionalPeers.ts"],
  "expo-media-library": ["chat-ui/optionalPeers.ts"],
  // attach menu pickers + in-app document viewer
  "expo-image-picker": ["chat-ui/optionalPeers.ts"],
  "expo-document-picker": ["chat-ui/optionalPeers.ts"],
  "react-native-webview": ["chat-ui/optionalPeers.ts"],
};
/** expo-file-system: chat (base64 reader) and chat-ui (downloads) each have one home file. */
const FILE_SYSTEM_HOMES = ["chat/media.ts", "chat-ui/optionalPeers.ts"];
const OPTIONAL_PEERS = Object.keys(OPTIONAL_PEER_HOME);
const isOptionalPeerHome = (file: string, spec: string) =>
  (OPTIONAL_PEER_HOME[spec] || []).includes(file) || (/^expo-file-system(\/legacy)?$/.test(spec) && FILE_SYSTEM_HOMES.includes(file));
const isPure = (file: string) => !file.endsWith(".tsx") && path.basename(file) !== "hooks.ts" && !/\/index\.ts$/.test(rel(file)) && rel(file) !== "index.ts";

describe("import boundaries", () => {
  it("found the source files", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("chat never imports call, call never imports chat, core imports neither", () => {
    const violations: string[] = [];
    for (const f of files) {
      const layer = layerOf(f);
      for (const spec of importsOf(f)) {
        const target = resolveLocal(f, spec);
        const targetLayer = target ? layerOf(target) : spec.startsWith("commskit/") ? spec.split("/")[1] : null;
        if (!targetLayer) continue;
        const allowed: Record<string, string[]> = {
          core: ["core"],
          chat: ["core", "chat"],
          call: ["core", "call"],
          theme: ["theme"],
          "chat-ui": ["theme", "core", "chat", "chat-ui", "moderation"],
          "call-ui": ["theme", "core", "call", "call-ui", "moderation"],
          notifications: ["core", "notifications"],
          moderation: ["core", "moderation"],
          "call-native": ["core", "call", "call-native"],
          "index.ts": ["core"],
          engine: ["core", "chat", "moderation", "chat-ui", "theme"],
        };
        if (!(allowed[layer] || []).includes(targetLayer)) violations.push(`${rel(f)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  const layerImports = (layer: string): Array<{ file: string; spec: string; target: string | null }> =>
    files
      .filter((f) => layerOf(f) === layer)
      .flatMap((f) =>
        importsOf(f).map((spec) => {
          const target = resolveLocal(f, spec);
          const targetLayer = target ? layerOf(target) : spec.startsWith("commskit/") ? spec.split("/")[1] : null;
          return { file: rel(f), spec, target: targetLayer };
        }),
      );

  it("found the UI layers", () => {
    for (const layer of ["theme", "chat-ui", "call-ui"]) expect(files.some((f) => layerOf(f) === layer)).toBe(true);
  });

  it("theme imports only react / react-native (no core, chat, call or any *-ui)", () => {
    const bad = layerImports("theme").filter(
      (i) => (i.target && i.target !== "theme") || (!i.spec.startsWith(".") && !["react", "react-native"].includes(i.spec) && !isOptionalPeerHome(i.file, i.spec)),
    );
    expect(bad).toEqual([]);
  });

  it("theme never imports chat-ui (chat-ui may import theme)", () => {
    expect(layerImports("theme").filter((i) => i.target === "chat-ui" || /^commskit\/chat-ui$/.test(i.spec))).toEqual([]);
    expect(layerImports("chat-ui").some((i) => i.target === "theme")).toBe(true);
  });

  it("chat-ui never imports call or call-ui", () => {
    const bad = layerImports("chat-ui").filter((i) => i.target === "call" || i.target === "call-ui" || /^commskit\/(call|call-ui)$/.test(i.spec));
    expect(bad).toEqual([]);
  });

  it("call-ui never imports chat or chat-ui", () => {
    const bad = layerImports("call-ui").filter((i) => i.target === "chat" || i.target === "chat-ui" || /^commskit\/(chat|chat-ui)$/.test(i.spec));
    expect(bad).toEqual([]);
  });

  it("engine folders (core, chat, call) import no UI layer", () => {
    const bad = ["core", "chat", "call", "notifications", "moderation", "call-native"].flatMap((layer) => layerImports(layer).filter((i) => i.target === "theme" || i.target === "chat-ui" || i.target === "call-ui"));
    expect(bad).toEqual([]);
  });

  it("UI layers import only react, react-native and the optional peers (each from its one home file) from outside the kit", () => {
    const allowedExternal = ["react", "react-native"];
    const bad = ["theme", "chat-ui", "call-ui"].flatMap((layer) =>
      layerImports(layer).filter((i) => !i.spec.startsWith(".") && !allowedExternal.includes(i.spec) && !isOptionalPeerHome(i.file, i.spec)),
    );
    expect(bad).toEqual([]);
  });

  it("add-on entries: notifications / moderation import only core; call-native only core + call (never chat)", () => {
    const targets = (layer: string) => layerImports(layer).filter((i) => i.target && i.target !== layer);
    expect(targets("notifications").filter((i) => i.target !== "core")).toEqual([]);
    expect(targets("moderation").filter((i) => i.target !== "core")).toEqual([]);
    expect(targets("call-native").filter((i) => i.target !== "core" && i.target !== "call")).toEqual([]);
    expect(layerImports("call-native").filter((i) => /chat/.test(String(i.target)) || /^commskit\/chat/.test(i.spec))).toEqual([]);
    // External imports: react (hooks), react-native (call-native hooks only) and each optional peer from its home.
    const bad = ["notifications", "moderation", "call-native"].flatMap((layer) =>
      layerImports(layer).filter(
        (i) =>
          !i.spec.startsWith(".") &&
          i.spec !== "react" &&
          !(i.spec === "react-native" && i.file === "call-native/hooks.ts") &&
          !isOptionalPeerHome(i.file, i.spec),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("react-native-safe-area-context only lazily required in src/theme/safeArea.tsx", () => {
    const violations: string[] = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      if (/\b(import|export)\b[^;]*from\s*["']react-native-safe-area-context/.test(code)) violations.push(`${rel(f)} (static import)`);
      if (/react-native-safe-area-context/.test(code) && rel(f) !== "theme/safeArea.tsx") violations.push(rel(f));
    }
    expect(violations).toEqual([]);
  });

  it("native call libs only in src/call; expo-file-system only in src/chat/media.ts and src/chat-ui/optionalPeers.ts", () => {
    const violations: string[] = [];
    for (const f of files) {
      for (const spec of importsOf(f)) {
        if (/^(@stream-io\/react-native-webrtc|react-native-incall-manager)/.test(spec) && layerOf(f) !== "call") violations.push(`${rel(f)} -> ${spec}`);
        if (/^expo-file-system/.test(spec) && !FILE_SYSTEM_HOMES.includes(rel(f))) violations.push(`${rel(f)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("optional native deps are only lazily required (never static imports)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      if (/\b(import|export)\b[^;]*from\s*["'](@stream-io\/react-native-webrtc|react-native-incall-manager|expo-file-system|@react-native-async-storage\/async-storage|expo-linear-gradient)/.test(code)) {
        violations.push(rel(f));
      }
      for (const peer of OPTIONAL_PEERS) {
        const esc = peer.replace(/[/\-]/g, "\\$&");
        if (new RegExp(`\\b(import|export)\\b[^;]*from\\s*["']${esc}["']`).test(code)) violations.push(`${rel(f)} (static ${peer})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("rich chat optional peers are each lazily required from exactly one file (chat-ui/optionalPeers.ts)", () => {
    const peers = ["react-native-gesture-handler", "expo-haptics", "expo-clipboard", "expo-video", "expo-audio", "expo-av", "expo-sharing", "expo-media-library", "expo-image-picker", "expo-document-picker", "react-native-webview"];
    for (const peer of peers) {
      const users = files.filter((f) => importsOf(f).includes(peer)).map(rel);
      expect({ peer, users }).toEqual({ peer, users: ["chat-ui/optionalPeers.ts"] });
    }
    const home = stripComments(fs.readFileSync(path.join(SRC, "chat-ui/optionalPeers.ts"), "utf8"));
    expect(/\bimport\b[^;]*from\s*["'](?!\.)/.test(home)).toBe(false); // no static external import
    const chatUiFs = files.filter((f) => layerOf(f) === "chat-ui" && importsOf(f).some((s) => /^expo-file-system/.test(s))).map(rel);
    expect(chatUiFs).toEqual(["chat-ui/optionalPeers.ts"]);
  });

  it("every optional-peer require() sits lexically inside a try { } block (Metro allowOptionalDependencies)", () => {
    const optional = [...OPTIONAL_PEERS, "expo-file-system", "expo-file-system/legacy", "@stream-io/react-native-webrtc", "react-native-incall-manager"];
    const violations: string[] = [];
    let checked = 0;
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] as string;
        if (!optional.includes(spec)) continue;
        checked++;
        // Innermost unclosed "{" before the require must be the body of a `try`.
        let depth = 0;
        let open = -1;
        for (let i = (m.index as number) - 1; i >= 0; i--) {
          const ch = code[i];
          if (ch === "}") depth++;
          else if (ch === "{") {
            if (depth === 0) {
              open = i;
              break;
            }
            depth--;
          }
        }
        if (open < 0 || !/\btry\s*$/.test(code.slice(0, open))) violations.push(`${rel(f)}: require("${spec}")`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10); // chat-ui alone has 10 optional requires
    expect(violations).toEqual([]);
  });

  it("pure modules import neither react nor react-native, nor any React module", () => {
    const violations: string[] = [];
    for (const f of files.filter(isPure)) {
      for (const spec of importsOf(f)) {
        if (spec === "react" || spec === "react-native" || spec.startsWith("react-native/")) violations.push(`${rel(f)} -> ${spec}`);
        const target = resolveLocal(f, spec);
        if (target && !isPure(target)) violations.push(`${rel(f)} -> ${spec} (not pure)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no app coupling in the kit", () => {
    const forbidden = [/AsyncStorage/, /@react-navigation/, /navigate\(/, /notifee/i, /flash-message/, /smartmaheshwari/i, /webrtcpass/, /DeviceEventEmitter/, /NativeModules/];
    const violations: string[] = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      for (const re of forbidden) {
        // notifee is the Android backend of commskit/call-native (required only in android.ts; background.ts uses it via android.ts).
        if (String(re) === "/notifee/i" && ["call-native/android.ts", "call-native/background.ts"].includes(rel(f))) continue;
        if (re.test(code)) violations.push(`${rel(f)}: ${re}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("package.json exports point at existing entry files", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const key of [".", "./core", "./chat", "./call", "./theme", "./chat-ui", "./call-ui", "./notifications", "./moderation", "./call-native"]) {
      const entry = pkg.exports[key];
      for (const cond of ["types", "react-native", "default"]) {
        expect(fs.existsSync(path.join(ROOT, entry[cond]))).toBe(true);
      }
    }
    for (const opt of ["@stream-io/react-native-webrtc", "react-native-incall-manager", "expo-file-system", ...OPTIONAL_PEERS]) {
      expect(pkg.peerDependenciesMeta[opt]).toEqual({ optional: true });
    }
  });
});
