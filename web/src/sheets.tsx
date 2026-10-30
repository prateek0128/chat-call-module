/** Sheets and viewers: AppearanceSheet, ReportSheet, BlockedUsersScreen, AttachmentPreviewSheet, ImageLightbox, DocumentViewer. */
import { slot } from "./components";
import React, { useEffect, useRef, useState } from "react";
import {
  checkAttachmentSize,
  documentBadge,
  documentMeta,
  formatFileSize,
  canSubmitReport,
  reportCategoryOptions,
  themePresets,
  wallpapers,
  clampDim,
  type ReportCategory,
  type Wallpaper,
} from "commskit/engine";
import { ChatWallpaper, useAppearance } from "./appearance";
import { useBlocking } from "./providers";
import { Avatar, Dialog, Icon } from "./ui";
import { cx, downloadFile, downscaleImageFile } from "./util";

// ---- AppearanceSheet ----------------------------------------------------------------------------------------

const TEXT_SIZE_OPTIONS = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
] as const;

const DENSITY_OPTIONS = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
] as const;

const MODES = [
  { id: "system", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

const sameWallpaper = (a: Wallpaper, b: Wallpaper): boolean =>
  a.kind === b.kind && (a.kind === "default" || (a.kind === "image" && b.kind === "image" ? a.uri === b.uri : "index" in a && "index" in b && a.index === b.index));

export const DefaultAppearanceSheet: React.FC<{
  /** Per-chat mode: opens on "This chat". Omit for the global sheet. */
  peerId?: string | null;
  peerName?: string | null;
  onClose: () => void;
  /** Called with a message when the picture could not be read or stored. */
  onNotice?: (text: string) => void;
}> = ({ peerId, peerName, onClose, onNotice }) => {
  const a = useAppearance();
  const [scope, setScope] = useState<"chat" | "all">(peerId ? "chat" : "all");
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<Wallpaper | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scheme = a.scheme;
  const set = wallpapers[scheme];
  const effective: Wallpaper = scope === "chat" && peerId ? a.wallpaperFor(peerId) : a.wallpaper;
  const opts = scope === "chat" && peerId ? { peerId } : undefined;
  const apply = (w: Wallpaper) => a.setWallpaper(w, opts);

  const importImage = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      const t = "Choose an image file.";
      setNotice(t);
      onNotice?.(t);
      return;
    }
    setPicking(true);
    try {
      const uri = await downscaleImageFile(file, wallpapers.imageMaxEdge);
      const w: Wallpaper = { kind: "image", uri };
      setSession(w);
      apply(w);
    } catch {
      const t = "Couldn't read that picture.";
      setNotice(t);
      onNotice?.(t);
    } finally {
      setPicking(false);
    }
  };

  const image = effective.kind === "image" ? effective : session && session.kind === "image" ? session : null;
  const dim = effective.kind === "image" ? clampDim(effective.dim, scheme) : 0;
  const tile = (key: string, label: string, w: Wallpaper, style: React.CSSProperties) => {
    const selected = sameWallpaper(effective, w);
    return (
      <button key={key} type="button" className={cx("ck-tile", selected && "is-selected")} aria-label={label} aria-pressed={selected} onClick={() => apply(w)} style={style}>
        {selected ? <Icon name="check" size={18} /> : null}
      </button>
    );
  };

  return (
    <Dialog label="Appearance" onClose={onClose} className="ck-appearance">
      <div
        className="ck-sheet-scroll"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void importImage(e.dataTransfer?.files?.[0]);
        }}
      >
        <div className="ck-sheet-head">
          <h2 className="ck-dialog-title">{peerId ? "Wallpaper" : "Appearance"}</h2>
          <button type="button" className="ck-btn ck-btn-primary" onClick={onClose} data-autofocus>
            Done
          </button>
        </div>

        <div className="ck-preview" aria-label="Preview">
          <ChatWallpaper wallpaper={effective} />
          <div className="ck-preview-bubbles">
            <div className="ck-bubble ck-in ck-tail">Hi! How does this look?</div>
            <div className="ck-bubble ck-out ck-tail">Great, I love it.</div>
          </div>
        </div>

        {peerId ? (
          <section>
            <h3 className="ck-section-title">Apply to</h3>
            <div className="ck-segmented" role="radiogroup" aria-label="Wallpaper scope">
              {([["chat", peerName ? `This chat` : "This chat"], ["all", "All chats"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={scope === id} className={cx("ck-seg", scope === id && "is-selected")} onClick={() => setScope(id)}>
                  {label}
                </button>
              ))}
            </div>
            {a.hasOverride(peerId) ? (
              <button type="button" className="ck-link-btn" onClick={() => a.resetWallpaper(peerId)}>
                Reset this chat
              </button>
            ) : null}
          </section>
        ) : null}

        <section>
          <h3 className="ck-section-title">Text size</h3>
          <div className="ck-segmented" role="radiogroup" aria-label="Text size">
            {TEXT_SIZE_OPTIONS.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={a.textSize === o.id} className={cx("ck-seg", a.textSize === o.id && "is-selected")} onClick={() => a.setTextSize(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="ck-section-title">Density</h3>
          <div className="ck-segmented" role="radiogroup" aria-label="Density">
            {DENSITY_OPTIONS.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={a.density === o.id} className={cx("ck-seg", a.density === o.id && "is-selected")} onClick={() => a.setDensity(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="ck-section-title">Mode</h3>
          <div className="ck-segmented" role="radiogroup" aria-label="Color mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={a.mode === m.id} className={cx("ck-seg", a.mode === m.id && "is-selected")} onClick={() => a.setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="ck-section-title">Theme</h3>
          <div className="ck-swatches" role="group" aria-label="Theme">
            {themePresets.order.map((p) => (
              <button
                key={p}
                type="button"
                className={cx("ck-swatch", a.preset === p && "is-selected")}
                aria-label={`${themePresets.labels[p]} theme`}
                aria-pressed={a.preset === p}
                title={themePresets.labels[p]}
                style={{ background: themePresets[scheme][p].accent, color: themePresets[scheme][p].onAccent }}
                onClick={() => a.setPreset(p)}
              >
                {a.preset === p ? <Icon name="check" size={18} /> : null}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="ck-section-title">Wallpaper</h3>
          <div className="ck-tiles">
            <button type="button" className={cx("ck-tile ck-tile-default", effective.kind === "default" && "is-selected")} aria-label="Default wallpaper" aria-pressed={effective.kind === "default"} onClick={() => apply({ kind: "default" })}>
              <ChatWallpaper wallpaper={{ kind: "default" }} className="ck-tile-bg" />
              {effective.kind === "default" ? <Icon name="check" size={18} /> : null}
            </button>
            {set.solids.map((c, i) => tile(`s${i}`, `Solid ${i + 1} wallpaper`, { kind: "solid", index: i }, { background: c }))}
            {set.gradients.map(([c1, c2], i) => tile(`g${i}`, `Gradient ${i + 1} wallpaper`, { kind: "gradient", index: i }, { background: `linear-gradient(135deg, ${c1}, ${c2})` }))}
            {image ? (
              <button
                type="button"
                className={cx("ck-tile", effective.kind === "image" && "is-selected")}
                aria-label="Your picture wallpaper"
                aria-pressed={effective.kind === "image"}
                onClick={() => apply({ kind: "image", uri: image.uri, dim: image.dim })}
                style={{ backgroundImage: `url("${image.uri}")`, backgroundSize: "cover", backgroundPosition: "center" }}
              >
                {effective.kind === "image" ? <Icon name="check" size={18} /> : null}
              </button>
            ) : null}
            <button type="button" className="ck-tile ck-tile-choose" aria-label="Choose image" disabled={picking} onClick={() => fileRef.current?.click()}>
              <Icon name="image" size={20} />
              <span>{picking ? "Loading…" : "Choose image…"}</span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden data-testid="wallpaper-file" onChange={(e) => void importImage(e.target.files?.[0]).then(() => (e.target.value = ""))} />
          </div>
          {effective.kind === "image" ? (
            <label className="ck-dim">
              <span>Dim</span>
              <input
                type="range"
                min={0}
                max={wallpapers.imageDimMax}
                step={0.05}
                value={dim}
                aria-label="Dim"
                onChange={(e) => apply({ kind: "image", uri: effective.uri, dim: clampDim(Number(e.target.value), scheme) })}
              />
              <output>{Math.round(dim * 100)}%</output>
            </label>
          ) : null}
          {a.storageFailed || notice ? (
            <p className="ck-note" role="status">
              {notice || "Storage is full, so this choice will only last until you close this tab."}
            </p>
          ) : null}
        </section>
      </div>
    </Dialog>
  );
};

// ---- ReportSheet ---------------------------------------------------------------------------------------------

export const DefaultReportSheet: React.FC<{
  peerId: string;
  name: string;
  /** Reporting one message (its id is sent with the report). */
  messageId?: string | number | null;
  onClose: () => void;
  onDone?: (text: string) => void;
}> = ({ peerId, name, messageId, onClose, onDone }) => {
  const blocking = useBlocking();
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [reason, setReason] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(!blocking.isBlocked(peerId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!canSubmitReport(category, reason) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await blocking.report({ peerId, category: category as ReportCategory, reason: reason.trim(), messageId: messageId ?? undefined, block: alsoBlock && !blocking.isBlocked(peerId) });
      onDone?.(alsoBlock ? `Reported and blocked ${name}` : `Reported ${name}`);
      onClose();
    } catch (e) {
      setError((e as Error)?.message || "Couldn't send the report. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog label={messageId != null ? "Report message" : `Report ${name}`} onClose={onClose} className="ck-report">
      <div className="ck-sheet-scroll">
        <h2 className="ck-dialog-title">{messageId != null ? "Report message" : `Report ${name}`}</h2>
        <p className="ck-dialog-text">Pick what's wrong. Reports are reviewed by the moderation team.</p>
        <div role="radiogroup" aria-label="Report category" className="ck-radio-list">
          {reportCategoryOptions().map((o) => (
            <label key={o.id} className={cx("ck-radio", category === o.id && "is-selected")}>
              <input type="radio" name="ck-report-category" checked={category === o.id} onChange={() => setCategory(o.id)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        <label className="ck-field">
          <span>Details {category === "other" ? "(required)" : "(optional)"}</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
        </label>
        {!blocking.isBlocked(peerId) ? (
          <label className="ck-check">
            <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
            <span>Also block {name}</span>
          </label>
        ) : null}
        {error ? (
          <p className="ck-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="ck-dialog-actions">
        <button type="button" className="ck-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ck-btn ck-btn-danger" disabled={!canSubmitReport(category, reason) || busy} onClick={() => void submit()}>
          {busy ? "Sending…" : "Report"}
        </button>
      </div>
    </Dialog>
  );
};

// ---- BlockedUsersScreen ----------------------------------------------------------------------------------------

export const DefaultBlockedUsersScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const blocking = useBlocking();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    blocking
      .listBlocked()
      .catch((e: Error) => alive && setError(e?.message || "Couldn't load blocked users"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const users = blocking.blockedUsers;
  return (
    <Dialog label="Blocked users" onClose={onClose} className="ck-blocked">
      <div className="ck-sheet-head">
        <h2 className="ck-dialog-title">Blocked users</h2>
        <button type="button" className="ck-btn" onClick={onClose} data-autofocus>
          Close
        </button>
      </div>
      <div className="ck-sheet-scroll">
        {loading && !users.length ? <p className="ck-dialog-text">Loading…</p> : null}
        {error ? (
          <p className="ck-error" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && !users.length && !error ? (
          <div className="ck-empty">
            <p className="ck-empty-title">No blocked users</p>
            <p className="ck-empty-text">People you block will show up here.</p>
          </div>
        ) : null}
        <ul className="ck-blocked-list">
          {users.map((u) => (
            <li key={u.userId} className="ck-blocked-row">
              <Avatar name={u.username} id={u.userId} src={u.avatar} size={40} />
              <span className="ck-row-name">{u.username || `User ${u.userId}`}</span>
              <button type="button" className="ck-btn" aria-label={`Unblock ${u.username || u.userId}`} onClick={() => void blocking.unblock(u.userId)}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
};

// ---- AttachmentPreviewSheet ---------------------------------------------------------------------------------------

export interface PendingAttachment {
  file: File;
  /** object URL for the preview and for the optimistic bubble */
  url: string;
}

export const DefaultAttachmentPreviewSheet: React.FC<{
  attachment: PendingAttachment;
  maxBytes?: number;
  onSend: () => void;
  onCancel: () => void;
}> = ({ attachment, maxBytes, onSend, onCancel }) => {
  const { file, url } = attachment;
  const check = checkAttachmentSize(file.size, maxBytes);
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const badge = documentBadge(file.name, file.type);
  return (
    <Dialog label="Send attachment" onClose={onCancel} className="ck-attach-preview">
      <div className="ck-attach-body">
        {isImage ? <img src={url} alt={file.name} className="ck-attach-thumb" /> : null}
        {isVideo ? <video src={url} className="ck-attach-thumb" controls muted /> : null}
        {!isImage && !isVideo ? (
          <div className="ck-file-card">
            <span className="ck-doc-badge" data-color={badge.colorToken}>
              {badge.label}
            </span>
            <span className="ck-file-text">
              <span className="ck-file-name">{file.name}</span>
              <span className="ck-file-meta">{documentMeta(file.name, file.type, file.size)}</span>
            </span>
          </div>
        ) : null}
        <p className="ck-attach-name">
          {file.name} <span className="ck-muted">{formatFileSize(file.size)}</span>
        </p>
        {!check.ok ? (
          <p className="ck-error" role="alert">
            {check.message}
          </p>
        ) : null}
      </div>
      <div className="ck-dialog-actions">
        <button type="button" className="ck-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ck-btn ck-btn-primary" onClick={onSend} disabled={!check.ok} data-autofocus>
          Send
        </button>
      </div>
    </Dialog>
  );
};

// ---- ImageLightbox / DocumentViewer ---------------------------------------------------------------------------------

export const canShareFiles = (): boolean => typeof navigator !== "undefined" && typeof (navigator as Navigator & { share?: unknown }).share === "function";

export const shareUrl = async (url: string, title?: string | null): Promise<boolean> => {
  try {
    await navigator.share({ url, title: title || undefined });
    return true;
  } catch {
    return false;
  }
};

export const DefaultImageLightbox: React.FC<{ url: string; name?: string | null; onClose: () => void }> = ({ url, name, onClose }) => (
  <Dialog label={name ? `Photo ${name}` : "Photo"} onClose={onClose} variant="full" className="ck-lightbox">
    <div className="ck-lightbox-bar">
      <span className="ck-lightbox-name">{name}</span>
      <a className="ck-btn ck-btn-ghost" href={url} download={name || "image"} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); void downloadFile(url, name); }}>
        <Icon name="download" size={18} /> Download
      </a>
      {canShareFiles() ? (
        <button type="button" className="ck-btn ck-btn-ghost" onClick={() => void shareUrl(url, name)}>
          <Icon name="share" size={18} /> Share
        </button>
      ) : null}
      <button type="button" className="ck-btn ck-btn-ghost" onClick={onClose} aria-label="Close photo" data-autofocus>
        <Icon name="close" size={18} /> Close
      </button>
    </div>
    <div className="ck-lightbox-stage" onClick={onClose}>
      <img src={url} alt={name || "Photo"} onClick={(e) => e.stopPropagation()} />
    </div>
  </Dialog>
);

export const DefaultDocumentViewer: React.FC<{ url: string; name?: string | null; type?: string | null; size?: number | null; viewerUrl?: string | null; onClose: () => void }> = ({
  url,
  name,
  type,
  size,
  viewerUrl,
  onClose,
}) => {
  const badge = documentBadge(name, type);
  return (
    <Dialog label={`Document ${name || ""}`} onClose={onClose} variant="full" className="ck-doc-viewer">
      <div className="ck-lightbox-bar">
        <span className="ck-doc-badge" data-color={badge.colorToken}>
          {badge.label}
        </span>
        <span className="ck-lightbox-name">{name}</span>
        <a className="ck-btn ck-btn-ghost" href={url} download={name || "file"} target="_blank" rel="noopener noreferrer">
          <Icon name="download" size={18} /> Download
        </a>
        <button type="button" className="ck-btn ck-btn-ghost" onClick={onClose} aria-label="Close document" data-autofocus>
          <Icon name="close" size={18} /> Close
        </button>
      </div>
      {viewerUrl ? (
        <iframe className="ck-doc-frame" src={viewerUrl} title={name || "Document"} sandbox="allow-scripts allow-same-origin allow-popups" />
      ) : (
        <div className="ck-empty">
          <p className="ck-empty-title">{name}</p>
          <p className="ck-empty-text">{documentMeta(name, type, size)}. Preview isn't available in the browser, download the file to open it.</p>
        </div>
      )}
    </Dialog>
  );
};

// Host-replaceable (see components.tsx): the exported name looks up `components.<Name>`, falling back to the Default one.
export const AppearanceSheet = slot("AppearanceSheet", DefaultAppearanceSheet);
export const ReportSheet = slot("ReportSheet", DefaultReportSheet);
export const BlockedUsersScreen = slot("BlockedUsersScreen", DefaultBlockedUsersScreen);
export const AttachmentPreviewSheet = slot("AttachmentPreviewSheet", DefaultAttachmentPreviewSheet);
export const ImageLightbox = slot("ImageLightbox", DefaultImageLightbox);
export const DocumentViewer = slot("DocumentViewer", DefaultDocumentViewer);
