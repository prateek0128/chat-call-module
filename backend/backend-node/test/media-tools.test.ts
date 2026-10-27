/** mediaTools: every helper resolves to null when its tool is missing, never throws; uploads stay async. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findTool, makeImageThumbnail, makeVideoThumbnail, probeDuration } from "../src/core/mediaTools.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("findTool", () => {
  it("prefers <NAME>_PATH when it points at a file, ignores bad paths, searches PATH", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tools-"));
    try {
      const fake = path.join(dir, "ffprobe");
      writeFileSync(fake, "#!/bin/sh\n");
      expect(findTool("ffprobe", { FFPROBE_PATH: fake })).toBe(fake);
      expect(findTool("nosuchtool-xyz", { FFPROBE_PATH: fake, PATH: "" })).toBeNull();
      expect(findTool("ffprobe", { FFPROBE_PATH: path.join(dir, "missing"), PATH: "" })).toBeNull();
      expect(findTool("ffprobe", { PATH: dir, PATHEXT: "" })).toBe(fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("media helpers without their tools", () => {
  it("probeDuration and makeVideoThumbnail return null when ffprobe / ffmpeg are missing", async () => {
    await withEnv({ FFPROBE_PATH: undefined, FFMPEG_PATH: undefined, PATH: "", Path: "" }, async () => {
      expect(await probeDuration(Buffer.from("not media"), ".mp3")).toBeNull();
      expect(await makeVideoThumbnail(Buffer.from("not media"), ".mp4")).toBeNull();
    });
  });

  it("a failing tool (not a media file) yields null instead of throwing", async () => {
    if (process.platform === "win32") return; // shell-script stand-ins need a POSIX shell
    const dir = mkdtempSync(path.join(tmpdir(), "tools-"));
    try {
      const fail = path.join(dir, "ffprobe");
      writeFileSync(fail, "#!/bin/sh\nexit 1\n");
      chmodSync(fail, 0o755);
      await withEnv({ FFPROBE_PATH: fail }, async () => {
        expect(await probeDuration(Buffer.from("junk"), ".mp3")).toBeNull();
      });
      writeFileSync(fail, "#!/bin/sh\necho 12.6\n");
      await withEnv({ FFPROBE_PATH: fail }, async () => {
        expect(await probeDuration(Buffer.from("junk"), ".mp3")).toBe(13);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makeImageThumbnail returns null for garbage (or without sharp) and a small JPEG for a real image", async () => {
    expect(await makeImageThumbnail(Buffer.from("definitely not an image"))).toBeNull();
    let sharpAvailable = true;
    try {
      const name = "sharp";
      await import(/* @vite-ignore */ name);
    } catch {
      sharpAvailable = false;
    }
    const thumb = await makeImageThumbnail(PNG);
    if (!sharpAvailable) return expect(thumb).toBeNull();
    expect(thumb).not.toBeNull();
    expect(thumb!.subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG
  });

  it("helpers are async (they return promises and do not block)", () => {
    expect(probeDuration(Buffer.alloc(1))).toBeInstanceOf(Promise);
    expect(makeImageThumbnail(Buffer.alloc(1))).toBeInstanceOf(Promise);
    expect(makeVideoThumbnail(Buffer.alloc(1))).toBeInstanceOf(Promise);
  });
});
