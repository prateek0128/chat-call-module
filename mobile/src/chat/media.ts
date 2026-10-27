/**
 * Default `readFileAsBase64`: lazily requires `expo-file-system/legacy` (optional peer
 * dependency, Expo SDK 52+). This is the ONLY place in the kit that may touch
 * expo-file-system. Apps without Expo pass their own reader:
 *   <ChatProvider readFileAsBase64={(uri) => RNFS.readFile(uri, "base64")}>
 * The require sits in try/catch so Metro treats it as an optional dependency.
 */
import type { ReadFileAsBase64 } from "./types";

export const expoReadFileAsBase64: ReadFileAsBase64 = async (uri) => {
  let FileSystem: any;
  try {
    FileSystem = require("expo-file-system/legacy");
  } catch {
    FileSystem = null;
  }
  if (!FileSystem || typeof FileSystem.readAsStringAsync !== "function") {
    throw new Error(
      "[comms] expo-file-system is not installed. Install it or pass readFileAsBase64 to <ChatProvider>.",
    );
  }
  return FileSystem.readAsStringAsync(uri, { encoding: "base64" });
};
