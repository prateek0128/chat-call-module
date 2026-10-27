/** Attachment checks for the preview sheet (the 10 MB limit is checked before upload). Pure. */
import { MAX_UPLOAD_BYTES } from "../chat/ChatStore";
import { formatFileSize } from "./format";

export interface PickedAttachment {
  uri: string;
  name: string;
  /** MIME type (`image/jpeg`) or picker kind (`image`). */
  type: string;
  size: number;
}

export type AttachmentCheck = { ok: true } | { ok: false; reason: "too_large" | "empty"; message: string };

export const checkAttachmentSize = (size: number | null | undefined, maxBytes: number = MAX_UPLOAD_BYTES): AttachmentCheck => {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return { ok: true }; // unknown size: the store checks again after reading
  if (n === 0) return { ok: false, reason: "empty", message: "This file is empty." };
  if (n > maxBytes) {
    return { ok: false, reason: "too_large", message: `File is too large (${formatFileSize(n)}). The limit is ${formatFileSize(maxBytes)}.` };
  }
  return { ok: true };
};

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i;

export const isImageAttachment = (file: { type?: string | null; name?: string | null; uri?: string | null }): boolean => {
  const t = (file.type || "").toLowerCase();
  if (t === "image" || t.startsWith("image/")) return true;
  if (t && t !== "application/octet-stream") return false;
  return IMAGE_EXT.test(file.name || "") || IMAGE_EXT.test(file.uri || "");
};

/** File name for display: the picker name or the last URI segment. */
export const attachmentName = (file: { name?: string | null; uri?: string | null }): string => {
  if (file.name) return file.name;
  const last = (file.uri || "").split(/[\\/]/).pop() || "";
  return decodeURIComponentSafe(last.split("?")[0]) || "File";
};

const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
