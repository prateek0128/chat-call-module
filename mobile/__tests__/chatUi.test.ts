/** Pure chat-UI helpers: time formatting, grouping, previews, call entries, composer, attachments, banner. */
import type { ChatMessage, Conversation } from "../src/chat/types";
import {
  dayKey,
  formatClockTime,
  formatDateSeparator,
  formatFileSize,
  formatListTime,
  formatMessageTime,
  formatUnreadBadge,
  parseTimestamp,
} from "../src/chat-ui/format";
import { buildMessageRows, sameGroup } from "../src/chat-ui/grouping";
import { attachmentLabel, conversationPreview, filterConversations, mediaKindOf, messageTicks, presenceLabel } from "../src/chat-ui/preview";
import { describeCallEntry } from "../src/chat-ui/callEntryModel";
import { canSendText, clampComposerHeight, clampComposerLines, composerDisabledReason } from "../src/chat-ui/composerLayout";
import { attachmentName, checkAttachmentSize, isImageAttachment } from "../src/chat-ui/attachments";
import { connectionBannerModel } from "../src/chat-ui/connection";

let seq = 0;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: over.id ?? ++seq,
  chat_id: 1,
  sender_id: over.isMine ? "me" : "bob",
  sender_type: over.isMine ? "user" : "other",
  content: "hi",
  message_type: "text",
  timestamp: "2024-05-01T10:00:00Z",
  is_read: false,
  is_delivered: false,
  isMine: false,
  ...over,
});

/** Local-time ISO string (what the device would show), as a Date. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("parseTimestamp (UTC without Z)", () => {
  it("treats naive server timestamps as UTC", () => {
    expect(parseTimestamp("2024-05-01T10:00:00")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10, 0, 0));
    expect(parseTimestamp("2024-05-01 10:00:00")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10, 0, 0));
    expect(parseTimestamp("2024-05-01T10:00")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10, 0, 0));
  });

  it("keeps microsecond precision parseable (truncates to ms)", () => {
    expect(parseTimestamp("2024-05-01T10:00:00.123456")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10, 0, 0, 123));
    expect(parseTimestamp("2024-05-01T10:00:00.5")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10, 0, 0, 500));
    expect(parseTimestamp("2024-05-01T10:00:00.123456+00:00")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10, 0, 0, 123));
  });

  it("respects explicit zones, epoch numbers and Dates", () => {
    expect(parseTimestamp("2024-05-01T10:00:00Z")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10));
    expect(parseTimestamp("2024-05-01T12:00:00+02:00")!.getTime()).toBe(Date.UTC(2024, 4, 1, 10));
    expect(parseTimestamp(Date.UTC(2024, 4, 1))!.getTime()).toBe(Date.UTC(2024, 4, 1));
    const d = new Date();
    expect(parseTimestamp(d)).toBe(d);
  });

  it("returns null for empty / invalid input", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp("yesterday")).toBeNull();
    expect(formatMessageTime("garbage")).toBe("");
  });
});

describe("time formatting", () => {
  it("clock time 12h / 24h", () => {
    expect(formatClockTime(local(2024, 5, 1, 0, 5))).toBe("12:05 AM");
    expect(formatClockTime(local(2024, 5, 1, 9, 4))).toBe("9:04 AM");
    expect(formatClockTime(local(2024, 5, 1, 12, 0))).toBe("12:00 PM");
    expect(formatClockTime(local(2024, 5, 1, 23, 59))).toBe("11:59 PM");
    expect(formatClockTime(local(2024, 5, 1, 9, 4), "24h")).toBe("09:04");
  });

  it("list time: today, yesterday, weekday, date", () => {
    const now = local(2024, 5, 10, 15, 0); // Friday
    expect(formatListTime(local(2024, 5, 10, 9, 30), now)).toBe("9:30 AM");
    expect(formatListTime(local(2024, 5, 9, 23, 0), now)).toBe("Yesterday");
    expect(formatListTime(local(2024, 5, 6, 8, 0), now)).toBe("Mon");
    expect(formatListTime(local(2024, 5, 3, 8, 0), now)).toBe("3 May");
    expect(formatListTime(local(2023, 12, 31, 8, 0), now)).toBe("31 Dec 2023");
    expect(formatListTime(null, now)).toBe("");
  });

  it("date separators", () => {
    const now = local(2024, 5, 10, 15, 0);
    expect(formatDateSeparator(local(2024, 5, 10, 1), now)).toBe("Today");
    expect(formatDateSeparator(local(2024, 5, 9, 23), now)).toBe("Yesterday");
    expect(formatDateSeparator(local(2024, 5, 7), now)).toBe("Tuesday");
    expect(formatDateSeparator(local(2024, 4, 1), now)).toBe("1 April");
    expect(formatDateSeparator(local(2022, 1, 2), now)).toBe("2 January 2022");
  });

  it("unread badge", () => {
    expect(formatUnreadBadge(0)).toBe("");
    expect(formatUnreadBadge(-3)).toBe("");
    expect(formatUnreadBadge(undefined)).toBe("");
    expect(formatUnreadBadge(1)).toBe("1");
    expect(formatUnreadBadge(99)).toBe("99");
    expect(formatUnreadBadge(100)).toBe("99+");
    expect(formatUnreadBadge(4321)).toBe("99+");
  });

  it("file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatFileSize(12.34 * 1024 * 1024)).toBe("12 MB");
    expect(formatFileSize(null)).toBe("");
  });
});

describe("message grouping + date separators", () => {
  const at = (d: Date) => d.toISOString();

  it("groups same sender within 5 minutes; newest first in, newest first out", () => {
    const a = msg({ id: 1, timestamp: at(local(2024, 5, 10, 10, 0)) });
    const b = msg({ id: 2, timestamp: at(local(2024, 5, 10, 10, 4)) });
    const c = msg({ id: 3, timestamp: at(local(2024, 5, 10, 10, 10)) }); // > 5 min after b
    const d = msg({ id: 4, isMine: true, timestamp: at(local(2024, 5, 10, 10, 11)) });
    const rows = buildMessageRows([d, c, b, a], local(2024, 5, 10, 12));
    expect(rows.map((r) => r.key)).toEqual(["m:4", "m:3", "m:2", "m:1", `d:${dayKey(local(2024, 5, 10))}`]);
    const byId = Object.fromEntries(rows.filter((r) => r.kind === "message").map((r: any) => [r.message.id, r]));
    expect(byId[1]).toMatchObject({ groupStart: true, groupEnd: false });
    expect(byId[2]).toMatchObject({ groupStart: false, groupEnd: true });
    expect(byId[3]).toMatchObject({ groupStart: true, groupEnd: true });
    expect(byId[4]).toMatchObject({ groupStart: true, groupEnd: true });
    expect(rows[rows.length - 1]).toMatchObject({ kind: "date", label: "Today" });
  });

  it("places a separator above the first message of each day (after it in an inverted list)", () => {
    const y1 = msg({ id: 1, timestamp: at(local(2024, 5, 9, 23, 58)) });
    const t1 = msg({ id: 2, timestamp: at(local(2024, 5, 10, 0, 1)) }); // 3 min later but a new day
    const rows = buildMessageRows([t1, y1], local(2024, 5, 10, 12));
    expect(rows.map((r) => (r.kind === "date" ? r.label : r.key))).toEqual(["m:2", "Today", "m:1", "Yesterday"]);
    expect((rows[0] as any).groupStart).toBe(true);
  });

  it("never groups call entries and handles naive UTC timestamps", () => {
    const a = msg({ id: 1, timestamp: "2024-05-10T10:00:00" });
    const call = msg({ id: "call_x", message_type: "call", content: "Voice call · 00:10", timestamp: "2024-05-10T10:01:00" });
    const b = msg({ id: 2, timestamp: "2024-05-10T10:02:00" });
    expect(sameGroup(a, call)).toBe(false);
    const rows = buildMessageRows([b, call, a]).filter((r) => r.kind === "message") as any[];
    expect(rows.every((r) => r.groupStart && r.groupEnd)).toBe(true);
  });

  it("splits groups between different incoming senders", () => {
    const a = msg({ sender_id: "x", timestamp: "2024-05-10T10:00:00Z" });
    const b = msg({ sender_id: "y", timestamp: "2024-05-10T10:00:30Z" });
    expect(sameGroup(a, b)).toBe(false);
    expect(sameGroup(a, { ...b, sender_id: "x" })).toBe(true);
  });

  it("empty input gives no rows", () => {
    expect(buildMessageRows([])).toEqual([]);
  });
});

describe("conversation preview text", () => {
  const conv = (last: Partial<ChatMessage> | null): Pick<Conversation, "last_message"> => ({ last_message: last ? msg(last) : null });

  it("typing wins, in accent", () => {
    expect(conversationPreview(conv({ content: "x" }), true)).toMatchObject({ kind: "typing", text: "typing…", accent: true });
  });

  it("own messages get 'You: ' and ticks", () => {
    expect(conversationPreview(conv({ isMine: true, content: "hello", is_delivered: true }))).toMatchObject({
      kind: "text",
      prefix: "You: ",
      text: "hello",
      ticks: "delivered",
    });
    expect(conversationPreview(conv({ isMine: false, content: "  multi\nline  " }))).toMatchObject({ prefix: "", text: "multi line", ticks: null });
  });

  it("attachments", () => {
    expect(conversationPreview(conv({ message_type: "image", content: "" })).text).toBe("📷 Photo");
    expect(conversationPreview(conv({ message_type: "document", file_name: "report.pdf", content: "report.pdf" })).text).toBe("📎 report.pdf");
    expect(conversationPreview(conv({ message_type: "image", content: "look!" })).text).toBe("📷 Photo look!");
  });

  it("call entries: red when missed or declined", () => {
    expect(conversationPreview(conv({ message_type: "call", content: "Missed voice call" }))).toMatchObject({ kind: "call", text: "Missed voice call", danger: true });
    // Side-aware: the caller sees a neutral "No answer" / "Declined".
    expect(conversationPreview(conv({ message_type: "call", content: "Declined voice call", isMine: true }))).toMatchObject({ danger: false, prefix: "", text: "Voice call · Declined" });
    expect(conversationPreview(conv({ message_type: "call", content: "Voice call · 05:42" }))).toMatchObject({ text: "Voice call · 5 min 42 sec", danger: false });
  });

  it("empty conversation", () => {
    expect(conversationPreview(conv(null))).toMatchObject({ kind: "empty", text: "" });
  });

  it("ticks", () => {
    expect(messageTicks(msg({ isMine: false }))).toBeNull();
    expect(messageTicks(msg({ isMine: true, id: "temp_1" }))).toBe("pending");
    expect(messageTicks(msg({ isMine: true, pending: true }))).toBe("pending");
    expect(messageTicks(msg({ isMine: true }))).toBe("sent");
    expect(messageTicks(msg({ isMine: true, is_delivered: true }))).toBe("delivered");
    expect(messageTicks(msg({ isMine: true, is_delivered: true, is_read: true }))).toBe("read");
    expect(messageTicks(msg({ isMine: true, message_type: "call" }))).toBeNull();
  });

  it("media kinds and labels", () => {
    expect(mediaKindOf({ message_type: "text" })).toBeNull();
    expect(mediaKindOf({ message_type: "document", file_type: "image/png" })).toBe("image");
    expect(mediaKindOf({ message_type: "voice" })).toBe("audio");
    expect(mediaKindOf({ message_type: "video" })).toBe("video");
    expect(attachmentLabel({ message_type: "document" })).toBe("📎 File");
  });

  it("presence label", () => {
    expect(presenceLabel(true, "offline")).toEqual({ text: "typing…", tone: "accent" });
    expect(presenceLabel(false, "online")).toEqual({ text: "online", tone: "online" });
    expect(presenceLabel(false, "away")).toEqual({ text: "offline", tone: "muted" });
  });

  it("search filters by name, case and accent insensitive", () => {
    const list = [
      { user_id: "1", username: "Zoë Adams" },
      { user_id: "2", username: "bob" },
      { user_id: "3", username: null },
    ];
    expect(filterConversations(list, "zoe").map((c) => c.user_id)).toEqual(["1"]);
    expect(filterConversations(list, "BO").map((c) => c.user_id)).toEqual(["2"]);
    expect(filterConversations(list, "  ")).toBe(list);
    expect(filterConversations(list, "nobody")).toEqual([]);
  });
});

describe("call entries", () => {
  it("connected call shows the duration", () => {
    expect(describeCallEntry({ id: 9, content: "Voice call · 05:42", isMine: true })).toMatchObject({
      title: "Voice call",
      detail: "5 min 42 sec",
      direction: "outgoing",
      danger: false,
      icon: "callOutgoing",
      canCallBack: true,
    });
  });

  it("missed / declined / cancelled", () => {
    expect(describeCallEntry({ id: 1, content: "Missed voice call", isMine: false })).toMatchObject({
      title: "Missed voice call",
      detail: "Tap to call back",
      danger: true,
      icon: "callMissed",
    });
    expect(describeCallEntry({ id: 1, content: "Declined video call", isMine: true })).toMatchObject({ title: "Video call", detail: "Declined", callType: "video", danger: false });
    expect(describeCallEntry({ id: 1, content: "Cancelled voice call", isMine: true })).toMatchObject({ title: "Cancelled voice call", danger: false, detail: "Outgoing" });
  });

  it("live call_<id> entries", () => {
    expect(describeCallEntry({ id: "call_abc", content: "[Call Initiated]", isMine: true })).toMatchObject({
      live: true,
      title: "Voice call",
      detail: "Calling…",
      canCallBack: false,
    });
    expect(describeCallEntry({ id: "call_abc", content: "[Call Initiated]", isMine: false, call_type: "video" })).toMatchObject({
      title: "Video call",
      detail: "Incoming",
    });
  });

  it("accessibility label reads as a sentence", () => {
    expect(describeCallEntry({ id: 1, content: "Missed voice call", isMine: false }).accessibilityLabel).toBe("Missed voice call, Tap to call back");
  });
});

describe("composer", () => {
  const m = { lineHeight: 21, maxLines: 6, paddingVertical: 8 };
  it("clamps auto-grow between 1 and maxLines", () => {
    expect(clampComposerHeight(0, m)).toEqual({ lines: 1, height: 37, scrollEnabled: false });
    expect(clampComposerHeight(21 + 16, m)).toEqual({ lines: 1, height: 37, scrollEnabled: false });
    expect(clampComposerHeight(3 * 21 + 16, m)).toEqual({ lines: 3, height: 79, scrollEnabled: false });
    expect(clampComposerHeight(6 * 21 + 16, m)).toEqual({ lines: 6, height: 142, scrollEnabled: false });
    expect(clampComposerHeight(9 * 21 + 16, m)).toEqual({ lines: 6, height: 142, scrollEnabled: true });
  });

  it("line count from text", () => {
    expect(clampComposerLines("", 6)).toBe(1);
    expect(clampComposerLines("a\nb\nc", 6)).toBe(3);
    expect(clampComposerLines("1\n2\n3\n4\n5\n6\n7\n8", 6)).toBe(6);
  });

  it("send enabled only with text", () => {
    expect(canSendText("")).toBe(false);
    expect(canSendText("   \n ")).toBe(false);
    expect(canSendText("hi")).toBe(true);
    expect(canSendText("hi", true)).toBe(false);
  });

  it("disabled reason", () => {
    expect(composerDisabledReason({})).toBeNull();
    expect(composerDisabledReason({ isBlocked: true })).toBe("You blocked this contact");
    expect(composerDisabledReason({ blockedByOther: true })).toBe("You can't reply to this conversation");
    expect(composerDisabledReason({ isBlocked: true, hostReason: "Chat is not enabled" })).toBe("Chat is not enabled");
  });
});

describe("attachments", () => {
  it("checks the 10 MB limit before upload", () => {
    expect(checkAttachmentSize(1024)).toEqual({ ok: true });
    expect(checkAttachmentSize(10 * 1024 * 1024)).toEqual({ ok: true });
    const big = checkAttachmentSize(10 * 1024 * 1024 + 1);
    expect(big.ok).toBe(false);
    expect(!big.ok && big.reason).toBe("too_large");
    expect(!big.ok && big.message).toBe("File is too large (10 MB). The limit is 10 MB.");
    expect(checkAttachmentSize(0)).toMatchObject({ ok: false, reason: "empty" });
    expect(checkAttachmentSize(undefined)).toEqual({ ok: true });
    expect(checkAttachmentSize(3000, 2000)).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("detects images and names", () => {
    expect(isImageAttachment({ type: "image/jpeg" })).toBe(true);
    expect(isImageAttachment({ type: "image" })).toBe(true);
    expect(isImageAttachment({ type: "application/pdf", name: "x.png" })).toBe(false);
    expect(isImageAttachment({ name: "photo.HEIC" })).toBe(true);
    expect(attachmentName({ uri: "file:///tmp/My%20File.pdf?x=1" })).toBe("My File.pdf");
    expect(attachmentName({ name: "a.txt", uri: "file:///b" })).toBe("a.txt");
  });
});

describe("connection banner", () => {
  it("hidden when open / idle / logged out", () => {
    expect(connectionBannerModel({ status: "open", attempt: 0 }).visible).toBe(false);
    expect(connectionBannerModel({ status: "idle", attempt: 0 }).visible).toBe(false);
    expect(connectionBannerModel({ status: "unauthenticated", attempt: 0 }).visible).toBe(false);
  });

  it("Connecting… while retries are young", () => {
    expect(connectionBannerModel({ status: "connecting", attempt: 0 })).toMatchObject({ visible: true, tone: "warning", text: "Connecting…", showRetry: false });
    expect(connectionBannerModel({ status: "reconnecting", attempt: 2 })).toMatchObject({ text: "Connecting…" });
  });

  it("Offline. Retrying in Ns with a countdown after 3 attempts", () => {
    // attempt 3 was scheduled with backoffDelay(2) = 4000 ms
    expect(connectionBannerModel({ status: "reconnecting", attempt: 3 }, 0)).toMatchObject({ tone: "danger", text: "Offline. Retrying in 4s", showRetry: true, retryInSeconds: 4 });
    expect(connectionBannerModel({ status: "reconnecting", attempt: 3 }, 2500).text).toBe("Offline. Retrying in 2s");
    expect(connectionBannerModel({ status: "reconnecting", attempt: 3 }, 9000).text).toBe("Offline. Retrying…");
    expect(connectionBannerModel({ status: "reconnecting", attempt: 10 }, 0).text).toBe("Offline. Retrying in 30s");
  });
});
