/**
 * `S3Storage`: a reference `MediaStorage` on Amazon S3 (port of commskit.core.s3). Needs `@aws-sdk/client-s3`
 * (and `@aws-sdk/s3-request-presigner` for presigned URLs), both optional and imported lazily, unless you inject `client`.
 *
 * Key layout: `{prefix}chat/{chat_id}/{media_type}/{unix_ts}_{uuid8}_{name}`; thumbnails sit next to the file as
 * `..._thumb.jpg`. Images get a sharp thumbnail, videos an ffmpeg one (when installed, see mediaTools), audio / voice /
 * video a duration (ffprobe). `private: true` stores presigned GET URLs (`presignExpires`, at most 7 days) instead of
 * public URLs; refresh old ones with `storage.presign(fileUrl)`.
 *
 *   new ChatFeature({ storage: new S3Storage({ bucket: "my-bucket", region: "ap-south-1" }) })
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { MediaInfo, MediaStorage } from "./adapters.js";
import { logger } from "./logger.js";
import { DURATION_MEDIA_TYPES, VIDEO_MEDIA_TYPES, makeImageThumbnail, makeVideoThumbnail, probeDuration } from "./mediaTools.js";

export const PRESIGN_MAX_SECONDS = 7 * 24 * 3600; // SigV4 ceiling

/** The S3 operations the storage needs; the default implementation wraps @aws-sdk/client-s3 (inject a fake in tests). */
export interface S3Operations {
  putObject(params: { Bucket: string; Key: string; Body: Buffer; ContentType: string; [k: string]: unknown }): Promise<unknown>;
  deleteObject(params: { Bucket: string; Key: string }): Promise<unknown>;
  presignGet(params: { Bucket: string; Key: string }, expiresIn: number): Promise<string>;
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

function safeName(fileName: string): string {
  const base = path.posix.basename(fileName.replace(/\\/g, "/")).trim();
  const name = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "file";
  return name.slice(-120);
}

export function thumbnailKey(key: string): string {
  const last = key.slice(key.lastIndexOf("/") + 1);
  const base = last.includes(".") ? key.slice(0, key.lastIndexOf(".")) : key;
  return `${base}_thumb.jpg`;
}

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  /** An S3Operations implementation (default: built lazily from @aws-sdk/client-s3). */
  client?: S3Operations;
  prefix?: string;
  publicBaseUrl?: string;
  private?: boolean;
  presignExpires?: number;
  thumbnails?: boolean;
  durations?: boolean;
  /** Extra PutObject parameters (e.g. ServerSideEncryption, CacheControl). */
  extraPutArgs?: Record<string, unknown>;
}

/** Lazily build S3Operations on top of the AWS SDK v3. */
function awsOperations(region: string | undefined): () => Promise<S3Operations> {
  let ops: S3Operations | null = null;
  return async () => {
    if (ops) return ops;
    let sdk: any;
    try {
      const name = "@aws-sdk/client-s3";
      sdk = await import(/* @vite-ignore */ name);
    } catch {
      throw new Error("S3Storage needs @aws-sdk/client-s3: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner");
    }
    const s3 = new sdk.S3Client(region ? { region } : {});
    ops = {
      putObject: (p) => s3.send(new sdk.PutObjectCommand(p)),
      deleteObject: (p) => s3.send(new sdk.DeleteObjectCommand(p)),
      presignGet: async (p, expiresIn) => {
        let presigner: any;
        try {
          const name = "@aws-sdk/s3-request-presigner";
          presigner = await import(/* @vite-ignore */ name);
        } catch {
          throw new Error("Presigned URLs need @aws-sdk/s3-request-presigner");
        }
        return presigner.getSignedUrl(s3, new sdk.GetObjectCommand(p), { expiresIn });
      },
    };
    return ops;
  };
}

export class S3Storage implements MediaStorage {
  readonly bucket: string;
  readonly region?: string;
  readonly prefix: string;
  readonly publicBaseUrl: string;
  readonly private: boolean;
  readonly presignExpires: number;
  readonly thumbnails: boolean;
  readonly durations: boolean;
  readonly extraPutArgs: Record<string, unknown>;
  private injected?: S3Operations;
  private lazyOps: () => Promise<S3Operations>;

  constructor(opts: S3StorageOptions) {
    if (!opts.bucket) throw new Error("S3Storage needs a bucket");
    const expires = opts.presignExpires ?? PRESIGN_MAX_SECONDS;
    if (!(expires >= 1 && expires <= PRESIGN_MAX_SECONDS)) throw new Error("presignExpires must be between 1 s and 7 days");
    this.bucket = opts.bucket;
    this.region = opts.region;
    const p = (opts.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.prefix = p ? `${p}/` : "";
    this.publicBaseUrl = opts.publicBaseUrl
      ? opts.publicBaseUrl.replace(/\/+$/, "")
      : opts.region
        ? `https://${opts.bucket}.s3.${opts.region}.amazonaws.com`
        : `https://${opts.bucket}.s3.amazonaws.com`;
    this.private = opts.private ?? false;
    this.presignExpires = expires;
    this.thumbnails = opts.thumbnails ?? true;
    this.durations = opts.durations ?? true;
    this.extraPutArgs = { ...(opts.extraPutArgs ?? {}) };
    this.injected = opts.client;
    this.lazyOps = awsOperations(opts.region);
  }

  private ops(): Promise<S3Operations> {
    return this.injected ? Promise.resolve(this.injected) : this.lazyOps();
  }

  // ------------------------------------------------------------------ keys

  makeKey(chatId: number, mediaType: string, fileName: string): string {
    return `${this.prefix}chat/${chatId}/${mediaType}/${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}_${safeName(fileName)}`;
  }

  async urlFor(key: string): Promise<string> {
    if (this.private) return (await this.ops()).presignGet({ Bucket: this.bucket, Key: key }, this.presignExpires);
    return `${this.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Object key of a URL this storage produced (public or presigned); null otherwise. */
  keyFor(fileUrl: string): string | null {
    if (!fileUrl) return null;
    const base = `${this.publicBaseUrl}/`;
    const plain = fileUrl.split("?", 1)[0]!;
    let key: string;
    try {
      if (plain.startsWith(base)) key = decodeURIComponent(plain.slice(base.length));
      else {
        const u = new URL(plain);
        const p = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
        if (u.hostname.toLowerCase().startsWith(`${this.bucket.toLowerCase()}.`)) key = p; // virtual-hosted style
        else if (p.startsWith(`${this.bucket}/`)) key = p.slice(this.bucket.length + 1); // path style
        else return null;
      }
    } catch {
      return null;
    }
    if (!key.startsWith(`${this.prefix}chat/`) || key.split("/").includes("..")) return null;
    return key;
  }

  /** Fresh presigned GET URL for a stored file; null for URLs this storage did not produce. */
  async presign(fileUrl: string, expires?: number): Promise<string | null> {
    const key = this.keyFor(fileUrl);
    if (key === null) return null;
    return (await this.ops()).presignGet({ Bucket: this.bucket, Key: key }, Math.min(expires || this.presignExpires, PRESIGN_MAX_SECONDS));
  }

  // ---------------------------------------------------------------- upload

  private async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await (await this.ops()).putObject({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ...this.extraPutArgs });
  }

  async upload(chatId: number, fileName: string, data: Buffer, mediaType: string): Promise<MediaInfo> {
    const suffix = path.posix.extname(fileName.replace(/\\/g, "/")).toLowerCase();
    const contentType = MIME[suffix] ?? "application/octet-stream";
    const key = this.makeKey(chatId, mediaType, fileName);
    await this.put(key, data, contentType);
    const info: MediaInfo = {
      file_url: await this.urlFor(key),
      file_name: fileName,
      file_size: data.length,
      file_type: contentType,
      media_type: mediaType,
    };
    let thumb: Buffer | null = null;
    if (this.thumbnails && mediaType === "image") thumb = await makeImageThumbnail(data);
    else if (this.thumbnails && VIDEO_MEDIA_TYPES.has(mediaType)) thumb = await makeVideoThumbnail(data, suffix || ".mp4");
    if (thumb) {
      try {
        const tkey = thumbnailKey(key);
        await this.put(tkey, thumb, "image/jpeg");
        info.thumbnail_url = await this.urlFor(tkey);
      } catch (err) {
        logger.error(`Thumbnail upload failed for ${key}`, err);
      }
    }
    if (this.durations && DURATION_MEDIA_TYPES.has(mediaType)) info.duration = await probeDuration(data, suffix);
    return info;
  }

  // ---------------------------------------------------------------- delete

  /** Delete the object (and its thumbnail). Unknown URLs are ignored; S3 deletes are idempotent. */
  async delete(fileUrl: string): Promise<void> {
    const key = this.keyFor(fileUrl);
    if (key === null) return;
    const ops = await this.ops();
    await ops.deleteObject({ Bucket: this.bucket, Key: key });
    const rel = key.slice(this.prefix.length).split("/");
    const mediaType = rel.length >= 4 ? rel[2]! : "";
    if ((mediaType === "image" || VIDEO_MEDIA_TYPES.has(mediaType)) && !key.endsWith("_thumb.jpg")) {
      await ops.deleteObject({ Bucket: this.bucket, Key: thumbnailKey(key) });
    }
  }
}
