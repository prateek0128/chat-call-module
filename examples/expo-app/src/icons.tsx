/** `renderIcon` for the kit: every kit icon name mapped to a MaterialCommunityIcons glyph. */
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { IconName, IconRenderer } from "commskit/theme";

type MciName = keyof typeof MaterialCommunityIcons.glyphMap;

const ICONS: Record<IconName, MciName> = {
  back: "arrow-left",
  minimise: "chevron-down",
  chevronDown: "chevron-down",
  close: "close",
  search: "magnify",
  retry: "refresh",
  call: "phone",
  callEnd: "phone-hangup",
  callIncoming: "phone-incoming",
  callOutgoing: "phone-outgoing",
  callMissed: "phone-missed",
  mic: "microphone",
  micOff: "microphone-off",
  speaker: "volume-high",
  speakerOff: "volume-off",
  attach: "paperclip",
  send: "send",
  file: "file-document-outline",
  image: "image-outline",
  message: "message-text-outline",
  more: "dots-vertical",
  check: "check",
  palette: "palette-outline",
  camera: "camera-outline",
  videoCam: "video-outline",
  document: "file-document-outline",
  ban: "cancel",
  trash: "trash-can-outline",
  download: "download",
  share: "share-variant",
};

export const renderIcon: IconRenderer = (name, { size, color }) => {
  const glyph = ICONS[name];
  return glyph ? <MaterialCommunityIcons name={glyph} size={size} color={color} /> : undefined;
};
