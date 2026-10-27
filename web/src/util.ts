/** Small browser helpers (web-only). The formatting / grouping logic lives in the shared engine. */
import { wallpapers } from "commskit/engine";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

/** `/media/x.png` -> `${baseUrl}/media/x.png`; absolute, blob: and data: URLs pass through. */
export const resolveMediaUrl = (url: string | null | undefined, baseUrl?: string): string => {
  if (!url) return "";
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  if (!baseUrl) return url;
  return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
};

/** Reads a blob:/object URL (or any fetchable URL) as base64 without the data-URL prefix. */
export const readUrlAsBase64 = async (uri: string): Promise<string> => {
  const blob = await (await fetch(uri)).blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.readAsDataURL(blob);
  });
};

/** localStorage access that never throws (private mode, blocked storage). */
export const safeLocalStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

/**
 * Downscales an image file so the longest edge is at most `maxEdge` (design: 1600 px) and returns a
 * JPEG data URL. Falls back to the original file as a data URL when decoding fails.
 */
export const downscaleImageFile = async (file: Blob, maxEdge: number = wallpapers.imageMaxEdge, quality = 0.85): Promise<string> => {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
};

// ---- links ---------------------------------------------------------------------------------

export type TextPart = { type: "text"; text: string } | { type: "link"; text: string; href: string };

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

/** Splits text into plain and link parts (http, https and www.; trailing punctuation stays outside the link). */
export const splitLinks = (text: string): TextPart[] => {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let raw = m[1];
    const trail = /[.,;:!?)\]}'"]+$/.exec(raw);
    if (trail) raw = raw.slice(0, raw.length - trail[0].length);
    if (!raw) continue;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "link", text: raw, href: /^www\./i.test(raw) ? `https://${raw}` : raw });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
};

// ---- misc ------------------------------------------------------------------------------------

export const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Saves a URL as a file: fetch -> blob -> object URL (works cross-origin with CORS), else opens it in a new tab. */
export const downloadFile = async (url: string, name?: string | null): Promise<void> => {
  const save = (href: string, revoke: boolean) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = name || "";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10000);
  };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    save(URL.createObjectURL(await res.blob()), true);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
};

export const prefersReducedMotion = (): boolean => {
  try {
    return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
