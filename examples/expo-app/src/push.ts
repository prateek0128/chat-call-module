/** Push / device wiring: POST /devices on login (+ iOS PushKit token), DELETE /devices on logout. */
import { Platform } from "react-native";
import * as Application from "expo-application";
import Constants from "expo-constants";
import type { CommsConfig } from "commskit/core";
import { registerDevice, unregisterDevice, type RegisterDeviceResult } from "commskit/notifications";
import { clearCallSession, registerVoipPush, saveCallSession, type CallKitNotifier } from "commskit/call-native";
import { getCallNotifier } from "./calls";

/** A stable id for this install (the backend upserts devices by it). */
export const getDeviceId = async (): Promise<string | undefined> => {
  try {
    if (Platform.OS === "android") return Application.getAndroidId() || undefined;
    if (Platform.OS === "ios") return (await Application.getIosIdForVendorAsync()) || undefined;
  } catch {
    /* fall back to the kit's default (derived from the push token) */
  }
  return undefined;
};

/** EAS project id (set by `eas init` / `eas build`); expo-notifications needs it for the Expo push token. */
const projectId: string | undefined =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

export interface PushSetup {
  result: RegisterDeviceResult | null;
  error: string | null;
  stop: () => void;
}

/**
 * After login (and on every app start): registers the device, lets a killed app decline calls
 * (saveCallSession) and, on iOS with calls on, sends the PushKit VoIP token with the device.
 */
export const setUpPush = async (
  config: CommsConfig,
  token: string,
  calls: boolean,
  onUpdate?: (r: RegisterDeviceResult | null, error: string | null) => void,
): Promise<PushSetup> => {
  const deviceId = await getDeviceId();
  const appVersion = Constants.expoConfig?.version;
  let voipToken: string | null = null;
  let stopVoip = () => {};
  let last: RegisterDeviceResult | null = null;
  let error: string | null = null;

  const register = async () => {
    try {
      last = await registerDevice({ config, deviceId, appVersion, projectId, getVoipToken: () => voipToken });
      error = last.registered ? null : `not registered: ${last.reason}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    onUpdate?.(last, error);
  };

  if (calls) {
    await saveCallSession({ baseUrl: config.baseUrl, token }).catch(() => undefined);
    if (Platform.OS === "ios") {
      try {
        // NativeCallNotifier on iOS is the CallKit notifier, which has rememberCall (call id <-> CallKit UUID).
        const notifier = getCallNotifier() as CallKitNotifier;
        stopVoip = registerVoipPush(
          (t) => {
            voipToken = t;
            void register(); // re-register with the VoIP token
          },
          { notifier },
        );
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }
  await register();
  return { result: last, error, stop: stopVoip };
};

/** Logout, BEFORE dropping the token. */
export const tearDownPush = async (stop?: () => void) => {
  stop?.();
  await clearCallSession().catch(() => undefined);
  await unregisterDevice().catch(() => false);
};
