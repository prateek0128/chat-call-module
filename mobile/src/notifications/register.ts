/**
 * Device registration (PROTOCOL §8): permission, Expo push token, Android channels,
 * `POST /devices` / `DELETE /devices/{device_id}`. Pure (no React); uses expo-notifications
 * and expo-device through ./expo (lazy optional peers).
 */
import { authFetch, CommsHttpError, type CommsConfig, type MaybePromise } from "../core/config";
import { channelDefinitions, type ChannelNames } from "./channels";
import { loadExpoDevice, requireExpoNotifications } from "./expo";

export type DevicePlatform = "ios" | "android" | "web";
export type PushPermission = "granted" | "denied" | "undetermined";

export interface RegisterDeviceOptions {
  /** Kit config (`baseUrl`, `getToken`); the same object you pass to <CommsProvider>. */
  config: Pick<CommsConfig, "baseUrl" | "getToken" | "logger">;
  /**
   * Stable id of this install (upsert key on the backend). Recommended: expo-application's
   * `getIosIdForVendorAsync()` / `getAndroidId()`, or a UUID you persist. Default: derived from
   * the push token (stable until the token rotates).
   */
  deviceId?: string;
  /** iOS PushKit token (see commskit/call-native `registerVoipPush`). */
  getVoipToken?: () => MaybePromise<string | null | undefined>;
  /** EAS project id for `getExpoPushTokenAsync` (default: what expo-notifications infers). */
  projectId?: string;
  /** Default: from expo-device `osName`. */
  platform?: DevicePlatform;
  appVersion?: string;
  /** Ask for permission when not granted yet (default true). false: only use an existing grant. */
  requestPermission?: boolean;
  /** Create the Android channels `messages` and `call_ringtone` (default true). */
  createChannels?: boolean;
  channelNames?: ChannelNames;
}

export interface RegisterDeviceResult {
  registered: boolean;
  deviceId: string | null;
  permission: PushPermission;
  expoPushToken: string | null;
  voipToken: string | null;
  /** Why nothing was registered. */
  reason?: "permission_denied" | "not_a_device" | "no_token";
}

/** Body of `POST /devices`. */
export interface DeviceRegistration {
  device_id: string;
  platform: DevicePlatform;
  expo_push_token?: string;
  voip_token?: string;
  app_version?: string;
  os_version?: string;
  model?: string;
}

let lastDevice: { deviceId: string; config: RegisterDeviceOptions["config"] } | null = null;

/** FNV-1a (two 32-bit lanes): a short, stable, non-reversible id from a token. */
export const shortHash = (s: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
};

export const platformFromOsName = (osName: unknown): DevicePlatform | null => {
  const s = String(osName || "").toLowerCase();
  if (s === "ios" || s === "ipados") return "ios";
  if (s === "android") return "android";
  if (s === "web") return "web";
  return null;
};

const permissionOf = (p: any): PushPermission => {
  if (p?.granted || p?.status === "granted" || p?.ios?.status === 2 /* authorized */ || p?.ios?.status === 3 /* provisional */) return "granted";
  return p?.status === "denied" ? "denied" : "undetermined";
};

/** Create the Android channels (no-op elsewhere). Safe to call on every launch. */
export const ensureNotificationChannels = async (platform: DevicePlatform | null, names?: ChannelNames): Promise<void> => {
  if (platform !== "android") return;
  const Notifications = requireExpoNotifications();
  for (const { id, channel } of channelDefinitions(Notifications, names)) {
    await Notifications.setNotificationChannelAsync(id, channel);
  }
};

/**
 * Ask for notification permission, read the Expo push token (and the VoIP token on iOS),
 * create the Android channels and `POST /devices`. Call after login and on each app start
 * (tokens can rotate; the backend upserts by `device_id`).
 */
export const registerDevice = async (options: RegisterDeviceOptions): Promise<RegisterDeviceResult> => {
  const { config, requestPermission = true, createChannels = true } = options;
  const Notifications = requireExpoNotifications();
  const Device = loadExpoDevice();
  const platform = options.platform || platformFromOsName(Device?.osName) || "android";

  if (createChannels) await ensureNotificationChannels(platform, options.channelNames);

  let permission = permissionOf(await Notifications.getPermissionsAsync());
  if (permission !== "granted" && requestPermission) {
    permission = permissionOf(
      await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } }),
    );
  }

  const voipToken = (options.getVoipToken ? await options.getVoipToken() : null) || null;
  let expoPushToken: string | null = null;
  let reason: RegisterDeviceResult["reason"];
  if (Device && Device.isDevice === false) {
    reason = "not_a_device"; // simulators / emulators can't receive remote pushes
  } else if (permission === "granted") {
    try {
      const res = await Notifications.getExpoPushTokenAsync(options.projectId ? { projectId: options.projectId } : undefined);
      expoPushToken = (res && (res.data || res)) || null;
      if (typeof expoPushToken !== "string") expoPushToken = null;
    } catch (e) {
      config.logger?.warn("getExpoPushTokenAsync failed", e);
    }
  } else {
    reason = "permission_denied";
  }

  if (!expoPushToken && !voipToken) {
    return { registered: false, deviceId: options.deviceId || null, permission, expoPushToken, voipToken, reason: reason || "no_token" };
  }

  const deviceId = options.deviceId || `${platform}-${shortHash(String(expoPushToken || voipToken))}`;
  const body: DeviceRegistration = { device_id: deviceId, platform };
  if (expoPushToken) body.expo_push_token = expoPushToken;
  if (voipToken) body.voip_token = voipToken;
  if (options.appVersion) body.app_version = options.appVersion;
  if (Device?.osVersion) body.os_version = String(Device.osVersion);
  if (Device?.modelName) body.model = String(Device.modelName);

  await authFetch(config, "/devices", { method: "POST", body });
  lastDevice = { deviceId, config };
  return { registered: true, deviceId, permission, expoPushToken, voipToken };
};

/**
 * `DELETE /devices/{device_id}` — call on logout, BEFORE dropping the auth token.
 * Defaults to the device registered last in this session. Resolves false when there is nothing
 * to remove (or the backend no longer knows the device).
 */
export const unregisterDevice = async (
  options: { config?: Pick<CommsConfig, "baseUrl" | "getToken" | "logger">; deviceId?: string } = {},
): Promise<boolean> => {
  const deviceId = options.deviceId || lastDevice?.deviceId;
  const config = options.config || lastDevice?.config;
  if (!deviceId || !config) return false;
  try {
    await authFetch(config, `/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    return true;
  } catch (e) {
    if (e instanceof CommsHttpError && e.status === 404) return false;
    throw e;
  } finally {
    if (lastDevice?.deviceId === deviceId) lastDevice = null;
  }
};
