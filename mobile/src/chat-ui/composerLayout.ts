/** Composer helpers: auto-grow clamp, send enablement, disabled reason. Pure. */

export interface ComposerMetrics {
  /** Line height of the input text (px). */
  lineHeight: number;
  /** Max visible lines before the field scrolls (`layout.composerMaxLines`). */
  maxLines: number;
  /** Vertical padding inside the field (top + bottom each). */
  paddingVertical: number;
}

export interface ComposerSize {
  /** Visible lines, 1..maxLines. */
  lines: number;
  /** Field height (px) for those lines including padding. */
  height: number;
  /** Content taller than maxLines: let the field scroll. */
  scrollEnabled: boolean;
}

/** Clamp the TextInput content height (`onContentSizeChange`) to 1..maxLines lines. */
export const clampComposerHeight = (contentHeight: number, m: ComposerMetrics): ComposerSize => {
  const inner = Math.max(0, (Number(contentHeight) || 0) - 2 * m.paddingVertical);
  const raw = Math.max(1, Math.round(inner / Math.max(1, m.lineHeight)));
  const lines = Math.min(m.maxLines, raw);
  return { lines, height: lines * m.lineHeight + 2 * m.paddingVertical, scrollEnabled: raw > m.maxLines };
};

/** Same clamp from the text alone (hard line breaks only), useful before layout. */
export const clampComposerLines = (text: string, maxLines: number): number =>
  Math.min(Math.max(1, maxLines), Math.max(1, (text || "").split("\n").length));

export const canSendText = (text: string, disabled = false): boolean => !disabled && (text || "").trim().length > 0;

export interface ComposerAvailability {
  isBlocked?: boolean | null;
  blockedByOther?: boolean | null;
  /** Host override, e.g. "Chat is not enabled". Wins over the block flags. */
  hostReason?: string | null;
}

/** Why the composer is disabled, or null when it is enabled. */
export const composerDisabledReason = (a: ComposerAvailability): string | null => {
  if (a.hostReason) return a.hostReason;
  if (a.isBlocked) return "You blocked this contact";
  if (a.blockedByOther) return "You can't reply to this conversation";
  return null;
};
