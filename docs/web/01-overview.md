# commskit-web: overview

`comms-kit/web` is the browser chat UI of the comms kit. It is a React package you drop into an existing website or React app.
It talks to the kit backend over one WebSocket plus a few REST calls, using the protocol in [`docs/archive/PROTOCOL.md`](../archive/PROTOCOL.md).
A message sent from the web shows up in the phone app, and the other way round.

Everything here was checked against the code in `web/`, `mobile/src/engine`, `examples/web-app` and `backend/`.
Items marked **(unverified)** could not be confirmed from the code.

Series: **01 Overview (this file)** | [02 Keys, secrets, WebSockets, placeholders](02-keys-secrets-websockets-and-placeholders.md) | [03 Using, running, deploying](03-using-running-and-deploying.md) | [04 Customizing the UI](04-customizing-the-ui.md) | [Web example app](../example/web-example.md) | [Design system](../design/design-overview.md)

## Table of contents
1. [What it is](#1-what-it-is)
2. [Why you need it](#2-why-you-need-it)
3. [Module map and exports](#3-module-map-and-exports)
4. [Feature list](#4-feature-list)
5. [How it shares the engine with mobile](#5-how-it-shares-the-engine-with-mobile)
6. [Browser support](#6-browser-support)
7. [What is NOT included](#7-what-is-not-included)
8. [Tests](#8-tests)

## 1. What it is

| Item | Value (from `web/package.json`) |
|---|---|
| npm name | `commskit-web` (unscoped, version `0.1.0`) |
| License field | `UNLICENSED` |
| Format | ESM only (`"type": "module"`), TypeScript types in `dist/index.d.ts` |
| Entry points | `commskit-web` -> `dist/index.js`; `commskit-web/styles.css` -> `dist/styles.css` |
| Peer dependencies | `react >= 18`, `react-dom >= 18` |
| Runtime dependencies | none (the shared engine is bundled in) |
| `sideEffects` | only `**/*.css` (the JS is tree-shakeable) |
| Build | `npm run build` = `tsup` (ESM, target es2020, sourcemaps, `.d.ts`) then `node scripts/copy-css.mjs` |
| Output size here | `dist/index.js` about 223 KB unminified (your bundler minifies it) |

There is no UI framework, no icon library and no emoji library. Styling is one plain CSS file (`web/src/styles.css`, 288 lines) driven by CSS variables.

## 2. Why you need it

Without it you would have to build, for the browser: the socket client with reconnect, the message store (ordering, ticks, unread counts,
paging, optimistic send), the media upload, and the whole UI (list, chat, composer, menus, dialogs, appearance, accessibility).
`commskit-web` gives you all of that, ready to mount with a few lines, and keeps it identical to the phone app because both share the same engine.

Your site only supplies: the server URL, the logged-in user's token and id (see [02](02-keys-secrets-websockets-and-placeholders.md)), and where to put the component.

## 3. Module map and exports

All exports come from `web/src/index.ts` (verified). Source files are in `web/src/`.

| Area | File | Exports |
|---|---|---|
| Providers | `providers.tsx` | `CommsWebProvider`, `ChatProvider`, `ModerationProvider`, `CommsStack` (all three in order), `createBrowserAppState` |
| Hooks | `providers.tsx` | `useComms`, `useConnectionStatus`, `useIsConnected`, `useUserProfile`, `useConversations`, `useConversation`, `useUnreadCount`, `useChat`, `useChatApi`, `useChatContext`, `useChatErrors`, `useBlocking`, `useOptionalBlocking` |
| Screens | `ChatApp.tsx`, `ConversationListScreen.tsx`, `ChatScreen.tsx`, `sheets.tsx` | `ChatApp` (responsive, ready-made), `ConversationListScreen`, `ConversationRow`, `displayName`, `ChatScreen`, `ChatHeader`, `BlockedUsersScreen` |
| Messages and composer | `messages.tsx`, `Composer.tsx` | `MessageList`, `MessageBubble`, `Linkified`, `Composer`, `TYPING_IDLE_MS`, `TYPING_THROTTLE_MS` |
| Sheets and viewers | `sheets.tsx` | `AppearanceSheet`, `AttachmentPreviewSheet`, `ReportSheet`, `ImageLightbox`, `DocumentViewer` |
| UI pieces | `ui.tsx` | `Avatar`, `ConfirmDialog`, `ConnectionBanner`, `Dialog`, `Icon`, `LiveRegion`, `PopupMenu`, `ToastStack` |
| Appearance | `appearance.tsx` | `AppearanceProvider`, `useAppearance`, `useTheme`, `ChatWallpaper`, `themeCssVars`, `APPEARANCE_STORAGE_KEY` (`"commskit.appearance.v1"`) |
| Notifications | `notifications.tsx` | `useWebNotifications`, `InAppMessageBanners` |
| Small hooks | `hooks.ts` | `useAnnouncer`, `useElementWidth`, `useKeyboardInset`, `useReducedMotion`, `useTabVisible`, `useTicker`, `useToasts` |
| Util | `util.ts` | `downscaleImageFile`, `readUrlAsBase64`, `resolveMediaUrl`, `splitLinks` |
| Styles | `styles.css` | imported as `commskit-web/styles.css` |
| Engine re-exports | from `commskit/engine` | `CommsClient`, `ChatStore`, `ModerationStore`, `UserDirectory`, `DEFAULT_UNSEND_WINDOW_SECONDS`, `MAX_UPLOAD_BYTES`, `REPORT_CATEGORIES`, `themePresets`, `tokens`, `wallpapers`, and types (`CommsConfig`, `ChatMessage`, `Conversation`, `MessageAction`, `AppearanceState`, ...) |

Note: `consoleLogger` and the `Logger` type exist in the engine but are **not** re-exported by `commskit-web`. If you want logging, pass your own
object with `debug/info/warn/error` methods as `config.logger`.

Rule of thumb: mount `ChatApp` for the quickest result; use `ConversationListScreen` + `ChatScreen` when you own the routing; use the hooks
when you want a fully custom UI.

## 4. Feature list

Taken from the code (`web/src/*`) and `web/README.md`, spot-checked against tests.

**Conversation list**
- Search over names and last-message text; All / Unread chips with counts; host-supplied extra filters.
- Blocked rows, typing preview, unread badges (99+), skeleton rows, empty states.
- Arrow-key navigation (one tab stop for the list).

**Chat header**
- Back button (single pane), avatar and presence dot, last-seen text refreshed every 60 s, `typing...`, blocked states.
- Overflow menu: Wallpaper, Report, Block / Unblock, Clear chat, plus your own items.

**Messages**
- Grouping (same sender within 5 minutes), tails, date separators and a floating date label.
- Ticks: sending, sent, delivered, read. Failed messages with Retry. System chips. Deleted bubbles. Call-log entry chips.
- Images with thumbnails and a lightbox (Download / Share); `<video controls>`; `<audio controls>`; file cards with coloured type badges and size.
- Document viewer in an iframe, only if you supply `documentViewerUrl`; otherwise a Download button.
- **Clickable links** in message text (`http`, `https`, `www.`; opened in a new tab with `rel="noopener noreferrer nofollow"`; trailing punctuation stays outside the link).
- Reply with quote, jump to the quoted message and highlight it.
- Jump-to-latest button with a new-message count; older messages load when you scroll to the top and the scroll position is kept.
- Windowing: only the newest 120 rows are in the DOM, 120 more are added as you scroll up (`windowSize` default in `messages.tsx`). Rows are not removed again once shown.
- `aria-live` announcements for screen readers.

**Composer**
- Auto-growing textarea (up to 6 lines), Enter sends, Shift+Enter is a newline, throttled typing events.
- Attach menu: Gallery, Camera (`capture`), Video, Document.
- **Drag and drop** files onto the chat, and **paste** files from the clipboard (`onPaste` reads `clipboardData.files`).
- Preview sheet with the 10 MB check (`MAX_UPLOAD_BYTES`; override with `maxUploadBytes`), reply bar, blocked / gate / disabled states, rate-limit notice.
- Emoji: use the operating system picker (no emoji library).

**Message actions** (right-click, long-press on touch, or the hover button)
- Reply, Copy text, Download, Share (`navigator.share`, only where it exists), Delete for me, Delete for everyone (within `unsendWindowSeconds`), Report message. Swipe right on touch to reply.

**Moderation**: `ReportSheet` (7 categories, details, "also block"), `BlockedUsersScreen`, blocked composer states.

**Appearance**: light / dark / system, 7 chat themes, wallpapers (default, 8 solids, 5 gradients, your own picture downscaled to 1600 px, dim slider), global or per chat, saved in `localStorage` under one key. See the [design overview](../design/design-overview.md).

**Connection**: banner (Connecting... / Offline. Retrying in Ns + Retry), reconnect with backoff, tab visibility sends `user_status` online / away, the browser `online` event reconnects at once.

**Notifications**: desktop notifications through the browser `Notification` API when the tab is hidden, plus in-app banners for messages in other chats.

**Layout**: `100dvh` friendly, safe-area insets, `visualViewport` keyboard inset, reduced motion respected, 320 px wide without horizontal scroll.
`ChatApp` shows one pane below 700 px and list + chat side by side from 700 px.

## 5. How it shares the engine with mobile

The mobile package (`mobile/`) contains a framework-free "engine" at `mobile/src/engine/index.ts`, imported as `commskit/engine`.

| Engine part | What it does |
|---|---|
| `CommsClient` | the one WebSocket: connect, reconnect with backoff, send, subscribe, status |
| `ChatStore`, `ModerationStore`, `UserDirectory` | all chat / moderation state and rules |
| `authFetch`, `startChat`, ... | the REST calls |
| `chat-ui/*` helpers | formatting, grouping, previews, last seen, filters, message actions, sticky date |
| `theme/*` | `tokens` (a TypeScript copy of `design/tokens.json`), `createTheme`, appearance model |

The engine imports neither `react` nor `react-native` (enforced by `mobile/__tests__/engineEntry.test.ts`, as stated in the file header; I did not run that test).

How the web package uses it:
- **Alias:** `commskit/engine` maps to `../mobile/src/engine/index.ts` in `web/tsconfig.json` (`paths`), `web/tsup.config.ts` (esbuild alias) and `web/vitest.config.ts`.
- **Bundled:** `tsup` inlines the engine into `dist/index.js`. I confirmed `dist/index.js` and `dist/index.d.ts` contain no `commskit/engine` text and that `dist/index.js` imports only `react` and `react/jsx-runtime`.

What that means for you:

| Situation | Consequence |
|---|---|
| You install the built package (registry, tarball, `file:` link to a built `web/`) | You need only `commskit-web` + `react` + `react-dom`. No `mobile/`, no `react-native`. |
| You build `commskit-web` yourself (`npm run build` in `web/`) | The sibling folder `mobile/src` (the engine and what it imports) must exist next to `web/`. Build from a full checkout of the kit. |
| You copy only `web/` into another repo | The build breaks (alias target missing). Copy the whole kit, or publish a tarball built elsewhere. |
| You change the engine | Rebuild `web/` (`npm run build`), then reinstall / restart the consumer. |

Not shared: components and CSS (DOM vs native views), and the call stack.

## 6. Browser support

From `web/README.md` (not independently tested here): current Chrome, Edge, Firefox and Safari 16.4+.
The code uses `WebSocket`, `ResizeObserver`, `matchMedia`, pointer events and canvas (wallpaper downscaling); optionally `visualViewport`,
`Notification` and `navigator.share`. The optional APIs are guarded in the code (`typeof Notification`, `typeof window`, try/catch around storage).
The only automated real-browser run is Chrome (see the [web example](../example/web-example.md)). Firefox and Safari are **unverified** by tests.

## 7. What is NOT included

| Not included | Detail |
|---|---|
| Voice / video calls | `commskit-web` has no calling code. `ChatScreen` has an `onCall` slot: pass it and you get a call button and "Call back" on call entries. Nothing is dialled by the package. The plain HTML demo `examples/backend/demo-server-python/demo.html` + `demo-call.js` does have WebRTC calls (reference only, not importable). |
| Push with the tab closed | No service worker, no Web Push, no VAPID key. Notifications only work while the page is open (a hidden tab is fine). `POST /devices` accepts `platform: "web"` on the server, but the package never calls it. See [02](02-keys-secrets-websockets-and-placeholders.md#b-config-value-reference). |
| Emoji picker | Uses the OS picker. |
| Login / accounts | You provide the token (`getToken`) and user id (`getUserId`). |
| A "find people" UI | You decide who can chat with whom; start a chat with `useChatApi().startChat(userId)`. |
| True list virtualization | Windowed (see above); all loaded messages stay in memory. |
| Server-side rendering | Not tested. The package guards `window` / `document` in most places, but ships no `'use client'` directive. **(unverified)** |
| Offline message queue | Default policy is `"drop"` (a send while offline fails and shows Retry). `offlineSendPolicy="queue"` is available on the provider. |

## 8. Tests

I ran both commands in `comms-kit/web` on 2026-10-26 (Node v22.23.2, Windows):

```bash
cd web
npx vitest run      # 6 test files, 88 tests passed, 0 failed (about 16 s)
npx tsc --noEmit    # no output, no errors
```

| Test file (`web/test/`) | Tests | Covers |
|---|---|---|
| `chat.test.tsx` | 42 | messages, composer, actions, attachments, 5000-message windowing, paging |
| `appearance.test.tsx` | 15 | themes, wallpapers, AppearanceSheet, tokens equal `design/tokens.json` |
| `hooks.test.tsx` | 12 | providers and hooks |
| `list.test.tsx` | 10 | conversation list, filters, keyboard navigation |
| `notifications.test.tsx` | 6 | desktop notifications and banners |
| `app.test.tsx` | 3 | `ChatApp` responsive layout |

Setup: vitest 2 with `jsdom` and a fake WebSocket (`web/test/harness.tsx`); config in `web/vitest.config.ts`. `npm run verify` runs typecheck, tests and build.

Real-browser end-to-end: `examples/web-app` has a 16-step Playwright-core run (`npm run e2e`) against a real demo server. I did not run it for this document.
See the [web example](../example/web-example.md).
