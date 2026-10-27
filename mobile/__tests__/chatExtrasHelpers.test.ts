/** Pure helpers for the chat extras: last seen, status priority, filters, search, badges, call wording, sticky label, delete actions. */
import type { ChatMessage, Conversation } from "../src/chat/types";
import { describeCallEntry } from "../src/chat-ui/callEntryModel";
import {
  applyConversationFilter,
  blockedRowLabel,
  conversationEmptyState,
  conversationFilters,
  filterChipModels,
  type ConversationFilter,
} from "../src/chat-ui/conversationFilters";
import { documentBadge, documentMeta } from "../src/chat-ui/documentBadge";
import { buildMessageRows } from "../src/chat-ui/grouping";
import { formatLastSeen, headerStatus } from "../src/chat-ui/lastSeen";
import { canDeleteForEveryone, canDeleteForMe, messageActionList, rateLimitText } from "../src/chat-ui/messageActions";
import { createMessageSoundPlayer, shouldPlayMessageSound } from "../src/chat-ui/messageSound";
import { createExpoPickers, fromDocumentPickerResult, fromImagePickerResult } from "../src/chat-ui/pickers";
import { conversationPreview, filterConversations, presenceLabel } from "../src/chat-ui/preview";
import { createStickyLabelController, stickyDateLabel, stickyFadeDuration, STICKY_LABEL_HIDE_MS } from "../src/chat-ui/stickyDate";
import { createSharedTicker } from "../src/chat-ui/ticker";

const NOW = new Date(2026, 8, 20, 18, 30, 0); // 20 Sep 2026, 6:30 PM local
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60000;

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 5,
  chat_id: 1,
  sender_id: "me",
  sender_type: "user",
  content: "hello",
  message_type: "text",
  timestamp: new Date().toISOString(),
  is_read: false,
  is_delivered: true,
  isMine: true,
  ...over,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  user_id: "1",
  username: "Asha",
  unread_count: 0,
  last_message: null,
  chat_id: 1,
  ...over,
});

describe("formatLastSeen", () => {
  it("relative wording with minute boundaries", () => {
    expect(formatLastSeen(ago(0), NOW)).toBe("last seen just now");
    expect(formatLastSeen(ago(59 * 1000), NOW)).toBe("last seen just now");
    expect(formatLastSeen(ago(MIN), NOW)).toBe("last seen 1 min ago");
    expect(formatLastSeen(ago(59 * MIN + 59000), NOW)).toBe("last seen 59 min ago");
    expect(formatLastSeen(ago(60 * MIN), NOW)).toBe("last seen today at 5:30 PM");
    expect(formatLastSeen(ago(-5 * MIN), NOW)).toBe("last seen just now"); // clock skew
  });

  it("today / yesterday / date, 12h and 24h", () => {
    expect(formatLastSeen(new Date(2026, 8, 20, 0, 5), NOW)).toBe("last seen today at 12:05 AM");
    expect(formatLastSeen(new Date(2026, 8, 19, 23, 59), NOW)).toBe("last seen yesterday at 11:59 PM");
    expect(formatLastSeen(new Date(2026, 8, 19, 18, 2), NOW, "24h")).toBe("last seen yesterday at 18:02");
    expect(formatLastSeen(new Date(2026, 8, 13, 18, 2), NOW)).toBe("last seen 13 Sep at 6:02 PM");
    expect(formatLastSeen(new Date(2025, 11, 31, 9, 0), NOW)).toBe("last seen 31 Dec 2025 at 9:00 AM");
  });

  it("parses naive UTC timestamps (no Z) as UTC; invalid -> null", () => {
    const utc = new Date(Date.UTC(2026, 8, 18, 12, 0, 0));
    expect(formatLastSeen("2026-09-18T12:00:00", NOW)).toBe(formatLastSeen(utc, NOW));
    expect(formatLastSeen("2026-09-18 12:00:00.123456", NOW)).toBe(formatLastSeen(utc, NOW));
    expect(formatLastSeen(null, NOW)).toBeNull();
    expect(formatLastSeen("nope", NOW)).toBeNull();
  });
});

describe("headerStatus priority", () => {
  const base = { now: NOW, lastSeen: ago(5 * MIN) };
  it("You are blocked > Blocked > typing > online > last seen > offline", () => {
    expect(headerStatus({ ...base, blockedByOther: true, isBlocked: true, typing: true, status: "online" })).toMatchObject({ text: "You are blocked", showOnlineDot: false, canCall: false });
    expect(headerStatus({ ...base, isBlocked: true, typing: true, status: "online" })).toMatchObject({ text: "Blocked", showOnlineDot: false, canCall: false });
    expect(headerStatus({ ...base, typing: true, status: "online" })).toMatchObject({ text: "typing…", tone: "accent", canCall: true });
    expect(headerStatus({ ...base, status: "online" })).toMatchObject({ text: "online", showOnlineDot: true });
    expect(headerStatus({ ...base, status: "offline" })).toMatchObject({ kind: "last_seen", text: "last seen 5 min ago", showOnlineDot: false });
    expect(headerStatus({ now: NOW, status: "offline" })).toMatchObject({ text: "offline" });
  });

  it("presenceLabel keeps its two-argument behaviour", () => {
    expect(presenceLabel(false, "away")).toEqual({ text: "offline", tone: "muted" });
    expect(presenceLabel(false, "offline", { lastSeen: ago(2 * MIN), now: NOW })).toEqual({ text: "last seen 2 min ago", tone: "muted" });
    expect(presenceLabel(true, "online", { blockedByOther: true })).toEqual({ text: "You are blocked", tone: "muted" });
  });
});

describe("shared ticker", () => {
  it("one interval for all subscribers, stopped with the last", () => {
    const handles: Array<() => void> = [];
    let cleared = 0;
    const t = createSharedTicker(60000, { setInterval: (fn) => (handles.push(fn), handles.length), clearInterval: () => cleared++ });
    let a = 0;
    let b = 0;
    const offA = t.subscribe(() => a++);
    const offB = t.subscribe(() => b++);
    expect(handles).toHaveLength(1);
    handles[0]();
    expect([a, b, t.getTick()]).toEqual([1, 1, 1]);
    offA();
    expect(cleared).toBe(0);
    offB();
    expect(cleared).toBe(1);
    expect(t.size).toBe(0);
  });
});

describe("conversation filters", () => {
  const list = [conv({ user_id: "1", unread_count: 2 }), conv({ user_id: "2" }), conv({ user_id: "3", unread_count: 1 })];

  it("All / Unread N chips (+ host filters, same key replaces)", () => {
    const fav: ConversationFilter = { key: "fav", label: "Favourites", predicate: (c) => c.user_id === "2" };
    const filters = conversationFilters([fav]);
    expect(filters.map((f) => f.key)).toEqual(["all", "unread", "fav"]);
    expect(filterChipModels(list, filters, "unread").map((c) => [c.label, c.selected])).toEqual([
      ["All", false],
      ["Unread 2", true],
      ["Favourites", false],
    ]);
    expect(filterChipModels([conv()], filters, "all")[1].label).toBe("Unread");
    expect(conversationFilters([{ key: "unread", label: "New", predicate: () => true }]).map((f) => f.label)).toEqual(["All", "New"]);
  });

  it("applies the selected filter", () => {
    const filters = conversationFilters();
    expect(applyConversationFilter(list, filters, "unread").map((c) => c.user_id)).toEqual(["1", "3"]);
    expect(applyConversationFilter(list, filters, "all")).toBe(list);
    expect(applyConversationFilter(list, filters, "missing")).toBe(list);
  });

  it("filter-aware empty states", () => {
    const filters = conversationFilters();
    expect(conversationEmptyState({ filter: filters[1] })).toEqual({ title: "No unread chats", text: "You're all caught up" });
    expect(conversationEmptyState({ filter: filters[0] }).title).toBe("No chats yet");
    expect(conversationEmptyState({ query: "zz", filter: filters[1] }).title).toBe("No chats match");
    expect(conversationEmptyState({ filter: { key: "x", label: "Matches", predicate: () => true } }).title).toBe("No matches chats");
  });

  it("blocked row labels", () => {
    expect(blockedRowLabel({ is_blocked: true }, "Asha")).toBe("You blocked this contact");
    expect(blockedRowLabel({ blocked_by_other: true }, "Asha")).toBe("Blocked by Asha");
    expect(blockedRowLabel({}, "Asha")).toBeNull();
  });
});

describe("search over last message text", () => {
  it("matches name or last-message text, accent-insensitive; not calls / deleted", () => {
    const list = [
      conv({ user_id: "1", username: "Bob", last_message: msg({ content: "See you at the Café" }) }),
      conv({ user_id: "2", username: "Zoë", last_message: msg({ content: "", message_type: "document", file_name: "Résumé.pdf" }) }),
      conv({ user_id: "3", username: "Cy", last_message: msg({ message_type: "call", content: "Missed voice call" }) }),
      conv({ user_id: "4", username: "Di", last_message: msg({ message_type: "deleted", content: "" }) }),
    ];
    expect(filterConversations(list, "cafe").map((c) => c.user_id)).toEqual(["1"]);
    expect(filterConversations(list, "resume").map((c) => c.user_id)).toEqual(["2"]);
    expect(filterConversations(list, "zoe").map((c) => c.user_id)).toEqual(["2"]);
    expect(filterConversations(list, "missed")).toEqual([]);
  });
});

describe("previews for deleted / system messages", () => {
  it("deleted is italic placeholder, system has no prefix", () => {
    expect(conversationPreview(conv({ last_message: msg({ message_type: "deleted", isMine: false }) }))).toMatchObject({ kind: "deleted", text: "This message was deleted", italic: true });
    expect(conversationPreview(conv({ last_message: msg({ message_type: "deleted" }) })).text).toBe("You deleted this message");
    expect(conversationPreview(conv({ last_message: msg({ message_type: "system", sender_type: "system", isMine: false, content: "You matched" }) }))).toMatchObject({ kind: "system", prefix: "", text: "You matched" });
  });
});

describe("documentBadge", () => {
  it("maps extensions and MIME types", () => {
    expect(documentBadge("a.pdf")).toEqual({ label: "PDF", colorToken: "danger" });
    expect(documentBadge("a.DOCX")).toEqual({ label: "DOC", colorToken: "accent" });
    expect(documentBadge("a.xlsx").label).toBe("XLS");
    expect(documentBadge("a.pptx").label).toBe("PPT");
    expect(documentBadge("a.rar").label).toBe("ZIP");
    expect(documentBadge("notes.txt").label).toBe("TXT");
    expect(documentBadge("data.json")).toEqual({ label: "JSON", colorToken: "textMuted" });
    expect(documentBadge("download", "application/pdf").label).toBe("PDF");
    expect(documentBadge(null, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").label).toBe("XLS");
    expect(documentBadge(null, null)).toEqual({ label: "FILE", colorToken: "textMuted" });
  });

  it("meta line", () => {
    expect(documentMeta("a.pdf", null, 1.2 * 1024 * 1024)).toBe("PDF · 1.2 MB");
    expect(documentMeta("a.pdf", null, null)).toBe("PDF");
  });
});

describe("side-aware call entries", () => {
  it("caller sees neutral No answer / Declined", () => {
    expect(describeCallEntry({ id: 1, content: "Missed voice call", isMine: true })).toMatchObject({ title: "Voice call", detail: "No answer", danger: false });
    expect(describeCallEntry({ id: 1, content: "Declined voice call", isMine: true })).toMatchObject({ title: "Voice call", detail: "Declined", danger: false });
  });
  it("callee sees red Missed voice call + Tap to call back", () => {
    expect(describeCallEntry({ id: 1, content: "Missed voice call", isMine: false })).toMatchObject({ title: "Missed voice call", detail: "Tap to call back", danger: true, icon: "callMissed" });
    expect(describeCallEntry({ id: 1, content: "Declined video call", isMine: false })).toMatchObject({ title: "Declined video call", danger: true });
    expect(conversationPreview(conv({ last_message: msg({ message_type: "call", content: "Missed voice call", isMine: true }) })).text).toBe("Voice call · No answer");
  });
});

describe("sticky date label", () => {
  it("label of the oldest visible row (inverted rows)", () => {
    const now = new Date(2026, 8, 20, 12, 0);
    const rows = buildMessageRows(
      [
        msg({ id: 3, timestamp: new Date(2026, 8, 20, 11, 0).toISOString() }),
        msg({ id: 2, timestamp: new Date(2026, 8, 19, 11, 0).toISOString() }),
        msg({ id: 1, timestamp: new Date(2026, 8, 19, 10, 0).toISOString() }),
      ],
      now,
    );
    // rows: m3, Today, m2, m1, Yesterday
    expect(stickyDateLabel(rows, 0)).toBe("Today");
    expect(stickyDateLabel(rows, 2)).toBe("Yesterday");
    expect(stickyDateLabel(rows, 99)).toBe("Yesterday");
    expect(stickyDateLabel([], 0)).toBeNull();
  });

  it("shows on scroll, hides 1.5 s after the last scroll", () => {
    jest.useFakeTimers();
    const seen: boolean[] = [];
    const c = createStickyLabelController((v) => seen.push(v));
    c.onScroll();
    jest.advanceTimersByTime(STICKY_LABEL_HIDE_MS - 1);
    c.onScroll(); // restarts the timer
    jest.advanceTimersByTime(STICKY_LABEL_HIDE_MS - 1);
    expect(c.visible).toBe(true);
    jest.advanceTimersByTime(1);
    expect(c.visible).toBe(false);
    expect(seen).toEqual([true, false]);
    c.dispose();
    jest.useRealTimers();
  });

  it("reduced motion -> instant", () => {
    expect(stickyFadeDuration(true, 200)).toBe(0);
    expect(stickyFadeDuration(false, 200)).toBe(200);
  });
});

describe("delete / unsend availability", () => {
  const now = Date.now();
  it("delete for everyone: own confirmed message within the window", () => {
    const at = (secsAgo: number) => new Date(now - secsAgo * 1000).toISOString();
    expect(canDeleteForEveryone(msg({ timestamp: at(10) }), 3600, now)).toBe(true);
    expect(canDeleteForEveryone(msg({ timestamp: at(3601) }), 3600, now)).toBe(false);
    expect(canDeleteForEveryone(msg({ timestamp: at(99999) }), 0, now)).toBe(true);
    expect(canDeleteForEveryone(msg({ timestamp: at(1) }), -1, now)).toBe(false);
    expect(canDeleteForEveryone(msg({ isMine: false, timestamp: at(1) }), 3600, now)).toBe(false);
    expect(canDeleteForEveryone(msg({ id: "temp_1", timestamp: at(1) }), 3600, now)).toBe(false);
    expect(canDeleteForEveryone(msg({ message_type: "deleted", timestamp: at(1) }), 3600, now)).toBe(false);
    expect(canDeleteForEveryone(msg({ message_type: "call", timestamp: at(1) }), 3600, now)).toBe(false);
  });

  it("menu: delete for me + for everyone; deleted / failed / system variants", () => {
    const keys = (m: ChatMessage, extra = {}) => messageActionList(m, { reply: true, deleteForMe: true, deleteForEveryone: true, retry: true, now, ...extra }).map((a) => a.key);
    expect(keys(msg({ timestamp: new Date(now - 1000).toISOString() }))).toEqual(["reply", "deleteForMe", "deleteForEveryone"]);
    expect(keys(msg({ isMine: false, timestamp: new Date(now - 1000).toISOString() }))).toEqual(["reply", "deleteForMe"]);
    expect(keys(msg({ timestamp: new Date(now - 1000).toISOString() }), { unsendWindowSeconds: -1 })).toEqual(["reply", "deleteForMe"]);
    expect(keys(msg({ message_type: "deleted" }))).toEqual(["deleteForMe"]);
    expect(keys(msg({ id: "temp_1", failed: true }))).toEqual(["retry", "deleteForMe"]);
    expect(keys(msg({ message_type: "system", sender_type: "system", isMine: false }))).toEqual([]);
    expect(canDeleteForMe(msg({ id: "temp_1", pending: true }))).toBe(false);
  });

  it("rate limit text", () => {
    expect(rateLimitText(7)).toBe("You're sending messages too fast. Try again in 7 s");
    expect(rateLimitText(2.2)).toBe("You're sending messages too fast. Try again in 3 s");
    expect(rateLimitText(null)).toBe("You're sending messages too fast. Try again in a moment");
  });
});

describe("pickers + message sound", () => {
  it("normalises picker results", () => {
    expect(fromImagePickerResult({ canceled: true }, "image")).toBeNull();
    expect(fromImagePickerResult({ canceled: false, assets: [{ uri: "file:///a/IMG_1.jpg", mimeType: "image/jpeg", fileSize: 10, type: "image" }] }, "image")).toEqual({
      uri: "file:///a/IMG_1.jpg",
      name: "IMG_1.jpg",
      type: "image/jpeg",
      size: 10,
    });
    expect(fromDocumentPickerResult({ type: "success", uri: "file:///d/r.pdf", name: "r.pdf", size: 5 })).toMatchObject({ name: "r.pdf", type: "application/octet-stream", size: 5 });
    expect(fromDocumentPickerResult({ canceled: false, assets: [{ uri: "file:///d/x.pdf", name: "x.pdf", mimeType: "application/pdf" }] })).toMatchObject({ type: "application/pdf", size: -1 });
  });

  it("createExpoPickers lists only items whose module exists", async () => {
    expect(createExpoPickers({ modules: { imagePicker: null, documentPicker: null } })).toEqual([]);
    const dp = { getDocumentAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: "file:///x.pdf", name: "x.pdf" }] })) };
    const ip = {
      requestMediaLibraryPermissionsAsync: async () => ({ granted: false }),
      launchImageLibraryAsync: jest.fn(),
      launchCameraAsync: jest.fn(),
    };
    const denied: string[] = [];
    const pickers = createExpoPickers({ modules: { imagePicker: ip, documentPicker: dp }, onPermissionDenied: (k) => denied.push(k) });
    expect(pickers.map((p) => p.key)).toEqual(["gallery", "camera", "video", "record", "document"]);
    expect(await pickers[0].pick()).toBeNull();
    expect(denied).toEqual(["gallery"]);
    expect(ip.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(await pickers[4].pick()).toMatchObject({ name: "x.pdf" });
  });

  it("sound player: expo-audio, else expo-av, else no-op; mute respected", () => {
    const played: string[] = [];
    const audio = { createAudioPlayer: () => ({ seekTo: () => played.push("seek"), play: () => played.push("play"), remove: () => played.push("remove") }) };
    const p = createMessageSoundPlayer(1, { expoAudio: audio, expoAv: null });
    expect(p.backend).toBe("expo-audio");
    p.play();
    p.release();
    expect(played).toEqual(["seek", "play", "remove"]);
    expect(createMessageSoundPlayer(1, { expoAudio: null, expoAv: { Audio: { Sound: { createAsync: async () => ({ sound: {} }) } } } }).backend).toBe("expo-av");
    expect(createMessageSoundPlayer(1, { expoAudio: null, expoAv: null }).backend).toBe("none");
    expect(createMessageSoundPlayer(null).backend).toBe("none");
    expect(shouldPlayMessageSound({ muted: true })).toBe(false);
    expect(shouldPlayMessageSound({ appActive: false })).toBe(false);
    expect(shouldPlayMessageSound({})).toBe(true);
  });
});
