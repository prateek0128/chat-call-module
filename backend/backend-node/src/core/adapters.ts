/**
 * Interfaces the host app implements, with safe defaults (port of commskit.core.adapters).
 * Every adapter is a plain interface: any object with matching methods works.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { jwtVerify } from "jose";
import { logger } from "./logger.js";

// --------------------------------------------------------------------- auth

/** Token is missing, invalid or expired. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthAdapter {
  /** Return the user id for `token` or throw (any exception = invalid). */
  userIdFromToken(token: string): string | Promise<string>;
}

/** HS256 (by default) JWT auth reading the user id from `claim`. */
export class JwtAuth implements AuthAdapter {
  private key: Uint8Array;
  private algorithm: string;
  private claim: string;

  constructor(secret: string, options: { algorithm?: string; claim?: string } | string = {}) {
    if (!secret) throw new Error("JwtAuth needs a non-empty secret");
    const opts = typeof options === "string" ? { algorithm: options } : options;
    this.key = new TextEncoder().encode(secret);
    this.algorithm = opts.algorithm ?? "HS256";
    this.claim = opts.claim ?? "uid";
  }

  async userIdFromToken(token: string): Promise<string> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.key, { algorithms: [this.algorithm] }));
    } catch (err) {
      throw new AuthError(err instanceof Error ? err.message : String(err));
    }
    const uid = payload[this.claim];
    if (uid === null || uid === undefined || uid === "") throw new AuthError(`Token has no '${this.claim}' claim`);
    return String(uid);
  }
}

/** Call the adapter, supporting both sync and async implementations. */
export async function resolveUserId(auth: AuthAdapter, token: string): Promise<string> {
  return String(await auth.userIdFromToken(token));
}

// ---------------------------------------------------------------- directory

export interface UserProfile {
  name?: string | null;
  avatar?: string | null;
}

export interface UserDirectory {
  /** Display info for the ids it knows; unknown ids may be omitted. */
  getProfiles(userIds: readonly string[]): Promise<Record<string, UserProfile>>;
}

/** Knows nobody: names fall back to user ids / "Someone". */
export class NullUserDirectory implements UserDirectory {
  async getProfiles(): Promise<Record<string, UserProfile>> {
    return {};
  }
}

/** In-memory directory (tests, demos). */
export class StaticUserDirectory implements UserDirectory {
  profiles: Record<string, UserProfile>;
  constructor(profiles: Record<string, UserProfile> = {}) {
    this.profiles = { ...profiles };
  }
  async getProfiles(userIds: readonly string[]): Promise<Record<string, UserProfile>> {
    const out: Record<string, UserProfile> = {};
    for (const id of userIds) if (Object.hasOwn(this.profiles, id)) out[id] = this.profiles[id]!;
    return out;
  }
}

// --------------------------------------------------------------------- push

export interface PushSender {
  /** Push to every device of `userId`. Must not throw for "no devices". */
  send(
    userId: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
    channel?: string,
    ttl?: number | null,
  ): Promise<void>;
}

export class NoopPush implements PushSender {
  async send(): Promise<void> {}
}

/** Optional: backs the `/chats/expo/push/token` routes (`SqlDeviceRegistry` is the SQL implementation). */
export interface DeviceRegistry {
  register(userId: string, payload: Record<string, unknown>): Promise<unknown>;
  remove(userId: string, payload: Record<string, unknown>): Promise<unknown>;
}

// -------------------------------------------------------------------- media

export interface MediaInfo {
  file_url: string;
  file_name: string;
  file_size: number;
  file_type: string;
  media_type: string;
  thumbnail_url?: string | null;
  duration?: number | null;
}

export interface MediaStorage {
  /** Store the file and return where it lives. Throw `UploadRejected` to reject it with a message. */
  upload(chatId: number, fileName: string, data: Buffer, mediaType: string): Promise<MediaInfo>;
  /** Optional: remove a stored file (unsend, user deletion). Must not throw for files already gone. */
  delete?(fileUrl: string): Promise<void>;
}

/** Throw from `MediaStorage.upload` to refuse a file; the message goes to the client (Python: ValueError). */
export class UploadRejected extends Error {}

/** Delete files through `storage.delete` when the storage has it. Never throws; returns how many succeeded. */
export async function deleteMedia(storage: unknown, ...fileUrls: (string | null | undefined)[]): Promise<number> {
  const del = (storage as MediaStorage | undefined)?.delete;
  if (typeof del !== "function") return 0;
  let done = 0;
  for (const url of new Set(fileUrls.filter((u): u is string => !!u))) {
    try {
      await del.call(storage, url);
      done += 1;
    } catch (err) {
      logger.error(`Deleting media ${url} failed`, err);
    }
  }
  return done;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".mp4": "video/mp4", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".3gp": "video/3gpp", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wav": "audio/x-wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/opus",
  ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain", ".zip": "application/zip", ".rar": "application/vnd.rar",
};

/** Writes files under `root/chat/<chatId>/<mediaType>/`; `file_url` is `baseUrl` + relative path (serve `root` yourself). */
export class LocalDiskStorage implements MediaStorage {
  root: string;
  baseUrl: string;

  constructor(root = "comms_media", baseUrl = "/media") {
    this.root = root;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async upload(chatId: number, fileName: string, data: Buffer, mediaType: string): Promise<MediaInfo> {
    const safeName = path.basename(fileName.replace(/\\/g, "/")).replace(/ /g, "_") || "file";
    const rel = `chat/${chatId}/${mediaType}/${randomBytes(6).toString("hex")}_${safeName}`;
    const file = path.join(this.root, ...rel.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    return {
      file_url: `${this.baseUrl}/${rel}`,
      file_name: fileName,
      file_size: data.length,
      file_type: MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream",
      media_type: mediaType,
    };
  }

  /** Local path of a URL this storage produced; null for anything else (incl. `..` tricks). */
  pathFor(fileUrl: string): string | null {
    const prefix = `${this.baseUrl}/`;
    const url = fileUrl.split("?", 1)[0]!;
    if (!url.startsWith(prefix)) return null;
    const rel = url.slice(prefix.length);
    const parts = rel.split("/");
    if (!rel || parts.some((p) => p === "" || p === "." || p === "..")) return null;
    const root = path.resolve(this.root);
    const file = path.resolve(root, ...parts);
    return file.startsWith(root + path.sep) ? file : null;
  }

  async delete(fileUrl: string): Promise<void> {
    const file = this.pathFor(fileUrl);
    if (file === null) return;
    await fs.rm(file, { force: true });
  }
}
