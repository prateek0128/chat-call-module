/**
 * Attach-menu pickers. The host passes `pickers` to ChatScreen / AttachMenu; `createExpoPickers()`
 * builds the usual set on the optional peers expo-image-picker / expo-document-picker (items whose
 * module is missing are left out). Pure: no React / react-native.
 */
import type { IconName } from "../theme/iconNames";
import type { PickedAttachment } from "./attachments";
import { getDocumentPicker, getImagePicker } from "./optionalPeers";

export type AttachPickerKey = "gallery" | "camera" | "video" | "record" | "document";

export interface AttachPicker {
  key: AttachPickerKey | (string & {});
  label: string;
  icon?: IconName;
  /** Resolve null when the user cancels (or permission is denied). */
  pick: () => Promise<PickedAttachment | null>;
}

export interface ExpoPickersOptions {
  /** Inject modules (tests / custom builds). Default: the lazily required optional peers. */
  modules?: { imagePicker?: any; documentPicker?: any };
  /** Which items, in order. Default all five. */
  keys?: AttachPickerKey[];
  /** JPEG quality 0..1 (default 0.8). */
  quality?: number;
  /** Max recorded video length in seconds (default 120). */
  videoMaxDuration?: number;
  /** Labels override ({ gallery: "Photos" }). */
  labels?: Partial<Record<AttachPickerKey, string>>;
  /** Called when a permission is denied (show your own prompt). */
  onPermissionDenied?: (key: AttachPickerKey) => void;
}

const DEFAULT_LABELS: Record<AttachPickerKey, string> = {
  gallery: "Photo",
  camera: "Camera",
  video: "Video",
  record: "Record video",
  document: "Document",
};

const ICONS: Record<AttachPickerKey, IconName> = {
  gallery: "image",
  camera: "camera",
  video: "videoCam",
  record: "videoCam",
  document: "document",
};

const lastSegment = (uri: string) => decodeSafe((uri.split("?")[0].split(/[\\/]/).pop() || "").trim());
const decodeSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Normalises an expo-image-picker result (new `assets` + legacy shapes). */
export const fromImagePickerResult = (result: any, fallbackKind: "image" | "video"): PickedAttachment | null => {
  if (!result || result.canceled || result.cancelled) return null;
  const a = Array.isArray(result.assets) ? result.assets[0] : result;
  if (!a?.uri) return null;
  const kind = a.type === "video" || /^video\//.test(a.mimeType || "") ? "video" : a.type === "image" ? "image" : fallbackKind;
  const name = a.fileName || lastSegment(a.uri) || (kind === "video" ? "video.mp4" : "photo.jpg");
  return { uri: a.uri, name, type: a.mimeType || kind, size: typeof a.fileSize === "number" ? a.fileSize : -1 };
};

/** Normalises an expo-document-picker result (new `assets` + legacy `{type: "success"}` shapes). */
export const fromDocumentPickerResult = (result: any): PickedAttachment | null => {
  if (!result || result.canceled || result.type === "cancel") return null;
  const a = Array.isArray(result.assets) ? result.assets[0] : result;
  if (!a?.uri) return null;
  return {
    uri: a.uri,
    name: a.name || lastSegment(a.uri) || "document",
    type: a.mimeType || "application/octet-stream",
    size: typeof a.size === "number" ? a.size : -1,
  };
};

const granted = (r: any) => !!r && (r.granted === true || r.status === "granted");

/**
 * Default pickers on expo-image-picker / expo-document-picker. Returns only the items whose module
 * is installed (an empty list when neither is).
 */
export const createExpoPickers = (options: ExpoPickersOptions = {}): AttachPicker[] => {
  const ip = options.modules && "imagePicker" in options.modules ? options.modules.imagePicker : getImagePicker();
  const dp = options.modules && "documentPicker" in options.modules ? options.modules.documentPicker : getDocumentPicker();
  const quality = options.quality ?? 0.8;
  const labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };
  const keys = options.keys || (["gallery", "camera", "video", "record", "document"] as AttachPickerKey[]);
  const mediaTypes = (kind: "image" | "video") =>
    ip?.MediaTypeOptions ? (kind === "image" ? ip.MediaTypeOptions.Images : ip.MediaTypeOptions.Videos) : [kind === "image" ? "images" : "videos"];

  const library = (key: AttachPickerKey, kind: "image" | "video") => async () => {
    if (ip.requestMediaLibraryPermissionsAsync) {
      const p = await ip.requestMediaLibraryPermissionsAsync();
      if (!granted(p)) {
        options.onPermissionDenied?.(key);
        return null;
      }
    }
    return fromImagePickerResult(await ip.launchImageLibraryAsync({ mediaTypes: mediaTypes(kind), quality, allowsMultipleSelection: false }), kind);
  };
  const camera = (key: AttachPickerKey, kind: "image" | "video") => async () => {
    if (ip.requestCameraPermissionsAsync) {
      const p = await ip.requestCameraPermissionsAsync();
      if (!granted(p)) {
        options.onPermissionDenied?.(key);
        return null;
      }
    }
    const opts: Record<string, unknown> = { mediaTypes: mediaTypes(kind), quality };
    if (kind === "video") opts.videoMaxDuration = options.videoMaxDuration ?? 120;
    return fromImagePickerResult(await ip.launchCameraAsync(opts), kind);
  };

  const out: AttachPicker[] = [];
  for (const key of keys) {
    let pick: AttachPicker["pick"] | null = null;
    if (key === "gallery" && ip?.launchImageLibraryAsync) pick = library(key, "image");
    if (key === "video" && ip?.launchImageLibraryAsync) pick = library(key, "video");
    if (key === "camera" && ip?.launchCameraAsync) pick = camera(key, "image");
    if (key === "record" && ip?.launchCameraAsync) pick = camera(key, "video");
    if (key === "document" && dp?.getDocumentAsync) {
      pick = async () => fromDocumentPickerResult(await dp.getDocumentAsync({ copyToCacheDirectory: true, multiple: false }));
    }
    if (pick) out.push({ key, label: labels[key], icon: ICONS[key], pick });
  }
  return out;
};
