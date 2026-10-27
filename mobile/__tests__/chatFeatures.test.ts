/** Pure helpers for reply / message actions / media / in-app banner, and the default fileActions adapter. */
import type { ChatMessage, ChatState } from "../src/chat/types";
import {
  bannerSuppression,
  bannerText,
  canReplyTo,
  copyableText,
  createDefaultFileActions,
  formatMediaDuration,
  messageActionList,
  primeSeen,
  replySenderLabel,
  replySnippet,
  safeFileName,
  scanForBanners,
  SeenSet,
  shouldTriggerReply,
  swipeReplyOffset,
  SWIPE_REPLY_THRESHOLD,
} from "../src/chat-ui";

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  chat_id: 1,
  sender_id: "bob",
  sender_type: "other",
  content: "hello",
  message_type: "text",
  timestamp: new Date().toISOString(),
  is_read: false,
  is_delivered: true,
  isMine: false,
  ...over,
});

describe("reply helpers", () => {
  it("replySnippet: text, attachments, placeholders, trimming", () => {
    expect(replySnippet(msg({ content: "  hi \n there " }))).toBe("hi there");
    expect(replySnippet(msg({ message_type: "image", content: "[Image]" }))).toBe("📷 Photo");
    expect(replySnippet(msg({ message_type: "image", content: "sunset" }))).toBe("📷 sunset");
    expect(replySnippet(msg({ message_type: "file", content: "a.pdf", file_name: "a.pdf" }))).toBe("📎 a.pdf");
    expect(replySnippet({ message_type: "video", content: null, file_name: null })).toBe("🎥 Video");
    expect(replySnippet(msg({ content: "" }))).toBe("Message");
    expect(replySnippet(null)).toBe("Message");
    const long = replySnippet(msg({ content: "x".repeat(300) }), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });

  it("replySenderLabel and canReplyTo", () => {
    expect(replySenderLabel(msg({ isMine: true }), "Asha")).toBe("You");
    expect(replySenderLabel(msg(), "Asha")).toBe("Asha");
    expect(replySenderLabel({ sender_id: "me" }, "Asha", "me")).toBe("You");
    expect(replySenderLabel(msg(), null)).toBe("Them");
    expect(canReplyTo(msg())).toBe(true);
    expect(canReplyTo(msg({ id: "temp_1", pending: true }))).toBe(false);
    expect(canReplyTo(msg({ message_type: "call" }))).toBe(false);
  });

  it("swipe offset resists after the threshold; triggers at the threshold", () => {
    expect(swipeReplyOffset(-20)).toBe(0);
    expect(swipeReplyOffset(30)).toBe(30);
    expect(swipeReplyOffset(1000)).toBe(80);
    expect(shouldTriggerReply(SWIPE_REPLY_THRESHOLD - 1)).toBe(false);
    expect(shouldTriggerReply(SWIPE_REPLY_THRESHOLD)).toBe(true);
  });
});

describe("messageActionList", () => {
  const all = { reply: true, copy: true, saveToGallery: true, download: true, share: true, report: true };
  const keys = (m: ChatMessage, a = all, extra: any[] = []) => messageActionList(m, a, extra).map((x) => x.key);

  it("text: reply, copy, report (incoming only)", () => {
    expect(keys(msg())).toEqual(["reply", "copy", "report"]);
    expect(keys(msg({ isMine: true }))).toEqual(["reply", "copy"]);
    expect(keys(msg(), { ...all, copy: false, report: false })).toEqual(["reply"]);
  });

  it("image / video: save to gallery when available, else download; share", () => {
    const img = msg({ message_type: "image", content: "[Image]", file_url: "https://x/a.jpg" });
    expect(keys(img)).toEqual(["reply", "save", "share", "report"]);
    expect(keys(img, { ...all, saveToGallery: false })).toEqual(["reply", "download", "share", "report"]);
    expect(keys(msg({ message_type: "video", content: "look", file_url: "https://x/v.mp4" }))).toEqual(["reply", "copy", "save", "share", "report"]);
  });

  it("files: download + share; nothing for files without a URL; call entries only get host extras", () => {
    expect(keys(msg({ message_type: "file", content: "a.pdf", file_name: "a.pdf", file_url: "https://x/a.pdf" }))).toEqual(["reply", "download", "share", "report"]);
    expect(keys(msg({ message_type: "file", content: "a.pdf", file_name: "a.pdf" }))).toEqual(["reply", "report"]);
    const extra = [{ key: "pin", label: "Pin" }];
    expect(keys(msg({ message_type: "call" }), all, extra)).toEqual(["pin"]);
    expect(keys(msg(), all, extra)).toEqual(["reply", "copy", "report", "pin"]);
  });

  it("copyableText ignores placeholders and file names", () => {
    expect(copyableText(msg({ content: "[Image]", message_type: "image" }))).toBeNull();
    expect(copyableText(msg({ content: "a.pdf", file_name: "a.pdf", message_type: "file" }))).toBeNull();
    expect(copyableText(msg({ content: " hi " }))).toBe("hi");
  });
});

describe("formatMediaDuration", () => {
  it("formats seconds, hours, milliseconds and unknown", () => {
    expect(formatMediaDuration(7)).toBe("0:07");
    expect(formatMediaDuration(65)).toBe("1:05");
    expect(formatMediaDuration(3723)).toBe("1:02:03");
    expect(formatMediaDuration(65000)).toBe("1:05");
    expect(formatMediaDuration(null)).toBe("");
    expect(formatMediaDuration(-1)).toBe("");
    expect(formatMediaDuration(NaN)).toBe("");
  });
});

describe("in-app banner decisions", () => {
  const now = Date.now();
  it("suppression reasons", () => {
    const base = { peerId: "bob", message: msg(), activePeerId: null, appActive: true, now };
    expect(bannerSuppression(base)).toBeNull();
    expect(bannerSuppression({ ...base, message: msg({ isMine: true }) })).toBe("mine");
    expect(bannerSuppression({ ...base, message: msg({ message_type: "call" }) })).toBe("call");
    expect(bannerSuppression({ ...base, activePeerId: "bob" })).toBe("active_chat");
    expect(bannerSuppression({ ...base, appActive: false })).toBe("background");
    expect(bannerSuppression({ ...base, enabled: false })).toBe("disabled");
    expect(bannerSuppression({ ...base, message: msg({ timestamp: new Date(now - 10 * 60_000).toISOString() }) })).toBe("stale");
    const seen = new SeenSet();
    seen.add("bob:1");
    expect(bannerSuppression({ ...base, seen })).toBe("duplicate");
  });

  it("scanForBanners: history primed, new messages once, other chats only", () => {
    const thread = (messages: ChatMessage[]) => ({ peerId: "x", chatId: 1, messages, loading: false, loadingMore: false, hasMore: false, loaded: true, info: null });
    let state: Pick<ChatState, "threads" | "activePeerId"> = { threads: { bob: thread([msg({ id: 1 })]) }, activePeerId: "asha" };
    const seen = new SeenSet();
    primeSeen(state, seen);
    expect(scanForBanners(state, seen, { appActive: true })).toEqual([]);

    state = { ...state, threads: { ...state.threads, bob: thread([msg({ id: 2, content: "new!" }), msg({ id: 1 })]) } };
    const first = scanForBanners(state, seen, { appActive: true });
    expect(first.map((c) => c.key)).toEqual(["bob:2"]);
    expect(bannerText(first[0].message)).toBe("new!");
    expect(scanForBanners(state, seen, { appActive: true })).toEqual([]); // deduped

    state = { ...state, threads: { ...state.threads, asha: thread([msg({ id: 3, sender_id: "asha" })]) } };
    expect(scanForBanners(state, seen, { appActive: true })).toEqual([]); // the open chat

    state = { ...state, threads: { ...state.threads, bob: thread([msg({ id: 4 })]) } };
    expect(scanForBanners(state, seen, { appActive: false })).toEqual([]); // backgrounded
    expect(seen.has("bob:4")).toBe(true);
  });

  it("SeenSet is bounded", () => {
    const s = new SeenSet(2);
    s.add("a");
    s.add("b");
    s.add("c");
    expect(s.size).toBe(2);
    expect(s.has("a")).toBe(false);
  });
});

describe("default fileActions adapter", () => {
  const target = { url: "https://cdn.example.com/files/photo.jpg?sig=1", name: "photo.jpg", mimeType: "image/jpeg", kind: "image" };

  const fakeFs = (status = 200) => ({
    cacheDirectory: "file:///cache/",
    createDownloadResumable: jest.fn((url: string, dest: string, _opts: unknown, cb: (p: any) => void) => ({
      downloadAsync: async () => {
        cb({ totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
        cb({ totalBytesWritten: 100, totalBytesExpectedToWrite: 100 });
        return { uri: dest, status };
      },
    })),
  });

  it("safeFileName keeps an extension and strips unsafe characters", () => {
    expect(safeFileName({ url: "https://x/a/b.pdf?x=1" })).toBe("b.pdf");
    expect(safeFileName({ url: "https://x/a/blob", name: "my:report", mimeType: "application/pdf" })).toBe("my_report.pdf");
  });

  it("download reports progress and returns the cached file", async () => {
    const fileSystem = fakeFs();
    const actions = createDefaultFileActions({ modules: { fileSystem, sharing: null, mediaLibrary: null } });
    const progress: number[] = [];
    const res = await actions.download(target, (p) => progress.push(p));
    expect(res).toEqual({ ok: true, uri: "file:///cache/photo.jpg" });
    expect(progress).toEqual([0.5, 1, 1]);
    expect(fileSystem.createDownloadResumable.mock.calls[0][0]).toBe(target.url);
  });

  it("download failure (HTTP 404) and the openURL fallback without expo-file-system", async () => {
    const failed = await createDefaultFileActions({ modules: { fileSystem: fakeFs(404) } }).download(target);
    expect(failed).toMatchObject({ ok: false, reason: "failed" });
    const opened: string[] = [];
    const fallback = await createDefaultFileActions({ modules: { fileSystem: null, sharing: null, mediaLibrary: null }, openURL: async (u) => void opened.push(u) }).download(target);
    expect(fallback).toEqual({ ok: true, uri: target.url, fallback: true });
    expect(opened).toEqual([target.url]);
    expect(await createDefaultFileActions({ modules: { fileSystem: null } }).download(target)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("share downloads then opens the share sheet; falls back when sharing is unavailable", async () => {
    const sharing = { isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) };
    const res = await createDefaultFileActions({ modules: { fileSystem: fakeFs(), sharing } }).share(target);
    expect(res).toEqual({ ok: true, uri: "file:///cache/photo.jpg" });
    expect(sharing.shareAsync).toHaveBeenCalledWith("file:///cache/photo.jpg", { mimeType: "image/jpeg", dialogTitle: "photo.jpg" });

    const opened: string[] = [];
    const unavailable = { isAvailableAsync: async () => false, shareAsync: jest.fn() };
    const fb = await createDefaultFileActions({ modules: { fileSystem: fakeFs(), sharing: unavailable }, openURL: async (u) => void opened.push(u) }).share(target);
    expect(fb.fallback).toBe(true);
    expect(unavailable.shareAsync).not.toHaveBeenCalled();
  });

  it("saveToGallery: permission denied path, success, and capability flag", async () => {
    const denied = { requestPermissionsAsync: jest.fn(async () => ({ granted: false, status: "denied" })), saveToLibraryAsync: jest.fn() };
    const fileSystem = fakeFs();
    const a = createDefaultFileActions({ modules: { fileSystem, mediaLibrary: denied } });
    expect(a.capabilities().saveToGallery).toBe(true);
    expect(await a.saveToGallery(target)).toMatchObject({ ok: false, reason: "permission_denied" });
    expect(denied.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(fileSystem.createDownloadResumable).not.toHaveBeenCalled();

    const granted = { requestPermissionsAsync: async () => ({ granted: true }), saveToLibraryAsync: jest.fn(async () => undefined) };
    expect(await createDefaultFileActions({ modules: { fileSystem: fakeFs(), mediaLibrary: granted } }).saveToGallery(target)).toEqual({ ok: true, uri: "file:///cache/photo.jpg" });
    expect(granted.saveToLibraryAsync).toHaveBeenCalledWith("file:///cache/photo.jpg");

    const none = createDefaultFileActions({ modules: { fileSystem: fakeFs(), mediaLibrary: null } });
    expect(none.capabilities().saveToGallery).toBe(false);
    expect(await none.saveToGallery(target)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
