import { conversationPreview } from "../src/chat-ui/preview";
import { copyableText, replySnippet } from "../src/chat-ui/messageActions";
import { isPlaceholder } from "../src/chat-ui/format";

// The backend stores attachment content as "[TYPE] file_name" (handlers.py), e.g. "[IMAGE] photo.png".
describe("attachment placeholder content", () => {
  it("recognises both '[Image]' and '[IMAGE] photo.png'", () => {
    expect(isPlaceholder("[Image]")).toBe(true);
    expect(isPlaceholder("[IMAGE] photo.png")).toBe(true);
    expect(isPlaceholder("hello [world]")).toBe(false);
  });
  it("does not show it as a caption, copyable text or quote text", () => {
    const m: any = { id: 1, isMine: false, message_type: "image", content: "[IMAGE] photo.png", file_name: "photo.png", file_url: "/media/a.png" };
    expect(copyableText(m)).toBeNull();
    expect(replySnippet(m)).toBe("📷 Photo");
    expect(conversationPreview({ last_message: m }).text).toBe("📷 Photo");
  });
});

import { ChatStore, DEFAULT_PAGE_SIZE, MAX_UPLOAD_BYTES } from "../src/chat/ChatStore";

describe("ChatStore option defaults", () => {
  it("undefined options (as ChatProvider forwards them) keep the defaults", () => {
    const store: any = new ChatStore({ send: () => true, pageSize: undefined, maxUploadBytes: undefined, autoMarkReadActive: undefined } as any);
    expect(store.opts.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(store.opts.maxUploadBytes).toBe(MAX_UPLOAD_BYTES);
    expect(store.opts.autoMarkReadActive).toBe(true);
  });
});
