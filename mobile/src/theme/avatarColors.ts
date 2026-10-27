/** Avatar helpers (pure): initials and a stable palette colour per user. */

/** "Asha Rao" -> "AR", "bob" -> "B", "" -> "?". Ignores emoji/punctuation-only words. */
export const initialsOf = (name: string | null | undefined): string => {
  const words = (name || "")
    .trim()
    .split(/\s+/)
    // Drop leading punctuation / emoji (surrogate pairs); keeps Latin, accented and BMP scripts.
    .map((w) => w.replace(/^[^A-Za-z0-9À-퟿-￿]+/, ""))
    .filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0] || "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
  return (first + last).toUpperCase() || "?";
};

/** djb2 hash -> palette index; same key always gets the same colour. */
export const avatarColor = (key: string | null | undefined, palette: string[]): string => {
  if (!palette.length) return "";
  const s = key || "";
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
};
