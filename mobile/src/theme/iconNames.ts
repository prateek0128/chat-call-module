/** Icon names used by the UI kit and their default glyphs (no icon-font dependency). Pure. */

export type IconName =
  | "back"
  | "minimise"
  | "call"
  | "callEnd"
  | "callIncoming"
  | "callOutgoing"
  | "callMissed"
  | "mic"
  | "micOff"
  | "speaker"
  | "speakerOff"
  | "attach"
  | "send"
  | "file"
  | "image"
  | "search"
  | "close"
  | "chevronDown"
  | "message"
  | "retry"
  | "more"
  | "check"
  | "palette"
  | "camera"
  | "videoCam"
  | "document"
  | "ban"
  | "trash"
  | "download"
  | "share";

/** Text glyphs used when the host passes no `renderIcon`. */
export const DEFAULT_GLYPHS: Record<IconName, string> = {
  back: "‹",
  minimise: "⌄",
  call: "✆",
  callEnd: "✆",
  callIncoming: "↙",
  callOutgoing: "↗",
  callMissed: "↙",
  mic: "🎙",
  micOff: "🔇",
  speaker: "🔊",
  speakerOff: "🔈",
  attach: "📎",
  send: "➤",
  file: "📄",
  image: "📷",
  search: "⌕",
  close: "✕",
  chevronDown: "⌄",
  message: "💬",
  retry: "↻",
  more: "⋮",
  check: "✓",
  palette: "🎨",
  camera: "📸",
  videoCam: "🎥",
  document: "📄",
  ban: "⊘",
  trash: "🗑",
  download: "⤓",
  share: "⇪",
};
