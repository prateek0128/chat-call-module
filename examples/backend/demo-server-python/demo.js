/* Comms kit browser demo: sign in, connection, conversation list, thread, composer.
 * Speaks docs/archive/PROTOCOL.md. Calls live in demo-call.js, which is only loaded when the server has
 * the call feature (a chat-only server never loads WebRTC / getUserMedia code).
 * No dependencies, no build step. */
(() => {
"use strict";

// ================================================================ state + small helpers
const $ = (id) => document.getElementById(id);
const PAGE = 30;                       // get_messages page size
const GROUP_MS = 5 * 60 * 1000;        // same sender within 5 min = one group
const MAX_FILE = 10 * 1024 * 1024;     // media_upload limit (decoded)

const S = {
  me: null, token: null, ws: null, features: [], serverFeatures: [], mode: "both", users: [],
  convos: {},                          // peerId -> {chat_id, last_message, unread_count, updated_at}
  online: {}, typing: {},
  peer: null, chatId: null,
  listReady: false, listError: null,
  call: null,                          // owned by demo-call.js
  retry: 0, closing: false, retryTimer: null, retryAt: 0, connState: "offline",
  openWhenConnected: null,
  thread: newThread(),
};
function newThread() {
  return {
    msgs: new Map(),                   // id -> MessageDto
    order: [],                         // rendered ids, ascending
    pending: [],                       // optimistic text sends: {key, content, node, timer, failed}
    early: [],                         // live messages that arrived before the first page
    loaded: false, reload: false, hasMore: false, loadingOlder: false,
    newCount: 0, error: null,
  };
}

const hasChat = () => S.features.includes("chat");
const hasCall = () => S.features.includes("call");
const nameOf = (id) => (S.users.find((u) => u.id === id) || {}).name || id;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, cls = "", label = "") =>
  `<svg class="${cls}"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}><use href="#i-${id}"/></svg>`;
const isPhone = () => window.matchMedia("(max-width: 699.98px)").matches;
const finePointer = () => window.matchMedia("(pointer: fine)").matches; // auto-focus only where it won't pop a keyboard
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isCallMsg = (m) => /_call$/.test(m.message_type || "");

// Server timestamps are UTC without a zone suffix.
const toDate = (s) => (s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z") : null);
const hhmm = (d) => (d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(d) {
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], { weekday: sameYear ? "short" : undefined, day: "numeric", month: "long", year: sameYear ? undefined : "numeric" });
}
function listTime(s) {
  const d = toDate(s); if (!d) return "";
  const label = dayLabel(d);
  if (label === "Today") return hhmm(d);
  if (label === "Yesterday") return label;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}
const fmtSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fileKind = (name, type) => {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name || "");
  return ext ? ext[1].toUpperCase() : String(type || "").split("/").pop().toUpperCase();
};
const fmtDuration = (secs) => {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
function avatarHtml(id, size = 48, { presence = false } = {}) {
  const idx = [...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 8;
  const initial = esc((nameOf(id) || "?").trim().slice(0, 1).toUpperCase());
  const dot = presence && S.online[id] ? '<span class="presence"></span>' : "";
  return `<span class="avatar s${size}" style="--av: var(--avatar-${idx})" aria-hidden="true">${initial}${dot}</span>`;
}
function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}

// ---------------------------------------------------------------- announcements + toasts
function announce(text, urgent = false) {
  const el = $(urgent ? "announcerAlert" : "announcer");
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 30);
}
function toast(text, { kind = "info", ms = 3200 } = {}) {
  const box = $("toasts");
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  t.innerHTML = `${icon(kind === "error" ? "alert" : "chat")}<span></span>`;
  t.querySelector("span").textContent = text;
  box.appendChild(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), reducedMotion() ? 0 : 220);
  }, ms);
}

// ================================================================ theme (auto / light / dark, stored)
const THEME_KEY = "commsDemo.theme";
const THEMES = ["auto", "light", "dark"];
function storedTheme() { try { const t = localStorage.getItem(THEME_KEY); return THEMES.includes(t) ? t : "auto"; } catch { return "auto"; } }
// The sign-in card keeps a quick cycle button (.theme-btn); in the app, Mode lives in the Appearance sheet.
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
  const ic = t === "auto" ? "auto" : t === "light" ? "sun" : "moon";
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.innerHTML = icon(ic);
    b.setAttribute("aria-label", `Theme: ${t}. Switch to ${next}`);
    b.title = `Theme: ${t}`;
  });
  syncThemeColor();
}
function setTheme(t) {
  try { if (t === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* storage blocked */ }
  themeOverride = t;
  crossFade(() => applyTheme(t));
  if (!$("appearance").hidden) Appearance.renderSheet();
}
function cycleTheme() { setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]); }
let themeOverride = null; // used when storage is unavailable
const currentTheme = () => themeOverride || storedTheme();
// <meta name="theme-color"> follows the current surface (both the light and the dark entry, so a forced mode wins).
function syncThemeColor() {
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  if (surface) document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", surface));
}
// Theme changes cross-fade colours over motion.duration.base; instant under reduced motion.
let fadeTimer = null;
function crossFade(change) {
  const root = document.documentElement;
  if (reducedMotion()) { change(); return; }
  root.classList.add("ap-fade");
  void root.offsetWidth; // start transitions from the current colours
  change();
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => root.classList.remove("ap-fade"), 260);
}

// ================================================================ appearance: chat theme presets + wallpapers
// Local preferences only (DESIGN_SYSTEM.md → "Appearance"): nothing is sent to the server or the other person.
// Values come from tokens.json (themePresets, wallpapers) via demo.css; test_tokens.py checks both.
const AP_KEY = "commsDemo.appearance";          // {preset, wallpaper, chats: {peerId: wallpaper}}
const AP_IMAGE_KEY = "commsDemo.appearance.image"; // the custom image as a JPEG data URL
const PRESETS = ["indigo", "rose", "emerald", "ocean", "amber", "violet", "graphite"];
const PRESET_LABELS = { indigo: "Indigo", rose: "Rose", emerald: "Emerald", ocean: "Ocean", amber: "Amber", violet: "Violet", graphite: "Graphite" };
const WP_SOLIDS = 8, WP_GRADIENTS = 5;
const IMAGE_DIM_MAX = 0.8, IMAGE_MAX_EDGE = 1600, IMAGE_JPEG_QUALITY = 0.82;
const DEFAULT_WP = Object.freeze({ kind: "default" });

const Appearance = {
  st: { preset: "indigo", wallpaper: DEFAULT_WP, chats: {} },
  image: null,          // data URL from storage, or kept in memory only when storage is full
  peer: null,           // sheet opened from this chat (per-chat mode), else null (global)
  scope: "all",         // "chat" | "all" while the sheet is open

  // -- state ---------------------------------------------------------------
  cleanWp(w) {
    if (!w || typeof w !== "object") return null;
    const idx = (n, max) => Number.isInteger(n) && n >= 0 && n < max;
    if (w.kind === "default") return DEFAULT_WP;
    if (w.kind === "solid" && idx(w.index, WP_SOLIDS)) return { kind: "solid", index: w.index };
    if (w.kind === "gradient" && idx(w.index, WP_GRADIENTS)) return { kind: "gradient", index: w.index };
    if (w.kind === "image") {
      const out = { kind: "image" };
      if (typeof w.dim === "number" && w.dim >= 0 && w.dim <= IMAGE_DIM_MAX) out.dim = w.dim;
      return out;
    }
    return null;
  },
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(AP_KEY) || "null");
      if (raw && typeof raw === "object") {
        if (PRESETS.includes(raw.preset)) this.st.preset = raw.preset;
        this.st.wallpaper = this.cleanWp(raw.wallpaper) || DEFAULT_WP;
        for (const [peer, w] of Object.entries(raw.chats && typeof raw.chats === "object" ? raw.chats : {})) {
          const c = this.cleanWp(w); if (c) this.st.chats[peer] = c;
        }
      }
    } catch { /* storage blocked or bad JSON: defaults */ }
    try { this.image = localStorage.getItem(AP_IMAGE_KEY); } catch { this.image = null; }
  },
  save() { try { localStorage.setItem(AP_KEY, JSON.stringify(this.st)); } catch { /* storage blocked: kept for this session */ } },
  forChat(peer) { return (peer && this.st.chats[peer]) || this.st.wallpaper; },
  // The wallpaper the sheet is editing.
  target() { return this.peer && this.scope === "chat" ? this.forChat(this.peer) : this.st.wallpaper; },
  usable(w) { return w.kind === "image" && !this.image ? DEFAULT_WP : w; },

  // -- applying ------------------------------------------------------------
  applyPreset() {
    document.documentElement.dataset.preset = this.st.preset;
    syncThemeColor();
  },
  paint(el, wp) {
    const w = this.usable(wp);
    el.dataset.wp = w.kind;
    for (const p of ["--wp-bg", "--wp-img", "--wp-dim"]) el.style.removeProperty(p);
    if (w.kind === "solid") el.style.setProperty("--wp-bg", `var(--wp-solid-${w.index})`);
    else if (w.kind === "gradient") el.style.setProperty("--wp-bg", `var(--wp-grad-${w.index})`);
    else if (w.kind === "image") {
      el.style.setProperty("--wp-img", `url("${this.image}")`);
      if (typeof w.dim === "number") el.style.setProperty("--wp-dim", String(w.dim));
    }
  },
  applyChat() { this.paint($("scroller"), this.forChat(S.peer)); },

  // -- changes from the sheet ----------------------------------------------
  setPreset(id) {
    if (!PRESETS.includes(id) || id === this.st.preset) return;
    this.st.preset = id; this.save();
    crossFade(() => this.applyPreset());
    this.renderSheet();
    announce(`${PRESET_LABELS[id]} theme`);
  },
  setWallpaper(wp) {
    if (this.peer && this.scope === "chat") this.st.chats[this.peer] = wp;
    else {
      this.st.wallpaper = wp;
      if (this.peer) delete this.st.chats[this.peer]; // "All chats" from a chat: this chat follows the default again
    }
    this.save(); this.applyChat(); this.renderSheet();
  },
  setDim(v) {
    const t = this.target();
    if (t.kind !== "image") return;
    this.setWallpaper({ kind: "image", dim: Math.min(IMAGE_DIM_MAX, Math.max(0, Math.round(v * 100) / 100)) });
  },
  resetChat() {
    if (!this.peer || !this.st.chats[this.peer]) return;
    delete this.st.chats[this.peer];
    this.save(); this.applyChat(); this.renderSheet();
    announce("This chat now uses the default wallpaper");
  },
  async importImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "")) { toast(`"${file.name}" isn't an image. Choose a photo or picture.`, { kind: "error", ms: 4500 }); return; }
    let url;
    try { url = await downscaleImage(file); }
    catch { toast(`Couldn't open "${file.name}" as an image.`, { kind: "error", ms: 4500 }); return; }
    this.image = url;
    let saved = true;
    try { localStorage.setItem(AP_IMAGE_KEY, url); } catch { saved = false; }
    this.buildWallTiles();
    this.setWallpaper({ kind: "image" });
    if (!saved) toast("Couldn't save the image on this device; it will reset when you reload.", { ms: 6000 });
    else announce("Image wallpaper set");
    $("apWalls").querySelector('[data-kind="image"]')?.focus({ preventScroll: true });
  },

  // -- the sheet -------------------------------------------------------------
  open(peer) {
    this.peer = peer && hasChat() ? peer : null;
    this.scope = this.peer ? "chat" : "all";
    $("apWallSec").hidden = !hasChat();       // call-only mode has no message area
    $("apScopeSec").hidden = !this.peer;
    this.buildStatic();
    this.buildWallTiles();
    this.renderSheet();
    const first = () => (this.peer ? $("apWalls").querySelector('[aria-checked="true"]') : $("apMode").querySelector('[aria-checked="true"]'));
    openLayer($("appearance"), { initialFocus: first, onEscape: () => this.close() });
  },
  close() { closeLayer($("appearance")); },
  buildStatic() {
    $("apMode").innerHTML = THEMES.map((t) =>
      `<button type="button" role="radio" data-scheme="${t}">${icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon")}<span>${t[0].toUpperCase() + t.slice(1)}</span></button>`).join("");
    $("apThemes").innerHTML = PRESETS.map((p) =>
      `<button type="button" role="radio" class="swatch" data-preset="${p}" aria-label="${PRESET_LABELS[p]} theme" title="${PRESET_LABELS[p]}"><span class="sw">${icon("check")}</span></button>`).join("");
  },
  buildWallTiles() {
    const tile = (kind, index, label) =>
      `<button type="button" role="radio" class="wp-tile wall${kind === "image" ? " wp-image" : ""}" data-kind="${kind}"${index != null ? ` data-index="${index}"` : ""} aria-label="${label}" title="${label}"><span class="wp-check">${icon("check")}</span></button>`;
    let html = tile("default", null, "Default wallpaper");
    for (let i = 0; i < WP_SOLIDS; i++) html += tile("solid", i, `Solid colour ${i + 1}`);
    for (let i = 0; i < WP_GRADIENTS; i++) html += tile("gradient", i, `Gradient ${i + 1}`);
    if (this.image) html += tile("image", null, "Your image");
    const box = $("apWalls");
    box.innerHTML = html;
    box.querySelectorAll(".wp-tile").forEach((b) => {
      const kind = b.dataset.kind;
      this.paint(b, kind === "default" ? DEFAULT_WP : kind === "image" ? { kind: "image" } : { kind, index: +b.dataset.index });
    });
  },
  renderSheet() {
    const mode = currentTheme();
    $("apMode").querySelectorAll("[role=radio]").forEach((b) => setRadio(b, b.dataset.scheme === mode));
    $("apThemes").querySelectorAll("[role=radio]").forEach((b) => setRadio(b, b.dataset.preset === this.st.preset));
    $("apScope").querySelectorAll("[role=radio]").forEach((b) => setRadio(b, b.dataset.scope === this.scope));
    const t = this.usable(this.target());
    $("apWalls").querySelectorAll("[role=radio]").forEach((b) =>
      setRadio(b, b.dataset.kind === t.kind && (b.dataset.index == null || +b.dataset.index === t.index)));
    this.paint($("apPreview"), t);
    const isImage = t.kind === "image" && hasChat();
    $("apDimSec").hidden = !isImage;
    if (isImage) {
      const dflt = parseFloat(getComputedStyle($("apPreview")).getPropertyValue("--wp-dim-default")) || 0;
      const v = typeof t.dim === "number" ? t.dim : dflt;
      $("apDim").value = String(v);
      $("apDimOut").textContent = `${Math.round(v * 100)}%`;
      $("apDim").setAttribute("aria-valuetext", `${Math.round(v * 100)} percent`);
    }
    $("apReset").disabled = !(this.peer && this.st.chats[this.peer]);
  },
};

function setRadio(b, on) {
  b.setAttribute("aria-checked", String(on));
  b.tabIndex = on ? 0 : -1;
}
// Arrow keys / Home / End move the selection in a radiogroup (selection follows focus).
function radioKeys(group, pick) {
  group.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    const radios = [...group.querySelectorAll("[role=radio]")];
    const i = radios.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (i + step + radios.length) % radios.length;
    pick(radios[n]);
    radios[n].focus();
  });
  group.addEventListener("click", (e) => { const b = e.target.closest("[role=radio]"); if (b && group.contains(b)) pick(b); });
}
// Decode, downscale so the longest edge is at most IMAGE_MAX_EDGE, re-encode as JPEG.
async function downscaleImage(file) {
  let src, w, h, cleanup = () => {};
  if (window.createImageBitmap) {
    src = await createImageBitmap(file);
    w = src.width; h = src.height; cleanup = () => src.close?.();
  } else {
    const url = URL.createObjectURL(file);
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    w = src.naturalWidth; h = src.naturalHeight; cleanup = () => URL.revokeObjectURL(url);
  }
  try {
    if (!w || !h) throw new Error("empty image");
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height); // JPEG has no alpha
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
  } finally { cleanup(); }
}

// ---------------------------------------------------------------- chat header overflow menu
function openChatMenu() {
  const btn = $("moreBtn"), layer = $("chatMenu"), menu = $("chatMenuList");
  $("menuWallpaper").hidden = !hasChat();
  const r = btn.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  btn.setAttribute("aria-expanded", "true");
  const items = () => [...menu.querySelectorAll("[role=menuitem]")].filter((b) => !b.hidden);
  openLayer(layer, { initialFocus: () => items()[0], onEscape: closeChatMenu });
}
function closeChatMenu(returnFocus = true) {
  $("moreBtn").setAttribute("aria-expanded", "false");
  closeLayer($("chatMenu"), returnFocus ? $("moreBtn") : undefined);
}
function onChatMenuKey(e) {
  const items = [...$("chatMenuList").querySelectorAll("[role=menuitem]")].filter((b) => !b.hidden);
  const i = items.indexOf(document.activeElement);
  let n = null;
  if (e.key === "ArrowDown") n = (i + 1) % items.length;
  else if (e.key === "ArrowUp") n = (i - 1 + items.length) % items.length;
  else if (e.key === "Home") n = 0;
  else if (e.key === "End") n = items.length - 1;
  else if (e.key === "Tab") { e.preventDefault(); closeChatMenu(); return; }
  if (n !== null) { e.preventDefault(); items[n].focus(); }
}

// ================================================================ mode: chat only / calls only / both
// Picked in the page (?mode=chat|call|both, remembered), limited to what the server runs
// (COMMS_FEATURES). Switching reloads, so chat-only really never loads demo-call.js.
const MODE_KEY = "commsDemo.mode";
const MODES = [
  { id: "chat", label: "Chat", icon: "chat", features: ["chat"] },
  { id: "call", label: "Calls", icon: "phone", features: ["call"] },
  { id: "both", label: "Both", icon: "", features: ["chat", "call"] },
];
const modeById = (id) => MODES.find((m) => m.id === id);
const modeAvailable = (id) => modeById(id).features.every((f) => S.serverFeatures.includes(f));
function requestedMode() {
  const fromUrl = new URLSearchParams(location.search).get("mode");
  if (modeById(fromUrl)) return fromUrl;
  try { const stored = localStorage.getItem(MODE_KEY); if (modeById(stored)) return stored; } catch { /* storage blocked */ }
  return "both";
}
function resolveMode() {
  const wanted = requestedMode();
  if (modeAvailable(wanted)) return wanted;
  return ["both", "chat", "call"].find(modeAvailable) || "both";
}
function renderModeSwitches() {
  document.querySelectorAll(".mode-switch").forEach((group) => {
    group.innerHTML = MODES.map((m) => {
      const on = m.id === S.mode, ok = modeAvailable(m.id);
      const why = ok ? "" : ` title="${esc(modeUnavailableText())}" aria-disabled="true"`;
      return `<button type="button" role="radio" data-mode="${m.id}" aria-checked="${on}" tabindex="${on ? 0 : -1}"${why}>${m.icon ? icon(m.icon) : ""}<span>${m.label}</span></button>`;
    }).join("");
    group.querySelectorAll("button").forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
    const hint = group.parentElement.querySelector(".mode-hint");
    if (hint) { hint.textContent = modeUnavailableText(); hint.hidden = MODES.every((m) => modeAvailable(m.id)); }
    group.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const ids = MODES.map((m) => m.id).filter(modeAvailable);
      const i = ids.indexOf(S.mode) + (e.key === "ArrowRight" ? 1 : -1);
      if (i >= 0 && i < ids.length) { e.preventDefault(); switchMode(ids[i]); }
    };
  });
}
function modeUnavailableText() {
  const has = S.serverFeatures;
  if (has.includes("chat") && has.includes("call")) return "";
  const only = has.includes("chat") ? "chat" : "calls";
  return `This server only runs ${only}. Restart it without COMMS_FEATURES to use all modes.`;
}
function switchMode(id) {
  if (id === S.mode) return;
  if (!modeAvailable(id)) { toast(modeUnavailableText(), { ms: 5000 }); return; }
  const inCall = S.call && !["ended", "failed"].includes(S.call.state);
  if (inCall && !confirm("Switching ends the current call. Continue?")) return;
  try { localStorage.setItem(MODE_KEY, id); } catch { /* storage blocked: the URL still carries it */ }
  const url = new URL(location.href);
  url.searchParams.set("mode", id);
  url.hash = S.me ? (S.peer ? `${S.me}:${S.peer}` : S.me) : "";
  location.replace(url.toString());  // reload so only the chosen parts are loaded
}

// ================================================================ viewport: keep the app (and composer) inside the visual viewport
function syncViewport() {
  const vv = window.visualViewport;
  if (vv && vv.scale > 1.01) return; // pinch-zoomed: leave layout alone
  const h = vv ? vv.height : window.innerHeight;
  const root = document.documentElement.style;
  root.setProperty("--app-height", `${Math.round(h)}px`);
  root.setProperty("--app-top", `${Math.max(0, Math.round(vv ? vv.offsetTop : 0))}px`);
  if (Thread.stuck) Thread.scrollToBottom();
}

// ================================================================ layers: modals with focus trap + focus return
const layers = []; // {el, onEscape, returnTo, onKey}
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && el.getClientRects().length);
function syncInert() {
  const top = layers.length ? layers[layers.length - 1].el : null;
  for (const el of [$("login"), $("app"), $("devDrawer"), $("sheet"), $("chatMenu"), $("appearance"), $("viewer"), $("callScreen")]) {
    el.inert = !!top && el !== top;
  }
}
function openLayer(el, { initialFocus, onEscape } = {}) {
  const existing = layers.find((l) => l.el === el);
  if (existing) return;
  const returnTo = document.activeElement;
  const onKey = (e) => {
    if (e.key !== "Tab" || layers[layers.length - 1]?.el !== el) return;
    const f = focusables(el);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  layers.push({ el, onEscape, returnTo, onKey });
  el.hidden = false;
  syncInert();
  const target = (typeof initialFocus === "function" ? initialFocus() : initialFocus) || focusables(el)[0] || el;
  if (target === el && !el.hasAttribute("tabindex")) el.tabIndex = -1;
  requestAnimationFrame(() => target.focus({ preventScroll: true }));
}
function closeLayer(el, returnFocus) {
  const i = layers.findIndex((l) => l.el === el);
  el.hidden = true;
  if (i < 0) return;
  const [layer] = layers.splice(i, 1);
  document.removeEventListener("keydown", layer.onKey, true);
  syncInert();
  const target = returnFocus || layer.returnTo;
  if (target && document.contains(target) && !target.closest("[hidden]") && target.getClientRects().length) target.focus({ preventScroll: true });
  else if (S.peer && hasChat() && finePointer()) $("text").focus({ preventScroll: true });
}

// ================================================================ dev log + transport
function log(dir, obj) {
  const line = document.createElement("div");
  line.className = dir;
  line.textContent = (dir === "out" ? "→ " : dir === "in" ? "← " : "! ") + (typeof obj === "string" ? obj : JSON.stringify(obj));
  const box = $("log");
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(line);
  if (box.childElementCount > 600) box.firstChild.remove();
  if (atEnd && !$("devDrawer").hidden) box.scrollTop = box.scrollHeight;
}
function send(type, payload = {}, logged) {
  if (!S.ws || S.ws.readyState !== 1) { log("err", "not connected: " + type); return false; }
  const frame = { type, ...payload };
  log("out", logged || frame);
  S.ws.send(JSON.stringify(frame));
  return true;
}
async function api(method, path) {
  const res = await fetch(path, { method, headers: { Authorization: "Bearer " + S.token } });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

// ================================================================ sign in / connect
async function init() {
  Appearance.load();
  Appearance.applyPreset();
  applyTheme(currentTheme());
  let info;
  try {
    info = await (await fetch("/dev/users")).json();
  } catch (e) {
    $("whoList").setAttribute("aria-busy", "false");
    $("whoList").innerHTML = `<li class="login-error"><span>Can't reach the demo server.</span><button class="text-btn" type="button" id="loginRetry">Try again</button></li>`;
    $("loginRetry").onclick = () => location.reload();
    throw e;
  }
  S.users = info.users; S.serverFeatures = info.features;
  S.mode = resolveMode();
  S.features = modeById(S.mode).features.slice();
  document.body.dataset.features = S.features.join(",");
  document.body.dataset.mode = S.mode;
  renderModeSwitches();
  $("callsOnlyText").textContent = S.serverFeatures.includes("chat")
    ? "Calls only. Switch to Chat or Both to send messages."
    : "Calls only. Messaging is turned off on this server.";
  $("features").innerHTML = ["chat", "call"].filter((f) => S.serverFeatures.includes(f)).map((f) =>
    `<span class="chip">${icon(f === "call" ? "phone" : "chat")}${f === "call" ? "Voice calls" : "Chat"}</span>`).join("");
  $("whoList").setAttribute("aria-busy", "false");
  $("whoList").innerHTML = S.users.map((u) =>
    `<li class="who"><button class="who-btn" type="button" data-id="${esc(u.id)}">${avatarHtml(u.id, 44)}<span class="who-text"><b>${esc(u.name)}</b><small>${esc(u.id)}</small></span>${icon("right")}</button></li>`).join("");
  $("whoList").querySelectorAll(".who-btn").forEach((b) => (b.onclick = () => signIn(b.dataset.id)));
  if (hasCall()) await loadScript("demo-call.js");
  // #U1 signs in as U1; #U1:U2 also opens the chat with U2.
  const [fromHash, openWith] = location.hash.slice(1).split(":");
  if (S.users.some((u) => u.id === fromHash)) {
    if (S.users.some((u) => u.id === openWith) && openWith !== fromHash) S.openWhenConnected = openWith;
    await signIn(fromHash);
  }
}
async function signIn(id) {
  S.me = id; location.hash = id;
  document.title = nameOf(id) + " · Comms Kit Demo";
  S.token = (await (await fetch("/dev/token/" + id)).json()).token;
  $("login").hidden = true; $("app").hidden = false;
  $("meAvatar").innerHTML = avatarHtml(id, 40);
  $("meAvatar").title = `Signed in as ${nameOf(id)}`;
  $("listTitle").textContent = hasChat() ? "Chats" : "Calls";
  $("search").placeholder = hasChat() ? "Search chats" : "Search people";
  $("welcomeTitle").textContent = hasChat() ? "Select a conversation" : "Who do you want to call?";
  $("welcomeText").textContent = hasChat()
    ? (hasCall() ? "Pick someone on the left to start messaging or calling." : "Pick someone on the left to start messaging.")
    : "Pick someone on the left to start a voice call.";
  S.listReady = !hasChat(); // call-only: the list is just the demo users
  S.listError = null;
  showPane("list");
  renderConvos();
  window.CallUI?.unlockAudio();
  connect();
}
function connect() {
  clearTimeout(S.retryTimer); S.retryTimer = null;
  S.closing = false;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${S.token}`);
  S.ws = ws;
  setConn("connecting");
  ws.onopen = () => {
    if (S.ws !== ws) return;
    S.retry = 0; setConn("online");
    if (hasChat()) send("req_users");
    if (S.peer) openPeer(S.peer, true);
    else if (S.openWhenConnected) { const p = S.openWhenConnected; S.openWhenConnected = null; openPeer(p); }
    Composer.sync();
  };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); log("in", m); handle(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    window.CallUI?.onDisconnect();
    Thread.failAllPending();
    Composer.sync();
    if (S.closing) return setConn("offline");
    const wait = Math.min(1000 * 2 ** S.retry++, 30000);
    S.retryAt = Date.now() + wait;
    setConn("reconnecting");
    S.retryTimer = setTimeout(() => { if (S.ws === ws && !S.closing) connect(); }, wait);
  };
}
let bannerTick = null;
function setConn(state) {
  S.connState = state;
  const el = $("connState");
  el.dataset.state = state === "online" ? "online" : state === "reconnecting" ? "offline" : "connecting";
  $("connText").textContent = state === "online" ? "Online" : state === "reconnecting" ? "Offline" : state === "connecting" ? "Connecting…" : "Offline";
  const banner = $("banner");
  clearInterval(bannerTick); bannerTick = null;
  if (state === "online" || state === "offline") { banner.hidden = true; return; }
  banner.hidden = false;
  banner.dataset.state = state === "reconnecting" ? "offline" : "connecting";
  $("bannerRetry").hidden = state !== "reconnecting";
  const paint = () => {
    if (state === "connecting") { $("bannerText").textContent = "Connecting…"; return; }
    const secs = Math.max(0, Math.ceil((S.retryAt - Date.now()) / 1000));
    $("bannerText").textContent = `Offline. Retrying in ${secs}s`;
  };
  paint();
  if (state === "reconnecting") bannerTick = setInterval(paint, 500);
}
function signOut() {
  window.CallUI?.reset();
  S.closing = true; clearTimeout(S.retryTimer); S.ws?.close(); S.ws = null;
  setConn("offline");
  Object.assign(S, { peer: null, chatId: null, convos: {}, online: {}, typing: {}, listReady: false, thread: newThread() });
  Thread.clear();
  location.hash = ""; document.title = "Comms Kit Demo";
  $("app").hidden = true; $("login").hidden = false;
  $("thread").hidden = true; $("welcome").hidden = false;
  closeDev();
  $("whoList").querySelector(".who-btn")?.focus();
}

// ================================================================ panes (phone: one at a time)
function showPane(which) {
  $("app").dataset.pane = which;
}
function goBack() {
  Composer.stopTyping();
  const prev = S.peer;
  S.peer = null; S.chatId = null; S.thread = newThread(); Thread.clear();
  showPane("list");
  $("thread").hidden = true; $("welcome").hidden = false;
  renderConvos(true);
  const row = prev && $("convoList").querySelector(`.convo[data-id="${CSS.escape(prev)}"]`);
  row?.focus({ preventScroll: false });
}

// ================================================================ conversation list
function previewHtml(peer, unread) {
  if (S.typing[peer]) return `<span class="preview typing"><span class="ptext">typing…</span></span>`;
  if (!hasChat()) {
    const known = peer in S.online;
    return `<span class="preview">${icon("phone")}<span class="ptext">${known ? (S.online[peer] ? "Online · tap to call" : "Offline") : "Voice call"}</span></span>`;
  }
  const last = S.convos[peer]?.last_message;
  if (!last) return `<span class="preview"><span class="ptext">${hasCall() ? "Say hi or start a call" : "Say hi"}</span></span>`;
  const mine = last.sender_id === S.me;
  const t = last.message_type || "text";
  if (/_call$/.test(t)) {
    const content = last.content || "";
    const missed = /^(missed|declined)/i.test(content);
    const label = content.startsWith("[") ? "Voice call" : content;
    return `<span class="preview${missed ? " missed" : ""}">${icon(missed ? "phone-missed" : mine ? "phone-out" : "phone-in")}<span class="ptext">${esc(label)}</span></span>`;
  }
  let body;
  if (t === "image") body = `${icon("image")}<span class="ptext">Photo</span>`;
  else if (t !== "text") body = `${icon("clip")}<span class="ptext">${esc(last.file_name || t)}</span>`;
  else body = `<span class="ptext">${esc(last.content || "")}</span>`;
  const tick = mine ? icon(last.is_read || last.is_delivered ? "dcheck" : "check", `tick${last.is_read ? " read" : ""}`, last.is_read ? "Read" : last.is_delivered ? "Delivered" : "Sent") : "";
  const you = mine ? `<span class="you">You:</span>` : "";
  return `<span class="preview${unread ? " unread-text" : ""}">${tick}${you}${body}</span>`;
}
function convoRow(u) {
  const c = S.convos[u.id] || {};
  const unread = c.unread_count && u.id !== S.peer ? c.unread_count : 0;
  const badge = unread ? `<span class="badge" aria-label="${unread} unread">${unread > 99 ? "99+" : unread}</span>` : "";
  const online = S.online[u.id] ? `<span class="sr-only">, online</span>` : "";
  return `<li><button class="convo" type="button" data-id="${esc(u.id)}"${S.peer === u.id ? ' aria-current="true"' : ""}>
    ${avatarHtml(u.id, 48, { presence: true })}
    <span class="convo-body">
      <span class="row"><span class="convo-name">${esc(u.name)}${online}</span><span class="convo-time${unread ? " unread" : ""}">${listTime(c.updated_at)}</span></span>
      <span class="row">${previewHtml(u.id, unread)}${badge}</span>
    </span></button></li>`;
}
const SKELETON_ROW = `<li aria-hidden="true"><div class="convo skeleton"><span class="sk sk-avatar"></span><span class="convo-body"><span class="sk sk-line"></span><span class="sk sk-line short"></span></span></div></li>`;
let convoTimer = null;
function scheduleConvos(delay = 120) {
  if (convoTimer) return;
  convoTimer = setTimeout(() => { convoTimer = null; renderConvos(); }, delay);
}
function renderConvos(force) {
  if (convoTimer && !force) { clearTimeout(convoTimer); convoTimer = null; }
  const list = $("convoList");
  if (!S.listReady) {
    list.setAttribute("aria-busy", "true");
    list.innerHTML = S.listError
      ? `<li class="list-empty">${icon("alert")}<b>Couldn't load chats</b><span>${esc(S.listError)}</span><button class="text-btn" type="button" data-retry-list>Try again</button></li>`
      : SKELETON_ROW.repeat(6);
    return;
  }
  list.setAttribute("aria-busy", "false");
  const q = $("search").value.trim().toLowerCase();
  const others = S.users.filter((u) => u.id !== S.me);
  const peers = others.filter((u) => !q || u.name.toLowerCase().includes(q))
    .sort((a, b) => (S.convos[b.id]?.updated_at || "").localeCompare(S.convos[a.id]?.updated_at || "") || a.name.localeCompare(b.name));
  const focusedId = document.activeElement?.closest?.("#convoList .convo")?.dataset.id;
  if (!others.length) list.innerHTML = `<li class="list-empty">${icon("users")}<b>No conversations yet</b><span>Other demo users will appear here.</span></li>`;
  else if (!peers.length) list.innerHTML = `<li class="list-empty">${icon("search")}<b>${hasChat() ? "No chats match" : "No one matches"}</b><span>Try a different name.</span></li>`;
  else list.innerHTML = peers.map(convoRow).join("");
  if (focusedId) list.querySelector(`.convo[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}
function bumpConvo(peer, msg, countUnread) {
  const c = (S.convos[peer] = S.convos[peer] || { unread_count: 0 });
  c.chat_id = msg.chat_id; c.last_message = msg; c.updated_at = msg.timestamp;
  if (countUnread) c.unread_count = (c.unread_count || 0) + 1;
  renderConvos();
}
const peerForChat = (chatId) => Object.keys(S.convos).find((p) => S.convos[p].chat_id === chatId);
function onListKey(e) {
  const rows = [...$("convoList").querySelectorAll(".convo:not(.skeleton)")];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  let next = null;
  if (e.key === "ArrowDown") next = rows[Math.min(rows.length - 1, i + 1)] || rows[0];
  else if (e.key === "ArrowUp") next = i <= 0 ? (i < 0 ? rows[rows.length - 1] : rows[0]) : rows[i - 1];
  else if (e.key === "Home") next = rows[0];
  else if (e.key === "End") next = rows[rows.length - 1];
  if (next) { e.preventDefault(); next.focus(); }
}

// ================================================================ thread header + opening a conversation
function renderPeerHeader() {
  if (!S.peer) return;
  $("peerAvatar").innerHTML = avatarHtml(S.peer, 40, { presence: true });
  $("peerName").textContent = nameOf(S.peer);
  const sub = $("peerSub");
  const typing = S.typing[S.peer];
  const known = S.peer in S.online;
  sub.textContent = typing ? "typing…" : S.online[S.peer] ? "online" : known ? "offline" : hasChat() ? "" : "Voice calls";
  sub.className = "peer-sub" + (typing ? " typing" : S.online[S.peer] ? " online" : "");
  $("callBtn").setAttribute("aria-label", `Call ${nameOf(S.peer)}`);
  if (!hasChat()) {
    $("callsOnlyAvatar").innerHTML = avatarHtml(S.peer, 96, { presence: true });
    $("callsOnlyName").textContent = nameOf(S.peer);
    $("callsOnlySub").textContent = S.online[S.peer] ? "Online now" : known ? "Offline. They'll get a missed-call notice." : "Start a peer-to-peer voice call.";
    $("callsOnlyCall").setAttribute("aria-label", `Voice call ${nameOf(S.peer)}`);
  }
}
async function openPeer(id, refresh = false) {
  if (!refresh || S.peer !== id) {
    if (S.peer && S.peer !== id) Composer.stopTyping();
    S.thread = newThread(); Thread.clear();
    S.chatId = S.convos[id]?.chat_id ?? null;
    Composer.reset();
  }
  S.peer = id;
  showPane("chat");
  $("welcome").hidden = true; $("thread").hidden = false;
  $("callBtn").hidden = !hasCall() || !hasChat(); // call-only: the big button in the panel is the call action
  $("threadBody").hidden = !hasChat();
  $("composer").hidden = !hasChat();
  $("callsOnly").hidden = hasChat();
  if (hasChat()) Appearance.applyChat();
  renderPeerHeader(); renderConvos(true);
  if (!hasChat()) {
    if (!refresh) requestAnimationFrame(() => $("callsOnlyCall").focus({ preventScroll: true }));
    return;
  }
  if (S.convos[id]) S.convos[id].unread_count = 0;
  if (refresh) S.thread.reload = true;
  else Thread.showLoading();
  if (!refresh && finePointer()) $("text").focus({ preventScroll: true });
  let res;
  try {
    res = await api("POST", "/chats/start?candidate_id=" + encodeURIComponent(id));
  } catch (err) {
    if (S.peer === id) Thread.showError("Couldn't open this conversation.");
    log("err", String(err));
    return;
  }
  if (S.peer !== id) return;
  S.chatId = res.chat_id;
  if (!S.convos[id]) { S.convos[id] = { chat_id: res.chat_id, unread_count: 0 }; send("req_users"); }
  Thread.requestPage(0);
}

// ================================================================ thread (incremental rendering, keyed by message id)
const Thread = {
  stuck: true, // pinned to the bottom

  el: () => $("scroller"),
  clear() {
    $("msgList").innerHTML = ""; $("pendingList").innerHTML = "";
    $("threadNotice").hidden = true; $("olderLoader").hidden = true;
    $("typingRow").hidden = true; this.setJump(0, false);
    this.stuck = true;
  },
  showLoading() {
    const sk = (out, w) => `<div class="msg ${out ? "out" : "in"} first"><div class="bubble" style="width:${w}%;max-width:${w}%"><span class="sk sk-line" style="width:100%"></span></div></div>`;
    $("msgList").innerHTML = `<div aria-hidden="true">${sk(0, 46) + sk(0, 30) + sk(1, 52) + sk(0, 38) + sk(1, 28) + sk(1, 44)}</div>`;
    $("msgList").setAttribute("aria-busy", "true");
    $("threadNotice").hidden = true;
  },
  showError(text) {
    const n = $("threadNotice");
    S.thread.error = text;
    $("msgList").innerHTML = ""; $("msgList").removeAttribute("aria-busy");
    n.className = "thread-notice error"; n.hidden = false;
    n.innerHTML = `<div class="notice-card" role="alert">${icon("alert")}<span></span><button class="text-btn" type="button" data-retry-thread>${icon("refresh")} Retry</button></div>`;
    n.querySelector("span").textContent = text;
  },
  updateEmpty() {
    const T = S.thread, n = $("threadNotice");
    if (T.error) return;
    const empty = T.loaded && !T.msgs.size && !T.pending.length;
    n.className = "thread-notice"; n.hidden = !empty;
    if (empty) n.innerHTML = `<div class="notice-card"><span class="say-hi">Say hi 👋</span><span>Messages${hasCall() ? " and calls" : ""} with ${esc(nameOf(S.peer))} appear here.</span></div>`;
  },
  requestPage(offset) {
    if (offset > 0) { S.thread.loadingOlder = true; $("olderLoader").hidden = false; }
    send("get_messages", { candidate_user_id: S.peer, limit: PAGE, offset });
  },

  // -- grouping ------------------------------------------------------------
  isFirst(prev, m) {
    if (!prev || isCallMsg(prev) || isCallMsg(m)) return true;
    if (prev.sender_id !== m.sender_id) return true;
    const a = toDate(prev.timestamp), b = toDate(m.timestamp);
    return dayKey(a) !== dayKey(b) || b - a > GROUP_MS;
  },
  dayChip(d) {
    const el = document.createElement("div");
    el.className = "day"; el.dataset.day = dayKey(d);
    el.innerHTML = `<span>${esc(dayLabel(d))}</span>`;
    return el;
  },

  // -- building rows -------------------------------------------------------
  tickState(m) { return m.is_read ? "read" : m.is_delivered ? "delivered" : "sent"; },
  metaHtml(m, mine, state) {
    const st = state || (mine ? this.tickState(m) : "");
    const ic = { read: "dcheck", delivered: "dcheck", sent: "check", pending: "clock", failed: "alert" }[st];
    const label = { read: "Read", delivered: "Delivered", sent: "Sent", pending: "Sending", failed: "Not sent" }[st];
    return `<span class="meta"${st ? ` data-tick="${st}"` : ""}><span class="t">${hhmm(toDate(m.timestamp))}</span>${mine && ic ? icon(ic, "", label) : ""}</span>`;
  },
  callEntry(m) {
    const text = m.content || "";
    const missed = /^(missed|declined)/i.test(text);
    const mine = m.sender_id === S.me;
    const pending = text.startsWith("[");
    const title = pending ? "Voice call" : text.replace(/ · .*/, "");
    const dur = (text.match(/· (.*)$/) || [])[1];
    const detail = pending ? "In progress" : [mine ? "Outgoing" : "Incoming", dur].filter(Boolean).join(" · ");
    const back = hasCall() && !pending ? `<button class="text-btn" type="button" data-callback aria-label="Call ${esc(nameOf(S.peer))} back">Call back</button>` : "";
    const el = document.createElement("div");
    el.className = "call-entry"; el.dataset.id = m.id;
    el.innerHTML = `<div class="call-chip">
      <span class="call-ic${missed ? " missed" : pending ? " pending" : ""}">${icon(missed ? "phone-missed" : mine ? "phone-out" : "phone-in")}</span>
      <span class="call-text"><b>${esc(title)}</b><small>${esc(detail)} · ${hhmm(toDate(m.timestamp))}</small></span>${back}</div>`;
    return el;
  },
  row(m, first) {
    if (isCallMsg(m)) return this.callEntry(m);
    const mine = m.sender_id === S.me;
    const el = document.createElement("div");
    el.className = `msg ${mine ? "out" : "in"}${first ? " first" : ""}`;
    el.dataset.id = m.id;
    const who = first ? `<span class="sr-only">${mine ? "You" : esc(nameOf(m.sender_id))}: </span>` : "";
    let body, cls = "";
    if (m.file_url && m.message_type === "image") {
      cls = " media";
      body = `<button class="thumb-btn" type="button" data-zoom aria-label="Open photo ${esc(m.file_name || "")}"><img class="thumb" src="${esc(m.file_url)}" alt="${esc(m.file_name || "Photo")}" loading="lazy" decoding="async"></button>`;
    } else if (m.file_url) {
      body = `<a class="file-card" href="${esc(m.file_url)}" target="_blank" rel="noopener" download="${esc(m.file_name || "")}">
        <span class="file-icon">${icon("file")}</span>
        <span class="file-text"><b>${esc(m.file_name || "File")}</b><small>${esc([fmtSize(m.file_size), fileKind(m.file_name, m.file_type || m.message_type)].filter(Boolean).join(" · "))}</small></span>${icon("download")}</a>`;
    } else {
      body = `<span class="text">${linkify(esc(m.content))}</span>`;
    }
    el.innerHTML = `<div class="bubble${cls}">${who}${body}${this.metaHtml(m, mine)}</div>`;
    return el;
  },
  nodeFor(id) { return $("msgList").querySelector(`[data-id="${CSS.escape(String(id))}"]`); },

  // -- full render (initial load / fallback) ---------------------------------
  renderAll() {
    const T = S.thread;
    T.order = [...T.msgs.keys()].sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    let prev = null;
    for (const id of T.order) {
      const m = T.msgs.get(id);
      const d = toDate(m.timestamp);
      if (!prev || dayKey(toDate(prev.timestamp)) !== dayKey(d)) frag.appendChild(this.dayChip(d));
      frag.appendChild(this.row(m, this.isFirst(prev, m)));
      prev = m;
    }
    const list = $("msgList");
    list.removeAttribute("aria-busy");
    list.replaceChildren(frag);
    this.updateEmpty();
  },
  // -- append newest (incremental) --------------------------------------------
  append(m, animate) {
    const T = S.thread;
    const prev = T.order.length ? T.msgs.get(T.order[T.order.length - 1]) : null;
    const d = toDate(m.timestamp);
    const list = $("msgList");
    if (!prev || dayKey(toDate(prev.timestamp)) !== dayKey(d)) list.appendChild(this.dayChip(d));
    const node = this.row(m, this.isFirst(prev, m));
    if (animate && !reducedMotion()) { node.classList.add("enter"); node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true }); }
    list.appendChild(node);
    T.order.push(m.id);
    this.updateEmpty();
  },
  // -- patch one message in place ------------------------------------------------
  patch(m) {
    const old = this.nodeFor(m.id);
    if (!old) return;
    const node = this.row(m, old.classList.contains("first"));
    old.replaceWith(node);
  },
  upsert(m, { animate = true } = {}) {
    const T = S.thread;
    if (T.msgs.has(m.id)) {
      const old = T.msgs.get(m.id);
      const merged = { ...old, ...m };
      if (JSON.stringify(merged) !== JSON.stringify(old)) { T.msgs.set(m.id, merged); this.patch(merged); }
      return false;
    }
    T.msgs.set(m.id, m);
    const last = T.order[T.order.length - 1];
    if (last === undefined || m.id > last) this.append(m, animate);
    else this.renderAll(); // arrived out of order (rare): rebuild once
    return true;
  },
  // -- prepend an older page, keeping the scroll position ---------------------------
  prepend(older) {
    const T = S.thread;
    const fresh = older.filter((m) => !T.msgs.has(m.id));
    if (!fresh.length) return;
    const firstId = T.order[0];
    if (firstId !== undefined && fresh.some((m) => m.id > firstId)) {
      fresh.forEach((m) => T.msgs.set(m.id, m));
      return this.keepPosition(() => this.renderAll());
    }
    this.keepPosition(() => {
      const list = $("msgList");
      const frag = document.createDocumentFragment();
      let prev = null;
      for (const m of fresh) {
        const d = toDate(m.timestamp);
        if (!prev || dayKey(toDate(prev.timestamp)) !== dayKey(d)) frag.appendChild(this.dayChip(d));
        frag.appendChild(this.row(m, this.isFirst(prev, m)));
        prev = m;
        T.msgs.set(m.id, m);
      }
      if (firstId !== undefined) {
        const oldFirst = T.msgs.get(firstId);
        const topChip = list.firstElementChild;
        if (topChip?.classList.contains("day") && topChip.dataset.day === dayKey(toDate(prev.timestamp))) topChip.remove();
        this.nodeFor(firstId)?.classList.toggle("first", this.isFirst(prev, oldFirst));
      }
      list.insertBefore(frag, list.firstChild);
      T.order = fresh.map((m) => m.id).concat(T.order);
    });
  },
  keepPosition(fn) {
    const el = this.el();
    const fromBottom = el.scrollHeight - el.scrollTop;
    fn();
    el.scrollTop = el.scrollHeight - fromBottom;
  },

  // -- optimistic sends ------------------------------------------------------
  addPending(content) {
    const T = S.thread;
    const key = "p" + Math.random().toString(36).slice(2);
    const fake = { id: key, sender_id: S.me, content, message_type: "text", timestamp: new Date().toISOString() };
    const lastId = T.order[T.order.length - 1];
    const prev = T.pending.length ? { sender_id: S.me, message_type: "text", timestamp: fake.timestamp } : lastId !== undefined ? T.msgs.get(lastId) : null;
    const node = this.row(fake, this.isFirst(prev, fake));
    node.classList.add("pending");
    node.dataset.id = key;
    node.querySelector(".meta").outerHTML = this.metaHtml(fake, true, "pending");
    if (!reducedMotion()) node.classList.add("enter");
    $("pendingList").appendChild(node);
    const p = { key, content, node, failed: false };
    p.timer = setTimeout(() => this.failPending(p), 10000);
    T.pending.push(p);
    this.updateEmpty();
    this.scrollToBottom(true);
  },
  resolvePending(msg) {
    const T = S.thread;
    const i = T.pending.findIndex((p) => p.content === msg.content);
    if (i < 0) return;
    const [p] = T.pending.splice(i, 1);
    clearTimeout(p.timer); p.node.remove();
  },
  failPending(p) {
    if (p.failed || !S.thread.pending.includes(p)) return;
    p.failed = true; clearTimeout(p.timer);
    p.node.classList.remove("pending");
    const meta = p.node.querySelector(".meta");
    meta.outerHTML = this.metaHtml({ timestamp: new Date().toISOString() }, true, "failed");
    const note = document.createElement("span");
    note.className = "failed-note";
    note.innerHTML = `Not sent. <button type="button" data-resend="${p.key}">Retry</button>`;
    p.node.querySelector(".bubble").appendChild(note);
  },
  failAllPending() { S.thread.pending.forEach((p) => this.failPending(p)); },
  resend(key) {
    const T = S.thread;
    const i = T.pending.findIndex((p) => p.key === key);
    if (i < 0) return;
    const [p] = T.pending.splice(i, 1);
    p.node.remove();
    Composer.sendText(p.content);
  },

  // -- scrolling, jump-to-latest, load older ---------------------------------
  distance() { const el = this.el(); return el.scrollHeight - el.scrollTop - el.clientHeight; },
  scrollToBottom(smooth = false) {
    const el = this.el();
    if (smooth && !reducedMotion()) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    this.stuck = true;
    S.thread.newCount = 0;
    this.setJump(0, false);
  },
  setJump(count, show) {
    $("jumpBtn").hidden = !show;
    $("jumpCount").hidden = !count;
    $("jumpCount").textContent = count > 99 ? "99+" : String(count);
    $("jumpBtn").setAttribute("aria-label", count ? `Jump to latest, ${count} new message${count === 1 ? "" : "s"}` : "Jump to latest messages");
  },
  onScroll() {
    const el = this.el();
    const dist = this.distance();
    this.stuck = dist < 80;
    if (this.stuck) S.thread.newCount = 0;
    this.setJump(S.thread.newCount, dist > el.clientHeight || (S.thread.newCount > 0 && !this.stuck));
    const T = S.thread;
    if (el.scrollTop < 160 && T.loaded && T.hasMore && !T.loadingOlder && !T.reload) this.requestPage(T.msgs.size);
  },
  // When a fresh page doesn't fill the screen, keep loading until it does (or history ends).
  fill() {
    const T = S.thread, el = this.el();
    if (T.hasMore && !T.loadingOlder && el.scrollHeight <= el.clientHeight + 40) this.requestPage(T.msgs.size);
  },
  // New message arrived in the open chat.
  arrived(mine) {
    if (mine || this.stuck) { requestAnimationFrame(() => this.scrollToBottom(true)); return; }
    S.thread.newCount++;
    this.setJump(S.thread.newCount, true);
  },
  showTyping(on) {
    const row = $("typingRow");
    if (row.hidden === !on) return;
    row.hidden = !on;
    if (on && this.stuck) this.scrollToBottom();
  },
};

// ================================================================ composer
const Composer = {
  typingTimer: null,
  reset() { const t = $("text"); t.value = ""; this.autosize(); this.sync(); },
  sync() {
    const online = S.ws?.readyState === 1;
    const t = $("text");
    $("sendBtn").disabled = !t.value.trim() || !online;
    t.placeholder = online ? "Message" : "Waiting for connection…";
    $("attachBtn").disabled = !online;
  },
  autosize() {
    const t = $("text");
    if (!t.value || !t.getClientRects().length) { t.style.height = ""; t.style.overflowY = "hidden"; return; } // empty or hidden: CSS height
    t.style.height = "auto";
    const max = parseFloat(getComputedStyle(t).maxHeight) || 160;
    const h = Math.min(t.scrollHeight, max);
    t.style.height = h + "px";
    t.style.overflowY = t.scrollHeight > max ? "auto" : "hidden";
  },
  sendText(override) {
    const text = (override ?? $("text").value).trim();
    if (!text || !S.peer || !hasChat()) return;
    if (!send("send_message", { candidate_user_id: S.peer, content: text, message_type: "text" })) {
      toast("You're offline. The message wasn't sent.", { kind: "error" });
      return;
    }
    this.stopTyping();
    Thread.addPending(text);
    if (override === undefined) { $("text").value = ""; this.autosize(); this.sync(); }
  },
  onInput() {
    this.autosize(); this.sync();
    if (!S.peer || !hasChat() || !$("text").value) return;
    if (!this.typingTimer) send("typing", { target_user_id: S.peer, is_typing: true });
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 2500);
  },
  stopTyping() {
    if (!this.typingTimer) return;
    clearTimeout(this.typingTimer); this.typingTimer = null;
    if (S.peer) send("typing", { target_user_id: S.peer, is_typing: false });
  },
};

// ---------------------------------------------------------------- attachments: preview sheet, then media_upload
let sheetFile = null, sheetUrl = null;
function pickFile(file) {
  if (!file || !S.peer) return;
  if (file.size > MAX_FILE) { toast(`"${file.name}" is ${fmtSize(file.size)}. Files must be 10 MB or smaller.`, { kind: "error", ms: 4500 }); return; }
  sheetFile = file;
  const isImg = /^image\//.test(file.type);
  $("sheetTitle").textContent = isImg ? "Send photo" : "Send file";
  if (sheetUrl) URL.revokeObjectURL(sheetUrl);
  sheetUrl = isImg ? URL.createObjectURL(file) : null;
  $("sheetPreview").innerHTML = isImg
    ? `<img src="${sheetUrl}" alt="Preview of ${esc(file.name)}"><div class="sheet-file-meta">${esc(file.name)} · ${fmtSize(file.size)}</div>`
    : `<div class="file-card"><span class="file-icon">${icon("file")}</span><span class="file-text"><b>${esc(file.name)}</b><small>${fmtSize(file.size)}${file.type ? " · " + esc(file.type) : ""}</small></span></div>`;
  $("sheetSend").setAttribute("aria-label", `Send ${file.name} to ${nameOf(S.peer)}`);
  openLayer($("sheet"), { initialFocus: $("sheetSend"), onEscape: closeSheet });
}
function closeSheet() {
  closeLayer($("sheet"), $("attachBtn"));
  sheetFile = null;
  if (sheetUrl) { URL.revokeObjectURL(sheetUrl); sheetUrl = null; }
}
async function sendFile(file) {
  if (!file || !S.peer) return;
  if (file.size > MAX_FILE) return toast("Files must be 10 MB or smaller", { kind: "error" });
  const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  const payload = { target_user_id: S.peer, file_name: file.name, file_type: file.type, file_data: String(dataUrl).split(",")[1] };
  if (send("media_upload", payload, { type: "media_upload", ...payload, file_data: `<${file.size} bytes base64>` })) toast(`Sending ${file.name}…`, { ms: 1800 });
  else toast("You're offline. The file wasn't sent.", { kind: "error" });
}

// ---------------------------------------------------------------- image viewer
function openViewer(src, name) {
  $("viewerImg").src = src; $("viewerImg").alt = name || "Photo";
  $("viewerName").textContent = name || "Photo";
  $("viewerDownload").href = src; $("viewerDownload").setAttribute("download", name || "");
  openLayer($("viewer"), { initialFocus: $("viewerClose"), onEscape: closeViewer });
}
function closeViewer() { closeLayer($("viewer")); $("viewerImg").removeAttribute("src"); }

// ---------------------------------------------------------------- dev drawer (non-modal)
function openDev() { $("devDrawer").hidden = false; $("devBtn").setAttribute("aria-expanded", "true"); $("log").scrollTop = $("log").scrollHeight; $("closeDev").focus(); }
function closeDev(returnFocus) { if ($("devDrawer").hidden) return; $("devDrawer").hidden = true; $("devBtn").setAttribute("aria-expanded", "false"); if (returnFocus) $("devBtn").focus(); }

// ================================================================ incoming frames
const typingClear = {};
function handle(m) {
  switch (m.type) {
    case "res_users":
      (m.users || []).forEach((u) => {
        S.convos[u.user_id] = { chat_id: u.chat_id, last_message: u.last_message, updated_at: u.updated_at, unread_count: u.user_id === S.peer ? 0 : u.unread_count };
        S.online[u.user_id] = u.status === "online";
      });
      S.listReady = true; S.listError = null;
      renderConvos(); renderPeerHeader(); break;
    case "req_users_error":
      if (!S.listReady) { S.listError = m.error || "Please try again."; renderConvos(); }
      else toast("Couldn't refresh chats", { kind: "error" });
      break;
    case "res_messages": {
      if (!m.info || m.info.user_id !== S.peer) break;
      const T = S.thread;
      S.online[S.peer] = m.info.status === "online";
      const page = (m.messages || []).slice().reverse(); // ascending
      T.error = null;
      if ((m.offset || 0) === 0) {
        if (!T.loaded || T.reload) {
          T.msgs = new Map(page.map((x) => [x.id, x]));
          for (const x of T.early.splice(0)) T.msgs.set(x.id, { ...T.msgs.get(x.id), ...x });
          T.hasMore = !!m.has_more; T.loaded = true; T.reload = false;
          Thread.renderAll();
          Thread.scrollToBottom();
          requestAnimationFrame(() => Thread.fill());
        } else {
          let added = 0;
          page.forEach((x) => { if (Thread.upsert(x)) added++; });
          if (added) Thread.arrived(false);
        }
        if (S.chatId) send("mark_read", { chat_id: S.chatId });
      } else {
        T.loadingOlder = false; $("olderLoader").hidden = true;
        T.hasMore = !!m.has_more;
        Thread.prepend(page);
        requestAnimationFrame(() => Thread.fill());
      }
      renderPeerHeader(); scheduleConvos();
      break;
    }
    case "new_message": {
      const msg = m.message; const peer = msg.sender_id;
      const inOpen = msg.chat_id === S.chatId && peer === S.peer;
      const visible = inOpen && document.visibilityState === "visible";
      if (inOpen && S.thread.loaded) {
        if (Thread.upsert(msg)) Thread.arrived(false);
        if (visible) send("mark_read", { chat_id: S.chatId });
        announce(`${nameOf(peer)}: ${msg.content || msg.file_name || "sent an attachment"}`);
      } else if (inOpen) S.thread.early.push(msg);
      if (!S.convos[peer]) send("req_users");
      S.typing[peer] = false; renderPeerHeader(); if (inOpen) Thread.showTyping(false);
      bumpConvo(peer, msg, !visible);
      if (!visible && !isCallMsg(msg)) toast(`${nameOf(peer)}: ${msg.content || (msg.message_type === "image" ? "Photo" : msg.file_name) || "New message"}`);
      break;
    }
    case "message_sent": case "media_upload_success": {
      const msg = m.message;
      if (msg.chat_id === S.chatId && S.thread.loaded) {
        if (m.type === "message_sent" && msg.message_type === "text") Thread.resolvePending(msg);
        if (Thread.upsert(msg)) Thread.arrived(true);
      } else if (msg.chat_id === S.chatId) {
        if (m.type === "message_sent" && msg.message_type === "text") Thread.resolvePending(msg);
        S.thread.early.push(msg);
      }
      const peer = peerForChat(msg.chat_id) || S.peer;
      if (peer && msg.content !== null) bumpConvo(peer, msg, false);
      break;
    }
    case "messages_read":
      if (m.chat_id === S.chatId) {
        for (const x of S.thread.msgs.values()) {
          if (x.sender_id === S.me && !x.is_read) { x.is_read = x.is_delivered = true; Thread.patch(x); }
        }
      }
      { const p = peerForChat(m.chat_id); if (p && S.convos[p].last_message?.sender_id === S.me) { S.convos[p].last_message.is_read = true; renderConvos(); } }
      break;
    case "delivery_status":
      for (const id of m.message_ids || []) {
        const x = S.thread.msgs.get(id);
        if (x && !x.is_delivered) { x.is_delivered = true; Thread.patch(x); }
      }
      { const p = peerForChat(m.chat_id); const lm = p && S.convos[p].last_message; if (lm && lm.sender_id === S.me) { lm.is_delivered = true; scheduleConvos(); } }
      break;
    case "chat_read": { const p = peerForChat(m.chat_id); if (p) { S.convos[p].unread_count = 0; renderConvos(); } break; }
    case "typing_status":
      S.typing[m.user_id] = m.is_typing; renderPeerHeader();
      if (m.user_id === S.peer) Thread.showTyping(!!m.is_typing);
      scheduleConvos(150); // typing is chatty: debounce list updates
      clearTimeout(typingClear[m.user_id]);
      typingClear[m.user_id] = setTimeout(() => {
        S.typing[m.user_id] = false; renderPeerHeader();
        if (m.user_id === S.peer) Thread.showTyping(false);
        scheduleConvos(150);
      }, 4000);
      break;
    case "user_status": S.online[m.user_id] = m.status === "online"; renderPeerHeader(); scheduleConvos(); break;
    case "call_log":
      // The call's chat entry was rewritten ("Voice call · 00:12", "Missed voice call").
      if (m.chat_id === S.chatId && S.peer) send("get_messages", { candidate_user_id: S.peer, limit: PAGE, offset: 0 });
      send("req_users");
      break;
    case "error":
      if (m.context === "call") { window.CallUI?.onError(m); }
      else {
        toast(m.error || "Something went wrong", { kind: "error" });
        if (/retrieve messages|chat not found/i.test(m.error || "") && S.peer && !S.thread.loaded) Thread.showError("Couldn't load messages.");
      }
      break;
    default:
      if (m.type.startsWith("call_") || ["incoming_call", "sdp_offer", "sdp_answer", "ice_candidate"].includes(m.type)) window.CallUI?.handle(m);
  }
}

// ================================================================ wiring
function wire() {
  // list
  $("convoList").addEventListener("click", (e) => {
    if (e.target.closest("[data-retry-list]")) { S.listError = null; renderConvos(); send("req_users"); return; }
    const row = e.target.closest(".convo:not(.skeleton)");
    if (row) openPeer(row.dataset.id);
  });
  $("convoList").addEventListener("keydown", onListKey);
  $("search").addEventListener("input", () => renderConvos());
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); $("convoList").querySelector(".convo:not(.skeleton)")?.focus(); }
  });
  document.querySelectorAll(".theme-btn").forEach((b) => (b.onclick = cycleTheme));
  // appearance: list header (global), chat header overflow menu (per chat)
  $("appearanceBtn").onclick = () => Appearance.open(null);
  $("moreBtn").onclick = openChatMenu;
  $("chatMenu").addEventListener("click", (e) => { if (e.target === $("chatMenu")) closeChatMenu(); });
  $("chatMenuList").addEventListener("keydown", onChatMenuKey);
  $("menuWallpaper").onclick = () => { closeChatMenu(); Appearance.open(S.peer); };
  $("menuAppearance").onclick = () => { closeChatMenu(); Appearance.open(null); };
  $("apDone").onclick = () => Appearance.close();
  $("appearance").addEventListener("click", (e) => { if (e.target === $("appearance")) Appearance.close(); });
  radioKeys($("apMode"), (b) => { if (b.dataset.scheme !== currentTheme()) setTheme(b.dataset.scheme); });
  radioKeys($("apThemes"), (b) => Appearance.setPreset(b.dataset.preset));
  radioKeys($("apScope"), (b) => { Appearance.scope = b.dataset.scope; Appearance.renderSheet(); });
  radioKeys($("apWalls"), (b) => {
    const kind = b.dataset.kind;
    Appearance.setWallpaper(kind === "default" ? DEFAULT_WP : kind === "image" ? { kind: "image" } : { kind, index: +b.dataset.index });
  });
  $("apChoose").onclick = () => $("apFile").click();
  $("apFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; Appearance.importImage(f); };
  $("apDim").addEventListener("input", (e) => Appearance.setDim(parseFloat(e.target.value)));
  $("apReset").onclick = () => Appearance.resetChat();
  // drag & drop an image onto the wallpaper section
  const drop = $("apWallSec");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  drop.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); drop.classList.add("drop"); } });
  drop.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("drop"); });
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drop"); Appearance.importImage(e.dataTransfer.files[0]); });
  // auto mode follows the system: refresh the theme-color + the dim default shown in the sheet
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    syncThemeColor();
    if (!$("appearance").hidden) Appearance.renderSheet();
  });
  $("devBtn").onclick = () => ($("devDrawer").hidden ? openDev() : closeDev(true));
  $("closeDev").onclick = () => closeDev(true);
  $("clearLog").onclick = () => { $("log").innerHTML = ""; };
  $("logoutBtn").onclick = signOut;
  $("bannerRetry").onclick = () => { if (!S.closing && S.ws?.readyState !== 1) connect(); };

  // thread
  $("backBtn").onclick = goBack;
  $("callBtn").onclick = () => window.CallUI?.start(S.peer);
  $("callsOnlyCall").onclick = () => window.CallUI?.start(S.peer);
  $("scroller").addEventListener("scroll", () => Thread.onScroll(), { passive: true });
  $("jumpBtn").onclick = () => { Thread.scrollToBottom(true); if (finePointer()) $("text").focus({ preventScroll: true }); };
  $("scroller").addEventListener("click", (e) => {
    const zoom = e.target.closest("[data-zoom]");
    if (zoom) { const img = zoom.querySelector("img"); openViewer(img.src, img.alt); return; }
    if (e.target.closest("[data-callback]")) { window.CallUI?.start(S.peer); return; }
    const resend = e.target.closest("[data-resend]");
    if (resend) { Thread.resend(resend.dataset.resend); return; }
    if (e.target.closest("[data-retry-thread]")) { S.thread.error = null; openPeer(S.peer); }
  });
  // composer
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); Composer.sendText(); $("text").focus(); });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); Composer.sendText(); }
  });
  $("text").addEventListener("input", () => Composer.onInput());
  $("text").addEventListener("blur", () => Composer.stopTyping());
  $("attachBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => { pickFile(e.target.files[0]); e.target.value = ""; };
  $("sheetCancel").onclick = closeSheet;
  $("sheetClose").onclick = closeSheet;
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  $("sheetSend").onclick = () => { const f = sheetFile; closeSheet(); sendFile(f); };
  $("viewerClose").onclick = closeViewer;
  $("viewer").addEventListener("click", (e) => { if (e.target.closest(".viewer-stage") && e.target.tagName !== "IMG") closeViewer(); });

  // Escape: top layer first, then the dev drawer, then "back" on phones.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const top = layers[layers.length - 1];
    if (top) { if (top.onEscape) { e.preventDefault(); top.onEscape(); } return; }
    if (!$("devDrawer").hidden) { e.preventDefault(); closeDev(true); return; }
    if (S.me && S.peer && isPhone()) { e.preventDefault(); goBack(); }
  });

  // viewport
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  window.addEventListener("resize", syncViewport);
  syncViewport();

  // Reading happens when the tab becomes visible. (Presence is left "online" while the tab is hidden,
  // so testing with two tabs doesn't make the other person look offline.)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.chatId && S.ws?.readyState === 1) {
      send("mark_read", { chat_id: S.chatId });
      if (S.convos[S.peer]) { S.convos[S.peer].unread_count = 0; renderConvos(); }
    }
  });
  // Browsers only start audio after a user gesture; the first click unlocks the ringtones.
  document.addEventListener("pointerdown", () => window.CallUI?.unlockAudio(), { once: true });
  if ("Notification" in window && Notification.permission === "default") document.addEventListener("click", () => Notification.requestPermission(), { once: true });
}

// Shared with demo-call.js (and handy in the console).
window.DemoApp = { S, $, send, log, nameOf, avatarHtml, icon, esc, announce, toast, hasChat, hasCall, fmtDuration, openLayer, closeLayer, reducedMotion, isPhone, Appearance };

wire();
init().catch((e) => log("err", String(e)));
})();
