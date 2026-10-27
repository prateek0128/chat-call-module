/**
 * Call-log text helpers shared by chat (rendering call entries) and call
 * (local fallback log when the backend sends no `call_log`). Same wording as
 * the backend (PROTOCOL §4 "Call log text").
 */

import type { CallType } from "./types";

const pad = (n: number) => n.toString().padStart(2, "0");

/** 65 -> "01:05", 3725 -> "1:02:05" */
export const formatCallDuration = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
};

/** 342 -> "5 min 42 sec", 3600 -> "1 hr" */
export const friendlyDuration = (total: number): string => {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (m) return s ? `${m} min ${s} sec` : `${m} min`;
  return `${s} sec`;
};

export const secondsSince = (startMs: number, now: number = Date.now()): number =>
  Math.max(0, Math.floor((now - startMs) / 1000));

export type CallLogOutcome = "connected" | "missed" | "declined" | "cancelled";

/** `Voice call · 05:42`, `Missed voice call`, `Declined voice call`, `Cancelled voice call`. */
export const callLogText = (
  outcome: CallLogOutcome | "ended" | "failed" | "answered_elsewhere",
  durationSeconds: number | null,
  callType: CallType = "audio",
): string => {
  const kind = callType === "video" ? "video" : "voice";
  if (durationSeconds !== null && durationSeconds !== undefined) {
    return `${kind === "video" ? "Video" : "Voice"} call · ${formatCallDuration(durationSeconds)}`;
  }
  if (outcome === "declined") return `Declined ${kind} call`;
  if (outcome === "cancelled") return `Cancelled ${kind} call`;
  return `Missed ${kind} call`;
};

export interface ParsedCallEntry {
  outcome: CallLogOutcome | "unknown";
  seconds: number | null;
  callType: CallType;
}

/** Parses a call-entry message `content` (inverse of `callLogText`). */
export const parseCallEntry = (content: string | null | undefined): ParsedCallEntry => {
  const text = (content || "").trim();
  const callType: CallType = /video/i.test(text) ? "video" : "audio";
  const duration = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/);
  if (/^(voice|video) call/i.test(text) && duration) {
    const [, h, m, sec] = duration;
    return {
      outcome: "connected",
      seconds: (Number(h || 0) * 60 + Number(m)) * 60 + Number(sec),
      callType,
    };
  }
  if (/^missed/i.test(text)) return { outcome: "missed", seconds: null, callType };
  if (/^declined/i.test(text)) return { outcome: "declined", seconds: null, callType };
  if (/^cancel+ed/i.test(text)) return { outcome: "cancelled", seconds: null, callType };
  return { outcome: "unknown", seconds: null, callType };
};
