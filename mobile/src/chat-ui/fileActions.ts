/**
 * File actions for attachments (download, share, save to gallery). Injectable: pass your own
 * `FileActions` to ChatScreen `fileActions`, or use `createDefaultFileActions()`, built on the
 * optional peers expo-file-system (download to cache with progress), expo-sharing (share sheet)
 * and expo-media-library (save to gallery, asks permission). Missing peers fall back to
 * `openURL` (ChatScreen passes `Linking.openURL`). Pure: no React / react-native.
 */
import { getFileSystem, getMediaLibrary, getSharing } from "./optionalPeers";

export interface FileActionTarget {
  url: string;
  name?: string | null;
  mimeType?: string | null;
  /** "image" | "video" | "audio" | "file" */
  kind?: string | null;
}

export type FileActionFailure = "permission_denied" | "unavailable" | "failed" | "no_url";

export interface FileActionResult {
  ok: boolean;
  /** Local file (download / save) or the remote URL (fallback). */
  uri?: string;
  /** Opened the URL with `openURL` instead (peer missing). */
  fallback?: boolean;
  reason?: FileActionFailure;
  error?: string;
}

export type FileActionProgress = (fraction: number) => void;

export interface FileActions {
  download(target: FileActionTarget, onProgress?: FileActionProgress): Promise<FileActionResult>;
  share(target: FileActionTarget, onProgress?: FileActionProgress): Promise<FileActionResult>;
  /** Images / videos only. */
  saveToGallery(target: FileActionTarget, onProgress?: FileActionProgress): Promise<FileActionResult>;
  /** Which actions to offer (menu items are hidden when false). */
  capabilities(): { download: boolean; share: boolean; saveToGallery: boolean };
}

export interface FileActionModules {
  /** expo-file-system (legacy API: createDownloadResumable, cacheDirectory). null = missing. */
  fileSystem?: any;
  sharing?: any;
  mediaLibrary?: any;
}

export interface DefaultFileActionsOptions {
  /** Inject modules (tests / custom builds). Default: the lazily required optional peers. */
  modules?: FileActionModules;
  /** Fallback when a peer is missing (ChatScreen passes Linking.openURL). */
  openURL?: (url: string) => Promise<unknown>;
}

/** File name safe for the cache directory. */
export const safeFileName = (target: FileActionTarget): string => {
  const fromUrl = (target.url.split("?")[0].split("#")[0].split("/").pop() || "").trim();
  let base = (target.name || "").trim() || decodeSafe(fromUrl) || "file";
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(-120);
  if (!/\.[a-z0-9]{1,8}$/i.test(base)) {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(fromUrl)?.[1] || extFromMime(target.mimeType);
    if (ext) base = `${base}.${ext}`;
  }
  return base;
};

const decodeSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const extFromMime = (mime?: string | null): string => {
  const m = (mime || "").toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
  };
  return map[m] || "";
};

const errText = (e: unknown) => String((e as Error)?.message || e || "Unknown error");

const pick = (given: any, fallback: () => any) => (given === undefined ? fallback() : given);

export const createDefaultFileActions = (options: DefaultFileActionsOptions = {}): FileActions => {
  const mods = options.modules || {};
  const fs = () => pick(mods.fileSystem, getFileSystem);
  const sharing = () => pick(mods.sharing, getSharing);
  const library = () => pick(mods.mediaLibrary, getMediaLibrary);
  const openURL = options.openURL;

  const openFallback = async (target: FileActionTarget): Promise<FileActionResult> => {
    if (!openURL) return { ok: false, reason: "unavailable", error: "No file support installed" };
    try {
      await openURL(target.url);
      return { ok: true, uri: target.url, fallback: true };
    } catch (e) {
      return { ok: false, reason: "failed", error: errText(e) };
    }
  };

  const downloadLocal = async (target: FileActionTarget, onProgress?: FileActionProgress): Promise<FileActionResult | null> => {
    const FS = fs();
    if (!FS || typeof FS.createDownloadResumable !== "function" || !FS.cacheDirectory) return null;
    if (/^(file|content):/i.test(target.url)) return { ok: true, uri: target.url };
    const dest = `${FS.cacheDirectory}${FS.cacheDirectory.endsWith("/") ? "" : "/"}${safeFileName(target)}`;
    try {
      const task = FS.createDownloadResumable(target.url, dest, {}, (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => {
        if (onProgress && p && p.totalBytesExpectedToWrite > 0) onProgress(Math.max(0, Math.min(1, p.totalBytesWritten / p.totalBytesExpectedToWrite)));
      });
      const res = await task.downloadAsync();
      if (!res || (res.status && (res.status < 200 || res.status >= 300))) {
        return { ok: false, reason: "failed", error: `Download failed${res?.status ? ` (HTTP ${res.status})` : ""}` };
      }
      onProgress?.(1);
      return { ok: true, uri: res.uri || dest };
    } catch (e) {
      return { ok: false, reason: "failed", error: errText(e) };
    }
  };

  return {
    capabilities: () => ({ download: true, share: true, saveToGallery: !!library() }),

    async download(target, onProgress) {
      if (!target.url) return { ok: false, reason: "no_url", error: "No file to download" };
      return (await downloadLocal(target, onProgress)) || openFallback(target);
    },

    async share(target, onProgress) {
      if (!target.url) return { ok: false, reason: "no_url", error: "No file to share" };
      const S = sharing();
      let available = !!S;
      if (S && typeof S.isAvailableAsync === "function") {
        try {
          available = !!(await S.isAvailableAsync());
        } catch {
          available = false;
        }
      }
      if (!available) return openFallback(target);
      const local = await downloadLocal(target, onProgress);
      if (!local) return openFallback(target); // sharing needs a local file
      if (!local.ok) return local;
      try {
        await S.shareAsync(local.uri, { mimeType: target.mimeType || undefined, dialogTitle: target.name || undefined });
        return { ok: true, uri: local.uri };
      } catch (e) {
        return { ok: false, reason: "failed", error: errText(e) };
      }
    },

    async saveToGallery(target, onProgress) {
      if (!target.url) return { ok: false, reason: "no_url", error: "No file to save" };
      const L = library();
      if (!L) return { ok: false, reason: "unavailable", error: "Saving to the gallery isn't available" };
      try {
        const perm = typeof L.requestPermissionsAsync === "function" ? await L.requestPermissionsAsync(true) : { granted: true };
        if (!perm || (!perm.granted && perm.status !== "granted")) {
          return { ok: false, reason: "permission_denied", error: "Allow photo library access to save" };
        }
      } catch (e) {
        return { ok: false, reason: "permission_denied", error: errText(e) };
      }
      const local = await downloadLocal(target, onProgress);
      if (!local) return { ok: false, reason: "unavailable", error: "Downloading isn't available (install expo-file-system)" };
      if (!local.ok) return local;
      try {
        await L.saveToLibraryAsync(local.uri);
        return { ok: true, uri: local.uri };
      } catch (e) {
        return { ok: false, reason: "failed", error: errText(e) };
      }
    },
  };
};
