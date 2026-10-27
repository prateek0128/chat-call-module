/** `hub.install(new ChatFeature({...}))` (port of commskit.chat.feature). */
import { type DeviceRegistry, LocalDiskStorage, type MediaStorage, deleteMedia } from "../core/adapters.js";
import type { CommsHub, Feature } from "../core/hub.js";
import { RateLimit } from "../core/ratelimit.js";
import { type MessageDto, messageDto } from "./dto.js";
import { ChatHandlers } from "./handlers.js";
import { AllowAllChatPolicy, type ChatPolicy } from "./policy.js";
import { buildChatRoutes } from "./router.js";
import { ChatService, SYSTEM_TYPE } from "./service.js";

export interface ChatConfig {
  maxUploadBytes: number;
  defaultPageSize: number;
  maxPageSize: number;
  pushPreviewChars: number;
  /** Android channel created natively by the app. */
  pushChannel: string;
  /** PROTOCOL.md section 9 "Limits". null disables a limit; maxTextLength 0 = unlimited. */
  maxTextLength: number;
  messageRate: RateLimit | null; // send_message, POST /chats/send
  uploadRate: RateLimit | null; // media_upload
  typingRate: RateLimit | null; // typing (is_typing=true); dropped silently
  /** Unsend ("delete for everyone"): seconds after sending; 0 = no limit, -1 = disabled. */
  unsendWindowSeconds: number;
  /** System messages without aboutUserId go into a chat with this id (null: aboutUserId required). */
  systemSenderId: string | null;
  /** Push title for system messages (null: the about-user's name, else "Notification"). */
  systemPushTitle: string | null;
}

export const defaultChatConfig = (): ChatConfig => ({
  maxUploadBytes: 10 * 1024 * 1024,
  defaultPageSize: 10,
  maxPageSize: 100,
  pushPreviewChars: 120,
  pushChannel: "messages",
  maxTextLength: 4000,
  messageRate: new RateLimit(20, 10),
  uploadRate: new RateLimit(5, 60),
  typingRate: new RateLimit(5, 5),
  unsendWindowSeconds: 3600,
  systemSenderId: null,
  systemPushTitle: null,
});

export interface ChatFeatureOptions {
  policy?: ChatPolicy;
  storage?: MediaStorage;
  /** Optional: enables the legacy push-token REST routes. */
  devices?: DeviceRegistry;
  config?: Partial<ChatConfig>;
}

/** 1:1 chat. */
export class ChatFeature implements Feature {
  readonly name = "chat";
  policy: ChatPolicy;
  storage: MediaStorage;
  devices?: DeviceRegistry;
  config: ChatConfig;
  handlers!: ChatHandlers;
  private _hub: CommsHub | null = null;

  constructor(opts: ChatFeatureOptions = {}) {
    this.policy = opts.policy ?? new AllowAllChatPolicy();
    this.storage = opts.storage ?? new LocalDiskStorage();
    this.devices = opts.devices;
    this.config = { ...defaultChatConfig(), ...(opts.config ?? {}) };
  }

  get hub(): CommsHub {
    if (!this._hub) throw new Error("ChatFeature is not installed; call hub.install(feature) first");
    return this._hub;
  }

  install(hub: CommsHub): this {
    hub.registerFeature(this.name, this);
    this._hub = hub;
    this.handlers = new ChatHandlers(this);
    this.handlers.register();
    hub.onConnect((uid, ws) => this.handlers.onConnect(uid, ws));
    hub.connections.setPartnersLookup((uid) => this.partnerIds(uid));
    hub.includeRoutes(buildChatRoutes(this));
    return this;
  }

  /** Conversation partners (receivers of this user's `user_status`). */
  async partnerIds(userId: string): Promise<string[]> {
    return this.handlers.service(this.hub.db).partnerIds(userId);
  }

  // ------------------------------------------------------- server-side API

  /**
   * Send a text message as `senderId` from trusted server code (bots, admin tools, tests). Same storage,
   * events and push as WS `send_message`; no rate limit. The policy is only checked with `enforcePolicy`.
   * Returns the MessageDto as the sender sees it; throws `ChatActionError` (self-message, too long, policy).
   */
  async sendMessageAs(
    senderId: string,
    toUserId: string,
    content: string,
    opts: { replyToId?: number | null; enforcePolicy?: boolean } = {},
  ): Promise<MessageDto> {
    return this.handlers.sendText(this.hub.db, String(senderId), String(toUserId), content, {
      replyToId: opts.replyToId,
      checkPolicy: opts.enforcePolicy ?? false,
      rateLimit: false,
    });
  }

  /**
   * A `message_type: "system"` message shown to `toUserId` only (e.g. "You matched with Asha"). It goes into
   * the chat between `toUserId` and `aboutUserId` (created if needed), stored with `sender_id = aboutUserId`
   * and hidden for `aboutUserId`. Without `aboutUserId`, `config.systemSenderId` is the chat partner
   * (throws if neither is set). `data` is added to the live frame (`message.data`) and to the push data; it is
   * not stored. Returns the MessageDto as `toUserId` sees it.
   */
  async sendSystemMessage(
    toUserId: string,
    content: string,
    opts: { aboutUserId?: string | null; data?: Record<string, unknown> | null; push?: boolean } = {},
  ): Promise<MessageDto> {
    const to = String(toUserId);
    const about = opts.aboutUserId;
    const hasAbout = about !== null && about !== undefined && about !== "";
    const sender = hasAbout ? String(about) : this.config.systemSenderId;
    if (!sender) throw new Error("sendSystemMessage needs aboutUserId (or ChatConfig.systemSenderId)");
    if (sender === to) throw new Error("aboutUserId must differ from toUserId");
    const text = String(content);
    const hub = this.hub;
    const service = new ChatService(hub.db, hub.dialect);
    const chat = await service.getOrCreateChat(to, sender);
    const row = await service.sendMessage(chat.id, sender, text, SYSTEM_TYPE);
    if (hasAbout) await service.hideMessage(sender, row.id);
    const dto = messageDto(row, to, null, { is_read: false, is_delivered: true });
    if (opts.data && Object.keys(opts.data).length) dto.data = { ...opts.data };
    const delivered = await hub.send(to, { type: "new_message", message: dto });
    if (delivered) await service.markDelivered([row.id]);
    if (opts.push ?? true) {
      let title = this.config.systemPushTitle;
      if (title === null) title = hasAbout ? await hub.displayName(sender, "Notification") : "Notification";
      await this.handlers.notifyOffline(
        to, sender, row.chat_id, Array.from(text).slice(0, this.config.pushPreviewChars).join(""), title,
        { ...(opts.data ?? {}), system: true },
      );
    }
    dto.is_delivered = delivered;
    await hub.events.emit("chat.system_message_sent", { ...dto });
    return dto;
  }

  /**
   * Account deletion: every chat `userId` is in, all its messages (the partner's view goes too: a 1:1 chat has
   * one copy), hides / clears, and the stored media (through `MediaStorage.delete`). Returns counts.
   */
  async deleteUserData(userId: string): Promise<{ chats: number; messages: number; media: number }> {
    const uid = String(userId);
    const [counts, urls] = await new ChatService(this.hub.db, this.hub.dialect).deleteUserData(uid);
    const media = await deleteMedia(this.storage, ...urls);
    this.handlers.forgetUser(uid);
    return { ...counts, media };
  }
}
