/** Connection banner model from the client status. Pure. */
import { backoffDelay, type StatusInfo } from "../core/CommsClient";

export interface ConnectionBannerModel {
  visible: boolean;
  tone: "warning" | "danger";
  text: string;
  /** Show a "Retry" action (reconnect now). */
  showRetry: boolean;
  /** Seconds until the next automatic attempt (offline state), else null. */
  retryInSeconds: number | null;
}

/** Attempts after which "Connecting…" becomes "Offline. Retrying in Ns". */
export const OFFLINE_AFTER_ATTEMPTS = 3;

const HIDDEN: ConnectionBannerModel = { visible: false, tone: "warning", text: "", showRetry: false, retryInSeconds: null };

/**
 * `elapsedMs`: time since this status was reported (drives the countdown).
 * The client waits `backoffDelay(attempt - 1)` before attempt N (attempt counts scheduled retries).
 */
export const connectionBannerModel = (
  info: Pick<StatusInfo, "status" | "attempt">,
  elapsedMs = 0,
  offlineAfter: number = OFFLINE_AFTER_ATTEMPTS,
): ConnectionBannerModel => {
  switch (info.status) {
    case "open":
    case "idle":
    case "unauthenticated":
      return HIDDEN;
    case "connecting":
      return { visible: true, tone: "warning", text: "Connecting…", showRetry: false, retryInSeconds: null };
    case "reconnecting": {
      if (info.attempt < offlineAfter) return { visible: true, tone: "warning", text: "Connecting…", showRetry: false, retryInSeconds: null };
      const delay = backoffDelay(Math.max(0, info.attempt - 1));
      const left = Math.max(0, Math.ceil((delay - Math.max(0, elapsedMs)) / 1000));
      return {
        visible: true,
        tone: "danger",
        text: left > 0 ? `Offline. Retrying in ${left}s` : "Offline. Retrying…",
        showRetry: true,
        retryInSeconds: left,
      };
    }
    default:
      return HIDDEN;
  }
};
