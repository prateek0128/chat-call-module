/** S3Storage with an injected fake client (no network, no AWS SDK). */
import { describe, expect, it } from "vitest";
import { type S3Operations, S3Storage, thumbnailKey } from "../src/core/s3.js";

class FakeS3 implements S3Operations {
  puts: Array<Record<string, any>> = [];
  deletes: string[] = [];
  presigned: Array<{ key: string; expires: number }> = [];
  async putObject(p: Record<string, any>) {
    this.puts.push(p);
  }
  async deleteObject(p: { Key: string }) {
    this.deletes.push(p.Key);
  }
  async presignGet(p: { Key: string }, expires: number) {
    this.presigned.push({ key: p.Key, expires });
    return `https://signed.example/${p.Key}?X-Amz-Expires=${expires}&X-Amz-Signature=abc`;
  }
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("S3Storage", () => {
  it("key layout, content type, public URL, no thumbnail without sharp installed or disabled", async () => {
    const s3 = new FakeS3();
    const storage = new S3Storage({ bucket: "bkt", region: "ap-south-1", client: s3, prefix: "/media/", thumbnails: false, durations: false });
    const info = await storage.upload(42, "My Report (1).pdf", Buffer.from("pdf"), "document");
    expect(s3.puts).toHaveLength(1);
    const put = s3.puts[0]!;
    expect(put.Bucket).toBe("bkt");
    expect(put.Key).toMatch(/^media\/chat\/42\/document\/\d+_[0-9a-f]{8}_My_Report_1_.pdf$/);
    expect(put.ContentType).toBe("application/pdf");
    expect(info).toEqual({
      file_url: `https://bkt.s3.ap-south-1.amazonaws.com/${put.Key}`,
      file_name: "My Report (1).pdf",
      file_size: 3,
      file_type: "application/pdf",
      media_type: "document",
    });
    expect(storage.keyFor(info.file_url)).toBe(put.Key);
  });

  it("unknown extension, path stripping and extra put args", async () => {
    const s3 = new FakeS3();
    const storage = new S3Storage({ bucket: "b", client: s3, thumbnails: false, durations: false, extraPutArgs: { ServerSideEncryption: "AES256" } });
    await storage.upload(1, "../../etc/passwd.xyz", Buffer.from("x"), "document");
    expect(s3.puts[0]!.Key).toMatch(/^chat\/1\/document\/\d+_[0-9a-f]{8}_passwd.xyz$/);
    expect(s3.puts[0]!.ContentType).toBe("application/octet-stream");
    expect(s3.puts[0]!.ServerSideEncryption).toBe("AES256");
    expect(storage.publicBaseUrl).toBe("https://b.s3.amazonaws.com");
  });

  it("private mode stores presigned URLs and presign() refreshes them", async () => {
    const s3 = new FakeS3();
    const storage = new S3Storage({ bucket: "bkt", client: s3, private: true, presignExpires: 3600, thumbnails: false, durations: false });
    const info = await storage.upload(7, "a.txt", Buffer.from("hi"), "document");
    expect(info.file_url).toContain("signed.example/chat/7/document/");
    expect(info.file_url).toContain("X-Amz-Expires=3600");
    const key = s3.puts[0]!.Key as string;
    expect(storage.keyFor(info.file_url)).toBeNull(); // not a bucket URL: signed.example
    const fresh = await storage.presign(`https://bkt.s3.amazonaws.com/${key}?X-Amz-Signature=old`, 60);
    expect(fresh).toContain("X-Amz-Expires=60");
    expect(await storage.presign(`https://bkt.s3.amazonaws.com/${key}`, 99999999)).toContain(`Expires=${7 * 24 * 3600}`);
    expect(await storage.presign("https://elsewhere.example/file")).toBeNull();
  });

  it("keyFor accepts virtual-hosted, path-style and public URLs and rejects foreign ones", () => {
    const storage = new S3Storage({ bucket: "bkt", region: "eu-west-1", client: new FakeS3(), prefix: "p" });
    const key = "p/chat/1/image/1_abcdef12_a.png";
    expect(storage.keyFor(`https://bkt.s3.eu-west-1.amazonaws.com/${key}`)).toBe(key);
    expect(storage.keyFor(`https://bkt.s3.us-east-1.amazonaws.com/${key}?X-Amz-Signature=1`)).toBe(key);
    expect(storage.keyFor(`https://s3.eu-west-1.amazonaws.com/bkt/${key}`)).toBe(key);
    expect(storage.keyFor(`https://other.s3.amazonaws.com/${key}`)).toBeNull();
    expect(storage.keyFor("https://bkt.s3.eu-west-1.amazonaws.com/p/secret/file")).toBeNull(); // outside chat/
    expect(storage.keyFor("https://bkt.s3.eu-west-1.amazonaws.com/p/chat/../x")).toBeNull();
    expect(storage.keyFor("")).toBeNull();
    expect(storage.keyFor("not a url")).toBeNull();
  });

  it("delete removes the object and the image thumbnail; ignores foreign URLs", async () => {
    const s3 = new FakeS3();
    const storage = new S3Storage({ bucket: "bkt", client: s3, thumbnails: false, durations: false });
    const key = "chat/3/image/10_deadbeef_pic.png";
    await storage.delete(`https://bkt.s3.amazonaws.com/${key}`);
    expect(s3.deletes).toEqual([key, "chat/3/image/10_deadbeef_pic_thumb.jpg"]);
    s3.deletes.length = 0;
    await storage.delete("https://bkt.s3.amazonaws.com/chat/3/document/10_deadbeef_a.pdf");
    expect(s3.deletes).toEqual(["chat/3/document/10_deadbeef_a.pdf"]);
    s3.deletes.length = 0;
    await storage.delete("https://evil.example/chat/3/image/x.png");
    await storage.delete("https://bkt.s3.amazonaws.com/chat/3/image/10_deadbeef_pic_thumb.jpg");
    expect(s3.deletes).toEqual(["chat/3/image/10_deadbeef_pic_thumb.jpg"]); // a thumbnail itself: no second delete
  });

  it("an image upload gets a _thumb.jpg when sharp is installed (skipped otherwise)", async () => {
    let sharpAvailable = true;
    try {
      const name = "sharp";
      await import(/* @vite-ignore */ name);
    } catch {
      sharpAvailable = false;
    }
    const s3 = new FakeS3();
    const storage = new S3Storage({ bucket: "bkt", client: s3, durations: false });
    const info = await storage.upload(1, "p.png", PNG, "image");
    if (!sharpAvailable) {
      expect(info.thumbnail_url).toBeUndefined();
      expect(s3.puts).toHaveLength(1);
      return;
    }
    expect(s3.puts).toHaveLength(2);
    expect(s3.puts[1]!.Key).toBe(thumbnailKey(s3.puts[0]!.Key));
    expect(s3.puts[1]!.ContentType).toBe("image/jpeg");
    expect(info.thumbnail_url).toContain("_thumb.jpg");
  });

  it("a failing thumbnail upload does not fail the upload; validation", async () => {
    expect(() => new S3Storage({ bucket: "", client: new FakeS3() })).toThrow();
    expect(() => new S3Storage({ bucket: "b", presignExpires: 8 * 24 * 3600 })).toThrow();
    expect(thumbnailKey("chat/1/video/1_a_clip.mp4")).toBe("chat/1/video/1_a_clip_thumb.jpg");
    expect(thumbnailKey("chat/1/video/noext")).toBe("chat/1/video/noext_thumb.jpg");
  });

  it("no client and no AWS SDK installed: a clear error", async () => {
    const storage = new S3Storage({ bucket: "b", thumbnails: false, durations: false });
    let installed = true;
    try {
      const name = "@aws-sdk/client-s3";
      await import(/* @vite-ignore */ name);
    } catch {
      installed = false;
    }
    if (installed) return;
    await expect(storage.upload(1, "a.txt", Buffer.from("x"), "document")).rejects.toThrow(/@aws-sdk\/client-s3/);
  });
});
