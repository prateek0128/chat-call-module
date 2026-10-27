// Real-browser E2E: two (three) Chrome contexts talk through the demo server and the built web app.
//   npm run build:web && npm run build && npm run e2e
// Needs Google Chrome (CHROME_PATH or the default Windows path) and backend/backend-python/.venv.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { appDir, startStack } from "./env.mjs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOTS = path.join(appDir, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const FILES = path.join(appDir, "e2e", ".tmp");
mkdirSync(FILES, { recursive: true });

if (!existsSync(path.join(appDir, "dist", "index.html"))) throw new Error("build the example first: npm run build");

// ---- tiny PNG generator (gradient) -----------------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const makePng = (w, h, rgb) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((rgb[0] * x) / w + 40);
      raw[o + 1] = Math.round((rgb[1] * y) / h + 40);
      raw[o + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const photoPath = path.join(FILES, "photo.png");
writeFileSync(photoPath, makePng(320, 200, [180, 120, 200]));
const wallpaperPath = path.join(FILES, "wallpaper.png");
writeFileSync(wallpaperPath, makePng(2400, 1500, [200, 150, 90])); // larger than 1600 px: must be downscaled
const pdfPath = path.join(FILES, "report.pdf");
writeFileSync(pdfPath, "%PDF-1.4\n% commskit e2e test file\n%%EOF\n");
const bigPath = path.join(FILES, "big.bin");
writeFileSync(bigPath, Buffer.alloc(11 * 1024 * 1024, 1));

// ---- tiny test runner ------------------------------------------------------------------------------------
const results = [];
let currentPages = {};
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message || e).split("\n").slice(0, 3).join(" | ") });
    console.log(`FAIL  ${name}\n      ${String(e?.message || e).split("\n").slice(0, 4).join("\n      ")}`);
    for (const [k, p] of Object.entries(currentPages)) {
      try {
        await p.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, "_").slice(0, 40)}-${k}.png`) });
      } catch {
        /* page gone */
      }
    }
  }
};
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout: ${what}${last ? ` (${last.message})` : ""}`);
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// ---- helpers -------------------------------------------------------------------------------------------------
const msg = (page, text) => page.locator(".ck-msg-row", { hasText: text }).last();
const composer = (page) => page.getByRole("textbox", { name: "Message" });
const sendText = async (page, text) => {
  await composer(page).fill(text);
  await composer(page).press("Enter");
};
const row = (page, name) => page.getByRole("option", { name: new RegExp(`^${name}`) });
const signIn = async (page, app, who, open) => {
  await page.goto(`${app}/?user=${who}${open ? `&open=${open}` : ""}`);
  await page.getByRole("heading", { name: "Chats" }).waitFor();
};
const tickOf = (page, text) => msg(page, text).locator(".ck-ticks").getAttribute("data-state");
const menuItem = (page, name) => page.getByRole("menuitem", { name });
const openMessageMenu = async (page, text) => {
  await msg(page, text).locator(".ck-bubble").click({ button: "right" });
  await page.getByRole("menu", { name: "Message actions" }).waitFor();
};
const openChatMenu = async (page) => {
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menu", { name: "Chat options" }).waitFor();
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

// ---------------------------------------------------------------------------------------------------------------
const stack = await startStack({ features: "chat" });
console.log(`demo server ${stack.serverUrl}  web app ${stack.appUrl}  data ${stack.dataDir}`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

const newCtx = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebSocket connection|net::ERR/.test(m.text()) && errors.push(m.text()));
  page.errors = errors;
  return { ctx, page };
};

const A = await newCtx({ permissions: ["notifications"] });
const B = await newCtx();
const C = await newCtx();
const [a, b, c] = [A.page, B.page, C.page];
// record desktop notifications in Alice's page (real Notification objects are not observable in headless Chrome)
await A.ctx.addInitScript(() => {
  const Real = window.Notification;
  window.__notes = [];
  function Fake(title, options) {
    const n = { title, options, closed: false, close() { this.closed = true; }, onclick: null };
    window.__notes.push(n);
    return n;
  }
  Fake.permission = Real.permission;
  Fake.requestPermission = () => Real.requestPermission();
  window.Notification = Fake;
});
currentPages = { alice: a, bob: b };

try {
  await step("login: demo users load, sign in as Alice, Bob and Carol", async () => {
    await a.goto(`${stack.appUrl}/`);
    await a.getByRole("button", { name: /Sign in as Alice/ }).click();
    await a.getByRole("heading", { name: "Chats" }).waitFor();
    await signIn(b, stack.appUrl, "U2");
    await signIn(c, stack.appUrl, "U3");
    await a.getByText("No chats yet").waitFor();
    await a.screenshot({ path: path.join(SHOTS, "01-alice-empty-1280.png") });
  });

  await step("open chat via New chat; first message; Bob sees row, unread badge and in-app banner", async () => {
    await a.getByRole("button", { name: "New chat" }).click();
    await a.getByRole("button", { name: "Chat with Bob" }).click();
    await a.getByRole("heading", { name: "Bob" }).waitFor();
    await sendText(a, "hello bob https://example.com/page.");
    await until(async () => (await tickOf(a, "hello bob")) === "delivered", "Alice sees ✓✓ delivered");
    const rowB = row(b, "Alice");
    await rowB.waitFor();
    eq((await rowB.getAttribute("aria-label")).includes("1 unread"), true, "unread count in row label");
    eq(await rowB.locator(".ck-badge").innerText(), "1", "unread badge text");
    await b.getByRole("status").filter({ hasText: "hello bob" }).first().waitFor(); // in-app banner
    const link = msg(a, "hello bob").locator("a.ck-link");
    eq(await link.getAttribute("href"), "https://example.com/page", "link href (trailing dot stays outside)");
    eq((await link.getAttribute("rel")).includes("noopener"), true, "link rel noopener");
  });

  await step("Bob opens the chat: message arrives, ticks turn read on Alice's side", async () => {
    await rowB().click();
    await b.getByRole("heading", { name: "Alice" }).waitFor();
    await msg(b, "hello bob").waitFor();
    await until(async () => (await tickOf(a, "hello bob")) === "read", "Alice sees read ticks");
    await until(async () => (await b.getByRole("option", { name: /^Alice/ }).locator(".ck-badge").count()) === 0, "badge cleared");
    function rowB() { return row(b, "Alice"); }
  });

  await step("text both ways + optimistic send", async () => {
    await sendText(b, "hi alice, got it");
    await msg(a, "hi alice, got it").waitFor();
    await sendText(a, "great, thanks");
    await msg(b, "great, thanks").waitFor();
    // Shift+Enter makes a newline instead of sending
    await composer(a).fill("line one");
    await composer(a).press("Shift+Enter");
    await composer(a).type("line two");
    eq(await composer(a).inputValue(), "line one\nline two", "Shift+Enter newline");
    await composer(a).press("Enter");
    await msg(b, "line two").waitFor();
    eq(await msg(b, "line two").locator(".ck-text").innerText(), "line one\nline two", "multi-line text");
  });

  await step("typing indicator: header + bubble on the other side, clears after idle", async () => {
    await composer(b).pressSequentially("typing something", { delay: 20 });
    await a.locator(".ck-header-status", { hasText: "typing…" }).waitFor();
    await a.getByRole("status", { name: /Bob is typing/ }).waitFor();
    await composer(b).fill("");
    await until(async () => !(await a.locator(".ck-header-status", { hasText: "typing…" }).count()), "typing clears", 9000);
  });

  await step("search matches names AND last-message text; unread filter with counts", async () => {
    // Carol writes to Alice: new chat, unread 1
    await c.getByRole("button", { name: "New chat" }).click();
    await c.getByRole("button", { name: "Chat with Alice" }).click();
    await sendText(c, "lunch tomorrow?");
    await row(a, "Carol").waitFor();
    await a.getByRole("button", { name: /Unread, 1 chat/ }).waitFor();
    await a.getByRole("button", { name: /Unread, 1 chat/ }).click();
    eq(await a.getByRole("option").count(), 1, "only the unread chat");
    await a.getByRole("button", { name: "All" }).click();
    eq(await a.getByRole("option").count(), 2, "both chats");
    await a.getByRole("searchbox", { name: "Search chats" }).fill("lunch");
    eq(await a.getByRole("option").count(), 1, "search by last message text");
    eq((await a.getByRole("option").first().getAttribute("aria-label")).startsWith("Carol"), true, "matches Carol");
    await a.getByRole("searchbox", { name: "Search chats" }).fill("bo");
    eq((await a.getByRole("option").first().getAttribute("aria-label")).startsWith("Bob"), true, "search by name");
    await a.getByRole("searchbox", { name: "Search chats" }).fill("zzz");
    await a.getByText("No chats match").waitFor();
    await a.getByRole("searchbox", { name: "Search chats" }).fill("");
    // arrow-key navigation
    await a.getByRole("option").first().focus();
    await a.keyboard.press("ArrowDown");
    eq(await a.evaluate(() => document.activeElement?.getAttribute("role")), "option", "arrow key keeps focus on a row");
  });

  await step("desktop notification: hidden tab + message from another chat; click opens it", async () => {
    eq(await a.evaluate(() => Notification.permission), "granted", "permission granted via context");
    await a.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sendText(c, "are you free later?");
    const note = await until(() => a.evaluate(() => window.__notes.find((n) => /Carol/.test(n.title))?.options?.body), "notification for Carol");
    eq(note.includes("free later"), true, "notification body");
    await a.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.__notes.find((n) => /Carol/.test(n.title)).onclick();
    });
    await a.getByRole("heading", { name: "Carol" }).waitFor();
    await msg(a, "are you free later?").waitFor();
    await row(a, "Bob").click();
    await a.getByRole("heading", { name: "Bob" }).waitFor();
  });

  await step("reply with quote, jump to the quoted message highlights it", async () => {
    await openMessageMenu(a, "hi alice, got it");
    await menuItem(a, "Reply").click();
    await a.getByText("Replying to Bob").waitFor();
    await sendText(a, "this is my reply");
    const quote = msg(a, "this is my reply").locator(".ck-quote");
    await quote.waitFor();
    eq((await quote.innerText()).includes("hi alice, got it"), true, "quote text");
    await msg(b, "this is my reply").locator(".ck-quote").waitFor();
    // push the original out of view, then jump
    for (let i = 0; i < 25; i++) await a.getByRole("textbox", { name: "Message" }).fill(`filler message number ${i}`), await composer(a).press("Enter");
    await msg(a, "filler message number 24").waitFor();
    await quote.click();
    const original = a.locator(".ck-msg-row", { hasText: "hi alice, got it", hasNot: a.locator(".ck-quote") });
    await until(async () => (await original.getAttribute("class")).includes("is-highlighted"), "quoted message highlighted");
  });

  await step("send an image and a file; thumbnails, file card, download link; 10 MB check", async () => {
    await a.getByRole("button", { name: "Attach file" }).click();
    await a.getByRole("menuitem", { name: "Gallery" }).click();
    await a.locator('[data-testid="file-gallery"]').setInputFiles(photoPath);
    await a.getByRole("dialog", { name: "Send attachment" }).waitFor();
    await new Promise((r) => setTimeout(r, 400));
    await a.screenshot({ path: path.join(SHOTS, "02-attachment-preview.png") });
    await a.getByRole("button", { name: "Send", exact: true }).click();
    const img = b.locator('img.ck-thumb[alt="photo.png"]').last();
    await img.waitFor();
    await until(() => img.evaluate((el) => el.complete && el.naturalWidth === 320), "image loads on Bob's side (served via /media)");
    // lightbox with Download
    await img.click();
    await b.getByRole("dialog", { name: /Photo photo.png/ }).waitFor();
    await b.getByRole("link", { name: /Download/ }).waitFor();
    await new Promise((r) => setTimeout(r, 400)); // let the open animation finish
    await b.screenshot({ path: path.join(SHOTS, "03-lightbox.png") });
    await b.keyboard.press("Escape");
    // file
    await a.locator('[data-testid="file-document"]').setInputFiles(pdfPath);
    await a.getByRole("button", { name: "Send", exact: true }).click();
    const card = b.locator(".ck-file-card", { hasText: "report.pdf" }).last();
    await card.waitFor();
    eq(await card.locator(".ck-doc-badge").innerText(), "PDF", "PDF badge");
    eq(await card.locator(".ck-doc-badge").getAttribute("data-color"), "danger", "PDF badge colour token");
    const href = await card.getByRole("link", { name: /Download report.pdf/ }).getAttribute("href");
    eq(/\/media\/.+\.pdf$|\/media\//.test(href), true, `download href is a media URL (${href})`);
    eq(await card.getByRole("link", { name: /Download/ }).getAttribute("download"), "report.pdf", "download attribute");
    // the 10 MB limit is checked before upload
    await a.locator('[data-testid="file-document"]').setInputFiles(bigPath);
    await a.getByText(/too large/i).first().waitFor();
    eq(await a.getByRole("dialog", { name: "Send attachment" }).count(), 0, "no preview for oversize file");
  });

  await step("appearance: theme, dark mode, uploaded wallpaper (downscaled) persist after reload", async () => {
    await a.getByRole("button", { name: "Appearance" }).click();
    const dlg = a.getByRole("dialog", { name: "Appearance" });
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "Rose theme" }).click();
    await dlg.getByRole("radio", { name: "Dark" }).click();
    await dlg.locator('[data-testid="wallpaper-file"]').setInputFiles(wallpaperPath);
    await dlg.getByRole("button", { name: "Your picture wallpaper" }).waitFor();
    await dlg.getByRole("slider", { name: "Dim" }).fill("0.4");
    await new Promise((r) => setTimeout(r, 400));
    await a.screenshot({ path: path.join(SHOTS, "04-appearance-sheet.png") });
    await dlg.getByRole("button", { name: "Done" }).click();
    const stored = await a.evaluate(() => JSON.parse(localStorage.getItem("commskit.appearance.v1")));
    eq(stored.preset, "rose", "stored preset");
    eq(stored.mode, "dark", "stored mode");
    eq(stored.wallpaper.kind, "image", "stored wallpaper kind");
    const dims = await a.evaluate(
      () =>
        new Promise((res) => {
          const i = new Image();
          i.onload = () => res([i.naturalWidth, i.naturalHeight]);
          i.src = JSON.parse(localStorage.getItem("commskit.appearance.v1")).wallpaper.uri;
        }),
    );
    eq(Math.max(...dims) <= 1600, true, `wallpaper downscaled to <=1600 (got ${dims})`);
    await a.reload();
    await a.getByRole("heading", { name: "Chats" }).waitFor();
    eq(await a.locator(".ck-root").getAttribute("data-ck-preset"), "rose", "preset after reload");
    eq(await a.locator(".ck-root").getAttribute("data-ck-scheme"), "dark", "scheme after reload");
    eq(await a.evaluate(() => getComputedStyle(document.querySelector(".ck-root")).getPropertyValue("--ck-accent").trim().toLowerCase()), "#fb7185", "rose dark accent token");
    await row(a, "Bob").click();
    await a.locator('.ck-chat .ck-wallpaper[data-kind="image"]').waitFor();
    // history paging: only the first page is loaded after the reload; scrolling to the top loads older messages and keeps the position
    const rowsBefore = await a.locator(".ck-msg-row").count();
    const firstId = await a.locator(".ck-msg-row").first().getAttribute("data-msg-id");
    await a.locator(".ck-messages").evaluate((el) => (el.scrollTop = 0));
    await until(async () => (await a.locator(".ck-msg-row").count()) > rowsBefore, "older messages load when scrolled to the top", 10000);
    await new Promise((r) => setTimeout(r, 300));
    const offset = await a.evaluate((id) => {
      const el = document.querySelector(`[data-msg-id="${id}"]`);
      const box = document.querySelector(".ck-messages").getBoundingClientRect();
      return el ? el.getBoundingClientRect().top - box.top : null;
    }, firstId);
    eq(offset !== null && offset > -5 && offset < 500, true, `scroll position kept after prepending (offset ${offset})`);
    await a.screenshot({ path: path.join(SHOTS, "05-dark-rose-wallpaper-1280.png") });
    // per-chat override from the chat menu
    await openChatMenu(a);
    await a.getByRole("menuitem", { name: "Wallpaper" }).click();
    const d2 = a.getByRole("dialog", { name: "Appearance" });
    await d2.getByRole("button", { name: "Gradient 2 wallpaper" }).click();
    await d2.getByRole("button", { name: "Done" }).click();
    await a.locator('.ck-chat .ck-wallpaper[data-kind="gradient"]').waitFor();
    await row(a, "Carol").click();
    await a.locator('.ck-chat .ck-wallpaper[data-kind="image"]').waitFor(); // other chat keeps the global wallpaper
    await row(a, "Bob").click();
  });

  await step("unsend for everyone, delete for me, clear chat", async () => {
    await sendText(b, "ping from bob");
    await msg(a, "ping from bob").waitFor();
    await sendText(a, "to be unsent");
    await msg(b, "to be unsent").waitFor();
    await openMessageMenu(a, "to be unsent");
    await menuItem(a, "Delete for everyone").click();
    await a.getByRole("dialog", { name: "Delete for everyone?" }).getByRole("button", { name: "Delete for everyone" }).click();
    await msg(a, "You deleted this message").waitFor();
    await msg(b, "This message was deleted").waitFor();
    // delete for me on Bob's side leaves Alice's copy
    await sendText(a, "only bob deletes this");
    await msg(b, "only bob deletes this").waitFor();
    await openMessageMenu(b, "only bob deletes this");
    await menuItem(b, "Delete for me").click();
    await until(async () => !(await b.locator(".ck-msg-row", { hasText: "only bob deletes this" }).count()), "gone for Bob");
    eq(await a.locator(".ck-msg-row", { hasText: "only bob deletes this" }).count(), 1, "still there for Alice");
    // Delete for everyone is not offered on incoming messages
    await openMessageMenu(a, "ping from bob");
    eq(await menuItem(a, "Delete for everyone").count(), 0, "no unsend on incoming message");
    await a.keyboard.press("Escape");
    // clear chat on Bob's side only
    await b.getByRole("button", { name: "More options" }).click();
    await b.getByRole("menuitem", { name: "Clear chat" }).click();
    await b.getByRole("dialog", { name: "Clear this chat?" }).getByRole("button", { name: "Clear chat" }).click();
    await b.getByText("Say hi").waitFor();
    eq(await a.locator(".ck-msg-row").count() > 5, true, "Alice keeps her messages");
  });

  await step("block / unblock: blocked composer on both sides", async () => {
    await openChatMenu(a);
    await a.getByRole("menuitem", { name: "Block" }).click();
    await a.getByRole("dialog", { name: "Block Bob?" }).getByRole("button", { name: "Block" }).click();
    await a.getByText("You blocked Bob.").waitFor();
    await a.locator(".ck-header-status", { hasText: "Blocked" }).waitFor();
    await b.getByText("You can't reply to this conversation").waitFor();
    await b.locator(".ck-header-status", { hasText: "You are blocked" }).waitFor();
    await a.screenshot({ path: path.join(SHOTS, "06-blocked-composer.png") });
    await a.getByRole("button", { name: "Unblock Bob" }).click();
    await composer(a).waitFor();
    await b.getByRole("textbox", { name: "Message" }).waitFor();
  });

  await step("report flow: 7 categories, details, also-block option, confirmation toast", async () => {
    await openChatMenu(a);
    await a.getByRole("menuitem", { name: "Report" }).click();
    const dlg = a.getByRole("dialog", { name: "Report Bob" });
    await dlg.waitFor();
    eq(await dlg.getByRole("radio").count(), 7, "7 categories");
    eq(await dlg.getByRole("button", { name: "Report", exact: true }).isDisabled(), true, "disabled until a category is chosen");
    await dlg.getByRole("radio", { name: "Spam" }).check();
    await dlg.getByRole("textbox").fill("sends spam links");
    await dlg.getByRole("checkbox", { name: /Also block Bob/ }).uncheck();
    await new Promise((r) => setTimeout(r, 400));
    await a.screenshot({ path: path.join(SHOTS, "07-report-sheet.png") });
    await dlg.getByRole("button", { name: "Report", exact: true }).click();
    await a.getByText("Reported Bob").waitFor();
    // report a single message from the menu (incoming message)
    await openMessageMenu(a, "ping from bob");
    await menuItem(a, "Report message").click();
    await a.getByRole("dialog", { name: "Report message" }).getByRole("button", { name: "Cancel" }).click();
  });

  await step("responsive screenshots: 390x844, 768x1024, 1280x800 and no horizontal overflow at 320", async () => {
    const shot = async (page, w, h, name, fn) => {
      await page.setViewportSize({ width: w, height: h });
      if (fn) await fn();
      await new Promise((r) => setTimeout(r, 400));
      eq(await noOverflow(page), true, `no horizontal overflow ${w}x${h} ${name}`);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${w}x${h}.png`) });
    };
    // phone: chat open -> single pane with a back button; then the list
    await shot(a, 390, 844, "10-phone-chat");
    await a.getByRole("button", { name: "Back to chats" }).waitFor();
    await a.getByRole("button", { name: "Back to chats" }).click();
    await shot(a, 390, 844, "11-phone-list");
    await row(a, "Bob").click();
    await shot(a, 768, 1024, "12-tablet-split");
    eq(await a.locator(".ck-app").getAttribute("data-layout"), "split", "tablet is split");
    await shot(a, 1280, 800, "13-desktop");
    await shot(a, 320, 568, "14-narrow-chat");
    await a.getByRole("button", { name: "Back to chats" }).click();
    await shot(a, 320, 568, "15-narrow-list");
    await a.setViewportSize({ width: 1280, height: 800 });
    await row(a, "Bob").click();
  });

  await step("reconnect: server restart shows the banner, then recovers and messages flow", async () => {
    stack.stopServer();
    await a.getByRole("status").filter({ hasText: /Connecting|Offline/ }).first().waitFor({ timeout: 15000 });
    await a.screenshot({ path: path.join(SHOTS, "16-reconnecting-banner.png") });
    await new Promise((r) => setTimeout(r, 1500));
    await stack.startServer();
    // let the automatic retry (or the Retry button) bring it back
    await until(async () => {
      const retry = a.getByRole("button", { name: "Retry", exact: true });
      if (await retry.count()) await retry.click().catch(() => {});
      return !(await a.locator(".ck-connection").count());
    }, "banner gone after the server is back", 40000);
    await sendText(b, "back online?");
    await msg(a, "back online?").waitFor({ timeout: 15000 });
    await sendText(a, "yes, recovered");
    await msg(b, "yes, recovered").waitFor({ timeout: 15000 });
  });

  await step("no page errors in the browser consoles", async () => {
    const all = [...a.errors, ...b.errors, ...c.errors];
    eq(all.length, 0, `console errors: ${all.slice(0, 3).join(" | ")}`);
  });
} finally {
  await browser.close().catch(() => {});
  stack.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E steps passed; screenshots in ${SHOTS}`);
if (failed.length) {
  console.log("server log tail:\n" + stack.logs.join("").split("\n").slice(-15).join("\n"));
  process.exit(1);
}
