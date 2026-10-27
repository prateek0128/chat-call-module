/** Host-side pickers the kit asks for: chat attachments and wallpaper images (expo-image-picker). */
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import type { PickedWallpaperImage } from "commskit/chat-ui";

/** ChatScreen `pickAttachment`: one photo from the library. */
export const pickAttachment = async () => {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
  const a = r.canceled ? null : r.assets[0];
  return a ? { uri: a.uri, name: a.fileName ?? "photo.jpg", type: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 } : null;
};

/** AppearanceSheet "Choose image…": downscale to maxEdge and copy to persistent storage (the kit stores only the uri). */
export const pickWallpaperImage = async ({ maxEdge }: { maxEdge: number }): Promise<PickedWallpaperImage | null> => {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
  if (res.canceled) return null;
  const a = res.assets[0];
  const resize =
    (a.width ?? 0) >= (a.height ?? 0) ? { width: Math.min(maxEdge, a.width ?? maxEdge) } : { height: Math.min(maxEdge, a.height ?? maxEdge) };
  const small = await ImageManipulator.manipulateAsync(a.uri, [{ resize }], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
  const dest = `${FileSystem.documentDirectory}wallpaper-${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: small.uri, to: dest });
  return { uri: dest, width: small.width, height: small.height };
};
