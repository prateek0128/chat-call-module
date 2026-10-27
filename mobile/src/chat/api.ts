/**
 * Chat REST helpers (PROTOCOL §5) using fetch + getToken(). No axios.
 * Plain functions taking `{baseUrl, getToken}` so they work outside React too;
 * inside React use `useChatApi()` (hooks.ts) which binds them to the CommsProvider config.
 */
import { authFetch, CommsConfig } from "../core/config";
import type { ChatId, UserId } from "../core/types";

export type ApiConfig = Pick<CommsConfig, "baseUrl" | "getToken">;

export interface StartChatResponse {
  chat_id: ChatId;
  user1_id: UserId;
  user2_id: UserId;
  created_at?: string;
  updated_at?: string;
}

/** `POST /chats/start?candidate_id=<id>` — get or create the 1:1 chat with that user. */
export const startChat = (config: ApiConfig, candidateId: UserId): Promise<StartChatResponse> =>
  authFetch<StartChatResponse>(config, `/chats/start?candidate_id=${encodeURIComponent(String(candidateId))}`, {
    method: "POST",
  });

/**
 * Push token payload. The shape is owned by the host's push adapter on the backend;
 * A host might send e.g. `{token, platform, device_id}`.
 */
export type PushTokenPayload = Record<string, unknown>;

/** `POST /chats/expo/push/token` */
export const registerPushToken = <T = unknown>(config: ApiConfig, payload: PushTokenPayload): Promise<T> =>
  authFetch<T>(config, "/chats/expo/push/token", { method: "POST", body: payload });

/** `POST /chats/expo/push/token/remove` */
export const removePushToken = <T = unknown>(config: ApiConfig, payload: PushTokenPayload): Promise<T> =>
  authFetch<T>(config, "/chats/expo/push/token/remove", { method: "POST", body: payload });
