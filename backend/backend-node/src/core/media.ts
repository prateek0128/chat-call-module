/** Media type detection by file extension (port of commskit.core.media). */
import path from "node:path";

// Order matters: the first type whose extensions match wins ("voice" shares the audio extensions,
// so it is only chosen when the client asks for it).
export const MEDIA_EXTENSIONS: Record<string, readonly string[]> = {
  image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"],
  video: [".mp4", ".avi", ".mov", ".mkv", ".3gp"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"],
  voice: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"],
  document: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".zip", ".rar"],
  webm: [".webm"],
};
export const MEDIA_TYPES: ReadonlySet<string> = new Set(Object.keys(MEDIA_EXTENSIONS));

export function detectMediaType(fileName: string, requested?: unknown): string | null {
  if (typeof requested === "string" && MEDIA_TYPES.has(requested)) return requested;
  const ext = path.extname(fileName.toLowerCase());
  for (const [type, exts] of Object.entries(MEDIA_EXTENSIONS)) if (exts.includes(ext)) return type;
  return null;
}
