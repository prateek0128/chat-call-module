/**
 * The ONLY home of chat-ui's optional native peers (rich chat features). Pure: no React.
 *
 * Each `require` sits lexically inside its own `try { }` block. Metro's
 * `transformer.allowOptionalDependencies` only treats a require as optional in that position (a
 * require inside a callback passed to a helper is NOT optional and breaks bundling when the
 * package is missing). Results are cached; a missing peer is null.
 *
 * | Peer | Feature | Without it |
 * |---|---|---|
 * | react-native-gesture-handler | swipe-right-to-reply, swipe-up banner dismiss | reply from the long-press menu; banner close button |
 * | expo-haptics | haptic tick on swipe-to-reply | no haptic |
 * | expo-clipboard | "Copy text" | action hidden |
 * | expo-video | in-app full-screen video player | Linking.openURL(video) |
 * | expo-audio / expo-av | inline audio play/pause | file card (opens the URL) |
 * | expo-file-system | download to cache with progress | Linking.openURL |
 * | expo-sharing | share sheet | Linking.openURL |
 * | expo-media-library | save image/video to the gallery | action hidden |
 * | expo-image-picker | `createExpoPickers()` gallery / camera / video items | item left out |
 * | expo-document-picker | `createExpoPickers()` document item | item left out |
 * | react-native-webview | in-app DocumentViewerModal | Linking.openURL(file) |
 */

export type OptionalPeerName =
  | "react-native-gesture-handler"
  | "expo-haptics"
  | "expo-clipboard"
  | "expo-video"
  | "expo-audio"
  | "expo-av"
  | "expo-file-system"
  | "expo-sharing"
  | "expo-media-library"
  | "expo-image-picker"
  | "expo-document-picker"
  | "react-native-webview";

const cache = new Map<string, any>();

/** Override / reset a peer (tests, or hosts that bundle a compatible module under another name). */
export const setOptionalPeer = (name: OptionalPeerName, module: unknown | undefined): void => {
  if (module === undefined) cache.delete(name);
  else cache.set(name, module);
};

const cached = (key: string): { hit: boolean; value: any } => (cache.has(key) ? { hit: true, value: cache.get(key) } : { hit: false, value: null });
const store = (key: string, mod: any): any => {
  cache.set(key, mod || null);
  return mod || null;
};

const loadGestureHandler = (): any => {
  const c = cached("react-native-gesture-handler");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("react-native-gesture-handler");
  } catch {
    mod = null;
  }
  return store("react-native-gesture-handler", mod);
};

const loadHaptics = (): any => {
  const c = cached("expo-haptics");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-haptics");
  } catch {
    mod = null;
  }
  return store("expo-haptics", mod);
};

const loadClipboard = (): any => {
  const c = cached("expo-clipboard");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-clipboard");
  } catch {
    mod = null;
  }
  return store("expo-clipboard", mod);
};

const loadVideo = (): any => {
  const c = cached("expo-video");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-video");
  } catch {
    mod = null;
  }
  return store("expo-video", mod);
};

const loadExpoAudio = (): any => {
  const c = cached("expo-audio");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-audio");
  } catch {
    mod = null;
  }
  return store("expo-audio", mod);
};

const loadExpoAv = (): any => {
  const c = cached("expo-av");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-av");
  } catch {
    mod = null;
  }
  return store("expo-av", mod);
};

const loadFileSystemLegacy = (): any => {
  const c = cached("expo-file-system/legacy");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-file-system/legacy");
  } catch {
    mod = null;
  }
  return store("expo-file-system/legacy", mod);
};

const loadFileSystem = (): any => {
  const c = cached("expo-file-system");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-file-system");
  } catch {
    mod = null;
  }
  return store("expo-file-system", mod);
};

const loadSharing = (): any => {
  const c = cached("expo-sharing");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-sharing");
  } catch {
    mod = null;
  }
  return store("expo-sharing", mod);
};

const loadMediaLibrary = (): any => {
  const c = cached("expo-media-library");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-media-library");
  } catch {
    mod = null;
  }
  return store("expo-media-library", mod);
};

const loadImagePicker = (): any => {
  const c = cached("expo-image-picker");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-image-picker");
  } catch {
    mod = null;
  }
  return store("expo-image-picker", mod);
};

const loadDocumentPicker = (): any => {
  const c = cached("expo-document-picker");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("expo-document-picker");
  } catch {
    mod = null;
  }
  return store("expo-document-picker", mod);
};

const loadWebView = (): any => {
  const c = cached("react-native-webview");
  if (c.hit) return c.value;
  let mod: any = null;
  try {
    mod = require("react-native-webview");
  } catch {
    mod = null;
  }
  return store("react-native-webview", mod);
};

/** expo-image-picker (`launchImageLibraryAsync`) or null. */
export const getImagePicker = (): any => {
  const m = loadImagePicker();
  return m && typeof m.launchImageLibraryAsync === "function" ? m : null;
};

/** expo-document-picker (`getDocumentAsync`) or null. */
export const getDocumentPicker = (): any => {
  const m = loadDocumentPicker();
  return m && typeof m.getDocumentAsync === "function" ? m : null;
};

/** react-native-webview's `WebView` component or null. */
export const getWebView = (): any => {
  const m = loadWebView();
  const W = m && (m.WebView || m.default);
  return W || null;
};

/** `{ GestureDetector, Gesture }` (RNGH v2) or null. */
export const getGestureHandler = (): any => {
  const m = loadGestureHandler();
  return m && m.GestureDetector && m.Gesture ? m : null;
};

export const getHaptics = (): any => loadHaptics();

export const getClipboard = (): any => {
  const m = loadClipboard();
  return m && typeof m.setStringAsync === "function" ? m : null;
};

/** `{ VideoView, useVideoPlayer }` or null. */
export const getVideo = (): any => {
  const m = loadVideo();
  return m && m.VideoView && m.useVideoPlayer ? m : null;
};

/** expo-audio (`useAudioPlayer`) or null. */
export const getExpoAudio = (): any => {
  const m = loadExpoAudio();
  return m && typeof m.useAudioPlayer === "function" ? m : null;
};

/** expo-av (`Audio.Sound`) or null. */
export const getExpoAv = (): any => {
  const m = loadExpoAv();
  return m && m.Audio && m.Audio.Sound ? m : null;
};

/** expo-file-system legacy API (`createDownloadResumable`, `cacheDirectory`) or null. */
export const getFileSystem = (): any => {
  const legacy = loadFileSystemLegacy();
  if (legacy && typeof legacy.createDownloadResumable === "function") return legacy;
  const m = loadFileSystem();
  return m && typeof m.createDownloadResumable === "function" ? m : null;
};

export const getSharing = (): any => {
  const m = loadSharing();
  return m && typeof m.shareAsync === "function" ? m : null;
};

export const getMediaLibrary = (): any => {
  const m = loadMediaLibrary();
  return m && typeof m.saveToLibraryAsync === "function" ? m : null;
};

/** Light haptic tick (no-op without expo-haptics). */
export const hapticTick = (): void => {
  const h = getHaptics();
  try {
    if (h?.selectionAsync) void Promise.resolve(h.selectionAsync()).catch(() => undefined);
    else if (h?.impactAsync) void Promise.resolve(h.impactAsync(h.ImpactFeedbackStyle?.Light ?? "light")).catch(() => undefined);
  } catch {
    // ignore
  }
};

/** Copy text; false when expo-clipboard is missing or fails. */
export const copyText = async (text: string): Promise<boolean> => {
  const c = getClipboard();
  if (!c) return false;
  try {
    await c.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
};
