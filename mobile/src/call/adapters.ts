/**
 * Host-pluggable side effects of a call.
 * - CallAudio: audio routing, ringtone, ringback, speaker. Default: react-native-incall-manager
 *   (lazily required — the only module besides webrtc.ts that touches a native call lib).
 * - CallNotifier: system notifications (full-screen ringing, ongoing call). Default: no-op.
 *   e.g. a host plugs its native Android call-notification module in here.
 */
import type { Logger } from "../core/config";
import type { CallType, UserId } from "../core/types";

export interface CallAudio {
  /** In-call audio routing once connected (earpiece unless `speaker`). */
  start(options: { speaker: boolean }): void;
  /** Call finished: release audio routing. */
  stop(): void;
  /** Incoming call ringing (foreground). */
  startRingtone(): void;
  stopRingtone(): void;
  /** Outgoing call ringing (optional). */
  startRingback?(): void;
  stopRingback?(): void;
  setSpeaker(on: boolean): void;
}

export const noopAudio: CallAudio = {
  start: () => {},
  stop: () => {},
  startRingtone: () => {},
  stopRingtone: () => {},
  startRingback: () => {},
  stopRingback: () => {},
  setSpeaker: () => {},
};

export interface InCallManagerAudioOptions {
  /** Ringtone uri / "_DEFAULT_" (default "_DEFAULT_"). */
  ringtone?: string;
  /** Ring at most this long (default 45 s = server ring timeout). */
  ringSeconds?: number;
  vibrationPattern?: number[];
  /** Ringback for outgoing calls, e.g. "_DTMF_" or "_DEFAULT_". Default: none. */
  ringback?: string;
  logger?: Logger;
}

const DEFAULT_VIBRATION = [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];

const loadInCallManager = (): any => {
  try {
    const mod = require("react-native-incall-manager");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
};

/** Default CallAudio backed by react-native-incall-manager (no-op if it is not installed). */
export const createInCallManagerAudio = (options: InCallManagerAudioOptions = {}): CallAudio => {
  const { ringtone = "_DEFAULT_", ringSeconds = 45, vibrationPattern = DEFAULT_VIBRATION, ringback, logger } = options;
  let ringing = false;
  let ringingBack = false;
  let started = false;
  const safe = (what: string, fn: (icm: any) => void) => {
    const icm = loadInCallManager();
    if (!icm) return;
    try {
      fn(icm);
    } catch (e) {
      logger?.warn(`InCallManager ${what} failed`, e);
    }
  };
  return {
    start: ({ speaker }) =>
      safe("start", (icm) => {
        if (!started) {
          icm.start?.({ media: "audio", auto: true, ringback: "" });
          started = true;
        }
        icm.setKeepScreenOn?.(true);
        icm.setSpeakerphoneOn?.(speaker);
      }),
    stop: () =>
      safe("stop", (icm) => {
        icm.setKeepScreenOn?.(false);
        icm.stop?.();
        started = false;
        ringingBack = false;
      }),
    startRingtone: () => {
      if (ringing) return;
      safe("startRingtone", (icm) => {
        icm.startRingtone?.(ringtone, vibrationPattern, "playback", ringSeconds);
        ringing = true;
      });
    },
    stopRingtone: () => {
      if (!ringing) return;
      ringing = false;
      safe("stopRingtone", (icm) => icm.stopRingtone?.());
    },
    startRingback: () => {
      if (!ringback || ringingBack) return;
      safe("startRingback", (icm) => {
        icm.start?.({ media: "audio", ringback });
        started = true;
        ringingBack = true;
      });
    },
    stopRingback: () => {
      if (!ringingBack) return;
      ringingBack = false;
      safe("stopRingback", (icm) => icm.stopRingback?.());
    },
    setSpeaker: (on) => safe("setSpeaker", (icm) => icm.setSpeakerphoneOn?.(on)),
  };
};

export interface IncomingCallInfo {
  callId: string;
  peerId?: UserId;
  peerName?: string;
  peerAvatar?: string;
  callType: CallType;
}

export interface OngoingCallInfo {
  callId: string;
  peerId?: UserId;
  peerName?: string;
  peerAvatar?: string;
  connectedAt: number;
}

/**
 * System notifications. The provider calls:
 * - showIncoming while a call rings and the app is NOT in the foreground
 * - dismiss(callId) when it stops ringing (answered / ended) or the app comes to the foreground;
 *   dismiss() with no id = clear leftover incoming-call notifications
 * - startOngoing / stopOngoing while connected (foreground service on Android)
 * Notification buttons are fed back with `useCall().handleNotificationAction(action, callId)`.
 */
export interface CallNotifier {
  showIncoming(call: IncomingCallInfo): void | Promise<void>;
  dismiss(callId?: string): void | Promise<void>;
  startOngoing(call: OngoingCallInfo): void | Promise<void>;
  stopOngoing(): void | Promise<void>;
}

export const noopNotifier: CallNotifier = {
  showIncoming: () => {},
  dismiss: () => {},
  startOngoing: () => {},
  stopOngoing: () => {},
};

export type NotificationAction = "answer" | "decline" | "hangup" | "open";
