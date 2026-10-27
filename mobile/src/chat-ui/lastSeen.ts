/** Chat header subtitle: last seen wording + status priority. Pure. */
import { daysAgo, formatClockTime, MONTHS, parseTimestamp, type ClockFormat } from "./format";

/**
 * "last seen just now" (< 1 min, or a clock-skewed future time), "last seen 5 min ago" (< 60 min),
 * "last seen today at 6:02 PM", "last seen yesterday at 6:02 PM", "last seen 13 Sep at 6:02 PM"
 * ("13 Sep 2025 at …" for another year). Naive server timestamps (no zone) are UTC.
 * Returns null when `lastSeen` is missing or unparseable.
 */
export const formatLastSeen = (
  lastSeen: string | number | Date | null | undefined,
  now: Date = new Date(),
  clock: ClockFormat = "12h",
): string | null => {
  const d = parseTimestamp(lastSeen);
  if (!d) return null;
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "last seen just now";
  if (diffMin < 60) return `last seen ${diffMin} min ago`;
  const time = formatClockTime(d, clock);
  const days = daysAgo(d, now);
  if (days <= 0) return `last seen today at ${time}`;
  if (days === 1) return `last seen yesterday at ${time}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return d.getFullYear() === now.getFullYear() ? `last seen ${date} at ${time}` : `last seen ${date} ${d.getFullYear()} at ${time}`;
};

export type HeaderStatusKind = "blocked_by_other" | "blocked" | "typing" | "online" | "last_seen" | "offline";

export interface HeaderStatusInput {
  typing?: boolean;
  status?: string | null;
  lastSeen?: string | number | Date | null;
  /** I blocked them. */
  isBlocked?: boolean;
  /** They blocked me. */
  blockedByOther?: boolean;
  now?: Date;
  clock?: ClockFormat;
}

export interface HeaderStatus {
  kind: HeaderStatusKind;
  text: string;
  tone: "accent" | "online" | "muted" | "danger";
  /** Presence dot on the avatar (never while blocked either way). */
  showOnlineDot: boolean;
  /** Call action allowed (hidden when blocked either way). */
  canCall: boolean;
}

/**
 * Priority: "You are blocked" > "Blocked" > "typing…" > "online" > "last seen …" > "offline".
 * Blocked either way hides presence (online dot, typing, last seen) and the call action.
 */
export const headerStatus = (i: HeaderStatusInput): HeaderStatus => {
  if (i.blockedByOther) return { kind: "blocked_by_other", text: "You are blocked", tone: "muted", showOnlineDot: false, canCall: false };
  if (i.isBlocked) return { kind: "blocked", text: "Blocked", tone: "muted", showOnlineDot: false, canCall: false };
  const online = i.status === "online";
  if (i.typing) return { kind: "typing", text: "typing…", tone: "accent", showOnlineDot: online, canCall: true };
  if (online) return { kind: "online", text: "online", tone: "online", showOnlineDot: true, canCall: true };
  const seen = formatLastSeen(i.lastSeen, i.now, i.clock);
  if (seen) return { kind: "last_seen", text: seen, tone: "muted", showOnlineDot: false, canCall: true };
  return { kind: "offline", text: "offline", tone: "muted", showOnlineDot: false, canCall: true };
};
