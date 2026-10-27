/**
 * Time / number formatting for the chat UI. Pure and Intl-free (Hermes builds without
 * full Intl format the same way), local time zone.
 */

const pad = (n: number) => String(n).padStart(2, "0");

const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;
const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Parses server timestamps. The backend sends naive UTC ISO strings without a zone
 * (`2024-05-01T10:00:00.123456`), which JS would read as LOCAL time: those are treated as
 * UTC. Strings with `Z` / an offset, epoch ms numbers and Dates pass through.
 * Returns null for empty / invalid input.
 */
export const parseTimestamp = (input: string | number | Date | null | undefined): Date | null => {
  if (input === null || input === undefined || input === "") return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let s = String(input).trim();
  const naive = s.match(NAIVE_DATETIME);
  if (naive) {
    // Normalise: "T" separator, at most 3 fraction digits (Hermes rejects microseconds), UTC.
    const frac = naive[3] ? naive[3].slice(0, 4).padEnd(4, "0") : "";
    const time = naive[2].length === 5 ? `${naive[2]}:00` : naive[2];
    s = `${naive[1]}T${time}${frac}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(s) && HAS_ZONE.test(s)) {
    s = s.replace(/(\.\d{3})\d+/, "$1");
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole calendar days between `d` and `now` (0 = today, 1 = yesterday; negative = future). */
export const daysAgo = (d: Date, now: Date): number => Math.round((startOfDay(now) - startOfDay(d)) / 86400000);

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type ClockFormat = "12h" | "24h";

/** "10:04 AM" (12h, default) or "10:04" (24h). */
export const formatClockTime = (d: Date, clock: ClockFormat = "12h"): string => {
  const h = d.getHours();
  const m = pad(d.getMinutes());
  if (clock === "24h") return `${pad(h)}:${m}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
};

/** Message time inside a bubble; "" for unparseable timestamps. */
export const formatMessageTime = (ts: string | number | Date | null | undefined, clock: ClockFormat = "12h"): string => {
  const d = parseTimestamp(ts);
  return d ? formatClockTime(d, clock) : "";
};

/** Conversation-list time: today -> clock, yesterday -> "Yesterday", < 7 days -> "Mon", else "3 Jun" / "3 Jun 2023". */
export const formatListTime = (ts: string | number | Date | null | undefined, now: Date = new Date(), clock: ClockFormat = "12h"): string => {
  const d = parseTimestamp(ts);
  if (!d) return "";
  const days = daysAgo(d, now);
  if (days <= 0) return formatClockTime(d, clock);
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[d.getDay()].slice(0, 3);
  const short = `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return d.getFullYear() === now.getFullYear() ? short : `${short} ${d.getFullYear()}`;
};

/** Date separator chip: "Today", "Yesterday", "Monday" (< 7 days), "3 June", "3 June 2023". */
export const formatDateSeparator = (d: Date, now: Date = new Date()): string => {
  const days = daysAgo(d, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[d.getDay()];
  const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
};

/** Unread badge text: "" for 0, "1".."99", then "99+". */
export const formatUnreadBadge = (count: number | null | undefined): string => {
  const n = Math.floor(Number(count) || 0);
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
};

/** 512 -> "512 B", 1536 -> "1.5 KB", 10485760 -> "10 MB". */
export const formatFileSize = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined) return "";
  const b = Number(bytes);
  if (!Number.isFinite(b) || b < 0) return "";
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
  return `${text} ${units[i]}`;
};

/** Placeholder contents the server stores for attachments: "[Image]", or "[IMAGE] photo.jpg" (backend `[TYPE] file_name`). */
export const isPlaceholder = (s: string): boolean => /^\[[^\]]*\](?:\s+.*)?$/.test(s);
