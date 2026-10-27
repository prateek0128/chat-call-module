/** Document type badges on file cards ("PDF · 1.2 MB"). Pure. */
import { formatFileSize } from "./format";

/** Theme colour key used for the badge background. */
export type DocumentBadgeColor = "danger" | "accent" | "success" | "warning" | "textMuted";

export interface DocumentBadge {
  /** "PDF", "DOC", "XLS", "PPT", "ZIP", "TXT" or the upper-case extension ("CSV"); "FILE" when unknown. */
  label: string;
  colorToken: DocumentBadgeColor;
}

const BY_EXT: Record<string, DocumentBadge> = {
  pdf: { label: "PDF", colorToken: "danger" },
  doc: { label: "DOC", colorToken: "accent" },
  docx: { label: "DOC", colorToken: "accent" },
  odt: { label: "DOC", colorToken: "accent" },
  rtf: { label: "DOC", colorToken: "accent" },
  xls: { label: "XLS", colorToken: "success" },
  xlsx: { label: "XLS", colorToken: "success" },
  ods: { label: "XLS", colorToken: "success" },
  csv: { label: "CSV", colorToken: "success" },
  ppt: { label: "PPT", colorToken: "warning" },
  pptx: { label: "PPT", colorToken: "warning" },
  odp: { label: "PPT", colorToken: "warning" },
  key: { label: "PPT", colorToken: "warning" },
  zip: { label: "ZIP", colorToken: "textMuted" },
  rar: { label: "ZIP", colorToken: "textMuted" },
  "7z": { label: "ZIP", colorToken: "textMuted" },
  gz: { label: "ZIP", colorToken: "textMuted" },
  tar: { label: "ZIP", colorToken: "textMuted" },
  txt: { label: "TXT", colorToken: "textMuted" },
  md: { label: "TXT", colorToken: "textMuted" },
  log: { label: "TXT", colorToken: "textMuted" },
};

const BY_MIME: Array<[RegExp, string]> = [
  [/pdf/, "pdf"],
  [/msword|wordprocessingml|opendocument\.text|rtf/, "doc"],
  [/ms-excel|spreadsheetml|opendocument\.spreadsheet/, "xls"],
  [/text\/csv/, "csv"],
  [/ms-powerpoint|presentationml|opendocument\.presentation/, "ppt"],
  [/zip|x-rar|x-7z|gzip|x-tar/, "zip"],
  [/^text\/plain/, "txt"],
];

/** Badge for a file: by extension first, then MIME type; else the extension upper-cased, else "FILE". */
export const documentBadge = (name?: string | null, mime?: string | null): DocumentBadge => {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec((name || "").split("?")[0].trim())?.[1] || "").toLowerCase();
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const m = (mime || "").toLowerCase();
  for (const [re, key] of BY_MIME) if (re.test(m)) return BY_EXT[key];
  if (ext) return { label: ext.toUpperCase().slice(0, 4), colorToken: "textMuted" };
  return { label: "FILE", colorToken: "textMuted" };
};

/** File card meta line: "PDF · 1.2 MB" (size omitted when unknown). */
export const documentMeta = (name?: string | null, mime?: string | null, size?: number | null): string => {
  const badge = documentBadge(name, mime);
  const s = formatFileSize(size);
  return s ? `${badge.label} · ${s}` : badge.label;
};
