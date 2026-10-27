/**
 * Message list rows: grouping (same sender within 5 min) and date separators. Pure.
 * Input and output are NEWEST FIRST, ready for an inverted FlatList: a date separator is
 * placed right after (= visually above) the oldest message of its day.
 */
import type { ChatMessage } from "../chat/types";
import { dayKey, formatDateSeparator, parseTimestamp } from "./format";

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type MessageListRow =
  | {
      kind: "message";
      key: string;
      message: ChatMessage;
      /** First (oldest) bubble of its group: gets the tail and the larger top margin. */
      groupStart: boolean;
      /** Last (newest) bubble of its group. */
      groupEnd: boolean;
    }
  | { kind: "date"; key: string; label: string; day: string };

type GroupableMessage = Pick<ChatMessage, "id" | "sender_id" | "isMine" | "timestamp" | "message_type">;

const isCall = (m: GroupableMessage) => m.message_type === "call";

/** Do `a` (older) and `b` (newer) belong to the same group? */
export const sameGroup = (a: GroupableMessage, b: GroupableMessage, windowMs: number = GROUP_WINDOW_MS): boolean => {
  if (isCall(a) || isCall(b)) return false; // call entries are centred chips, never grouped
  if (a.isMine !== b.isMine) return false;
  if (!a.isMine && String(a.sender_id) !== String(b.sender_id)) return false;
  const ta = parseTimestamp(a.timestamp);
  const tb = parseTimestamp(b.timestamp);
  if (!ta || !tb) return true; // unknown time: keep the run together
  if (dayKey(ta) !== dayKey(tb)) return false;
  return Math.abs(tb.getTime() - ta.getTime()) <= windowMs;
};

export const messageKey = (m: Pick<ChatMessage, "id">): string => `m:${String(m.id)}`;

/** Builds the inverted-list rows for `messages` (newest first). */
export const buildMessageRows = (messages: ChatMessage[], now: Date = new Date(), windowMs: number = GROUP_WINDOW_MS): MessageListRow[] => {
  const chron = messages.slice().reverse();
  const rows: MessageListRow[] = [];
  let lastDay: string | null = null;
  for (let i = 0; i < chron.length; i++) {
    const m = chron[i];
    const prev = i > 0 ? chron[i - 1] : null;
    const next = i < chron.length - 1 ? chron[i + 1] : null;
    const d = parseTimestamp(m.timestamp);
    const day: string | null = d ? dayKey(d) : lastDay;
    if (d && day !== lastDay) {
      rows.push({ kind: "date", key: `d:${day}`, label: formatDateSeparator(d, now), day: day as string });
    }
    const newDay = !!d && day !== lastDay;
    lastDay = day;
    rows.push({
      kind: "message",
      key: messageKey(m),
      message: m,
      groupStart: !prev || newDay || !sameGroup(prev, m, windowMs),
      groupEnd: !next || !sameGroup(m, next, windowMs),
    });
  }
  return rows.reverse();
};
