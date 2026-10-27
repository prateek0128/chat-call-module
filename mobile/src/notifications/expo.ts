/**
 * The only file in commskit/notifications that touches expo-notifications / expo-device.
 * Both are optional peers, lazily required so the rest of the kit works without them.
 */

const MISSING = "[comms] commskit/notifications needs expo-notifications and expo-device: npx expo install expo-notifications expo-device";

export const loadExpoNotifications = (): any => {
  try {
    return require("expo-notifications");
  } catch {
    return null;
  }
};

export const loadExpoDevice = (): any => {
  try {
    const mod = require("expo-device");
    return mod?.default && mod.default.osName !== undefined ? mod.default : mod;
  } catch {
    return null;
  }
};

/** Throws a clear error when expo-notifications is not installed. */
export const requireExpoNotifications = (): any => {
  const mod = loadExpoNotifications();
  if (!mod) throw new Error(MISSING);
  return mod;
};
