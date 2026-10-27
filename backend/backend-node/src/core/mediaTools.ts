/**
 * Optional media helpers (port of commskit.core.media_tools): image / video thumbnails and audio / video duration.
 *
 * - `makeImageThumbnail` needs `sharp` (optional peer dependency, imported lazily).
 * - `probeDuration` / `makeVideoThumbnail` run `ffprobe` / `ffmpeg` when they are on PATH (or at `FFPROBE_PATH` / `FFMPEG_PATH`).
 *
 * All helpers are async (work runs off the event loop) and resolve to `null` when the tool is missing or the
 * input can't be read, so an upload never fails because of a thumbnail.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "./logger.js";

export const THUMBNAIL_SIZE: readonly [number, number] = [300, 300];
export const DURATION_MEDIA_TYPES: ReadonlySet<string> = new Set(["audio", "voice", "video", "webm"]);
export const VIDEO_MEDIA_TYPES: ReadonlySet<string> = new Set(["video", "webm"]);

const isFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** `<NAME>_PATH` env var if it points at a file, else the first match on PATH; null when not found. */
export function findTool(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[`${name.toUpperCase()}_PATH`];
  if (configured && isFile(configured)) return configured;
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function loadSharp(): Promise<any | null> {
  const name = "sharp"; // variable specifier: optional, no compile-time dependency
  try {
    const mod: any = await import(/* @vite-ignore */ name);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** JPEG thumbnail that fits in `size` (aspect kept, never enlarged); null without sharp or for a bad image. */
export async function makeImageThumbnail(data: Buffer, size: readonly [number, number] = THUMBNAIL_SIZE, quality = 80): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) {
    logger.warn("sharp is not installed (npm install sharp); no image thumbnail");
    return null;
  }
  try {
    return await sharp(data)
      .rotate()
      .resize(size[0], size[1], { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality })
      .toBuffer();
  } catch (err) {
    logger.warn(`Image thumbnail failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

async function withTempFile<T>(data: Buffer, suffix: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "commskit-media-"));
  try {
    const file = path.join(dir, `input${suffix || ".bin"}`);
    await writeFile(file, data);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as any).killed) return reject(err);
      if (err && typeof (err as any).code !== "number") return reject(err);
      resolve({ code: err ? ((err as any).code as number) : 0, stdout: stdout as Buffer });
    });
  });
}

/** Duration in whole seconds via `ffprobe`; null when ffprobe is missing or fails. */
export async function probeDuration(data: Buffer, suffix = "", timeoutSeconds = 20): Promise<number | null> {
  const ffprobe = findTool("ffprobe");
  if (!ffprobe) return null;
  try {
    return await withTempFile(data, suffix, async (file) => {
      const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], timeoutSeconds * 1000);
      const first = r.stdout.toString("utf8").trim().split(/\r?\n/)[0];
      const seconds = first ? Number(first) : NaN;
      return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
    });
  } catch (err) {
    logger.warn(`ffprobe failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** JPEG of a frame near the start via `ffmpeg`; null when ffmpeg is missing or fails. */
export async function makeVideoThumbnail(data: Buffer, suffix = ".mp4", width = THUMBNAIL_SIZE[0], timeoutSeconds = 30): Promise<Buffer | null> {
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) return null;
  try {
    return await withTempFile(data, suffix, async (file) => {
      for (const seek of ["1", "0"]) {
        // very short clips have no frame at 1 s
        const r = await run(ffmpeg, ["-v", "error", "-ss", seek, "-i", file, "-frames:v", "1", "-vf", `scale=${Math.trunc(width)}:-2`, "-f", "image2", "-c:v", "mjpeg", "pipe:1"], timeoutSeconds * 1000);
        if (r.code === 0 && r.stdout.length) return r.stdout;
      }
      return null;
    });
  } catch (err) {
    logger.warn(`ffmpeg thumbnail failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
}
