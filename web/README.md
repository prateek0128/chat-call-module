# @snakechat/commskit-web

React (react-dom) chat UI for the browser: the web twin of the React Native chat UI (`commskit/chat-ui`).
It speaks the same wire protocol ([`../docs/archive/PROTOCOL.md`](https://github.com/prateek0128/chat-call-module/blob/main/docs/archive/PROTOCOL.md)) and shares the same
framework-free engine, so a message sent from the web shows up in the phone app and the other way round.
Plain CSS (variables from [`design/tokens.json`](https://github.com/prateek0128/chat-call-module/blob/main/design/tokens.json)), no UI framework, no icon or emoji library.

- Chat only. **There are no voice calls in this package** (the vanilla browser demo, `examples/backend/demo-server-python/demo.html`, has WebRTC calls).
  Calls are a callback slot: pass `onCall` and you get a call button and "Call back" on call entries.
- ESM + TypeScript types. Peer deps: `react >= 18`, `react-dom >= 18`.

## Install

```bash
cd web && npm install && npm run build       # dist/index.js, dist/index.d.ts, dist/styles.css
```

```bash
npm install @snakechat/commskit-web react react-dom
```

Or in `package.json`:

```jsonc
"dependencies": { "@snakechat/commskit-web": "^0.1.0", "react": "^19", "react-dom": "^19" }
```

```ts
import "@snakechat/commskit-web/styles.css";
```

If your bundler resolves a linked package's own `react`, make sure there is a single copy (Vite: `resolve.dedupe: ["react", "react-dom"]`).

## Quick start

```tsx
import { AppearanceProvider, ChatApp, CommsStack } from "@snakechat/commskit-web";
import "@snakechat/commskit-web/styles.css";

const config = {
  baseUrl: "https://api.example.com",            // REST; the socket URL is derived (wss://api.example.com/ws/<token>)
  getToken: () => localStorage.getItem("token"), // called on every (re)connect and REST call
  getUserId: () => localStorage.getItem("userId"),
};

export default function App() {
  return (
    <AppearanceProvider>
      <CommsStack config={config}>
        <div style={{ height: "100dvh" }}>
          <ChatApp />                              {/* phone: one pane + back; 700px+: list + chat */}
        </div>
      </CommsStack>
    </AppearanceProvider>
  );
}
```

`CommsStack` is `CommsWebProvider` → `ModerationProvider` → `ChatProvider`. The two screens on their own, with your own routing:

```tsx
<ConversationListScreen selectedPeerId={id} onSelect={(peerId) => navigate(`/chat/${peerId}`)} />
<ChatScreen peerId={id} onBack={() => navigate("/")} />
```

Starting a chat with someone who has no conversation yet is the host's job (`useChatApi().startChat(userId)`, then select them);
see `examples/web-app` ("New chat").

## What you get

| Area | Included |
|---|---|
| List | search over names **and** last-message text, All / Unread (with counts) chips, host filters, blocked rows, typing preview, unread badges (99+), skeleton rows, empty states, arrow-key navigation (roving tab stop) |
| Header | back, avatar + presence dot, last-seen line refreshed every 60 s, `typing…`, blocked states, overflow menu: Wallpaper, Report, Block / Unblock, Clear chat (+ your items) |
| Messages | grouping within 5 min, tails, date separators + floating date label, ticks (sending / sent / delivered / read), inline time, failed + Retry, system chips, deleted bubbles, call entry chips (side-aware, "Call back"), image thumbnails + lightbox (Download / Share), `<video controls>`, `<audio controls>`, file cards with coloured type badges and size, document viewer (iframe through `documentViewerUrl`), clickable links, quote jump + highlight, jump-to-latest with new count, older messages load on scroll-top keeping the position, windowing (a few hundred DOM rows for 5 000 messages), `aria-live` announcements |
| Composer | auto-grow textarea (max 6 lines), Enter sends / Shift+Enter newline, throttled typing events, attach menu (Gallery, Camera via `capture`, Video, Document), drag and drop + paste image, preview sheet with the 10 MB check, reply bar, blocked / gate / disabled states, rate-limit notice, emoji via the OS picker (a hint, no emoji library) |
| Actions | right-click, long-press (touch) or the hover ⋮ button: Reply, Copy text, Download, Share (`navigator.share`), Delete for me, Delete for everyone (within `unsendWindowSeconds`), Report message; swipe right to reply on touch |
| Moderation | `ReportSheet` (7 categories + details + also block), `BlockedUsersScreen`, blocked composer states |
| Appearance | mode (light / dark / system), 7 chat themes, wallpapers (default, 8 solids, 5 gradients, your own picture downscaled to 1600 px, dim slider), global and per chat; live preview; persisted in `localStorage` |
| Connection | `ConnectionBanner` (Connecting… / Offline. Retrying in Ns + Retry), tab visibility → `user_status` online / away, `online` event → immediate reconnect |
| Notifications | `useWebNotifications` (Notification API) + in-app banners for messages in other chats |
| Layout | 100dvh friendly, safe-area insets, `visualViewport` keyboard inset, reduced motion, 320 px without horizontal scroll |

## Props

### `CommsWebProvider` (`CommsStack`)
| Prop | Meaning |
|---|---|
| `config` | `{baseUrl, wsUrl?, getToken, getUserId, logger?}`. Callbacks may change identity every render. |
| `autoConnect` | Connect on mount (default true). `false`: call `useComms().client.connect()` after login. |
| `offlineSendPolicy`, `pingIntervalMs` | Passed to the engine (`"drop"` default / `"queue"`). |
| `createWebSocket` | Replace the browser `WebSocket` (tests). |
| `client`, `users` | Bring your own `CommsClient` / `UserDirectory`. |

`CommsStack` also takes `moderation` (default true), `onError` (chat errors), `comms` and `chat` (extra provider props).

### `ChatApp`
`selectedPeerId` / `defaultPeerId` / `onSelectedChange`, `chat` (props for every `ChatScreen`), `list` (props for the list),
`notifications` (`false` or `useWebNotifications` options), `banners` (in-app banners, default true), `placeholder` (empty chat pane).

### `ConversationListScreen`
`selectedPeerId`, `onSelect(peerId, conversation)`, `title`, `filters` (extra chips: `{key, label, predicate, showCount?, emptyTitle?, emptyText?}`),
`emptyTitle` / `emptyText`, `onOpenAppearance` (custom handler, or `false` to hide the button), `blockedUsers` (show the Blocked users button),
`headerActions`, `clock` (`"12h"` / `"24h"`).

### `ChatScreen`
| Prop | Meaning |
|---|---|
| `peerId`, `chatId?` | Who to chat with. |
| `onBack` | Shows the back button (single pane). |
| `onCall` | Shows a call button and "Call back" on call entries. Nothing is dialled by this package. |
| `renderActions` | Extra header buttons. |
| `peerName` | Name until the directory knows it. |
| `disabledReason` | Disables the composer ("Chat is not enabled"). |
| `gate(info)` | Pre-chat gate (e.g. consent): rendered over messages + composer while it returns a node. |
| `documentViewerUrl(message, fileUrl)` | Return an iframe URL to preview documents in the viewer. Without it the viewer offers Download. |
| `unsendWindowSeconds` | Mirror of the server's `unsend_window_seconds` (default 3600; 0 no limit; -1 off). |
| `maxUploadBytes` | Default 10 MB. |
| `appearanceMenu` / `moderationMenu` | Wallpaper / Report + Block menu items (default: when the provider exists). |
| `menuItems`, `messageActions` | Extra header menu items / message actions. |
| `replies`, `swipeToReply` | Reply UI (default true). |
| `mediaBaseUrl` | Base for relative `file_url`s (default `config.baseUrl`). |
| `showConnectionBanner`, `active`, `clock`, `placeholder`, `className` | As named. |

### Hooks
`useConversations()`, `useConversation(peerId, {chatId?, active?})` (messages newest first, `send`, `sendMedia`, `loadMore`, `deleteMessage`,
`clearChat`, `retryMessage`, `setTyping`, `typing`, `rateLimitedUntil`, `thread`, `conversation`), `useUnreadCount()`, `useChat()`,
`useChatApi()` (`startChat`, push token calls), `useBlocking()` / `useOptionalBlocking()`, `useConnectionStatus()`, `useUserProfile(id)`,
`useChatErrors(handler)`, `useAppearance()`, `useTheme()`, `useWebNotifications(options)`.
They return the same shapes as the React Native hooks.

## Theming and appearance

`AppearanceProvider` renders the `.ck-root` element that carries every design token as a CSS variable (`--ck-accent`, `--ck-bubble-out`,
`--ck-radius-bubble`, ...). All screens must be inside it. The values come from `commskit/engine` (`theme/tokens.ts`, checked against
`design/tokens.json` by the mobile tests, and again by `web/test/appearance.test.tsx`). Override with `theme={{colors: {...}, schemes: {...}}}`;
the user's chosen theme preset is applied on top. Props: `storage` (any `{getItem, setItem}`; `null` disables persistence), `storageKey`, `initial`,
`value` + `onChange` (controlled), `onStorageError` (quota full: the choice stays for the session; the sheet says so), `className`, `style`.

Style hooks: classes are prefixed `ck-`; override variables on `.ck-root` or rules in your own CSS loaded after `styles.css`.

**What end users can change** (Appearance sheet, saved per browser): colour mode, chat theme, wallpaper (solid, gradient or their own photo; all chats or one chat), **text size** (small / medium / large) and **density** (comfortable / compact). `useAppearance()` exposes `textSize`, `density`, `setTextSize` and `setDensity`.

Full guide: [Customizing the UI](https://github.com/prateek0128/chat-call-module/blob/main/docs/web/04-customizing-the-ui.md).

**Replacing components** (developers): pass `components` to `AppearanceProvider`. A replacement gets the same props as the built-in, so it keeps the full chat behaviour, and may render the built-in itself.

```tsx
import { AppearanceProvider, DefaultAvatar, type CommsComponents } from "@snakechat/commskit-web";

const MyBubble: CommsComponents["MessageBubble"] = ({ message }) => <div className="my-bubble">{message.content}</div>;

<AppearanceProvider components={{ MessageBubble: MyBubble, Avatar: (p) => <DefaultAvatar {...p} size={32} /> }}>...</AppearanceProvider>
```

Every UI component is a slot (`CommsComponents`): `ChatApp`, `ChatScreen`, `ChatHeader`, `MessageList`, `MessageBubble`, `Linkified`, `Composer`, `ConversationListScreen`, `ConversationRow`, `Avatar`, `Icon`, `Dialog`, `ConfirmDialog`, `PopupMenu`, `ToastStack`, `LiveRegion`, `ConnectionBanner`, `ChatWallpaper`, `InAppMessageBanners`, `AppearanceSheet`, `ReportSheet`, `BlockedUsersScreen`, `AttachmentPreviewSheet`, `ImageLightbox`, `DocumentViewer`. The built-ins are exported as `Default<Name>`.

**Fully custom UI:** skip the components and build your own on the headless hooks (`useChat`, `useConversations`, `useConversation`, `useUserProfile`, `useChatErrors`, `useConnectionStatus`, `useBlocking`, `useUnreadCount`); they hold all the chat logic and no markup.

## Notifications

```tsx
const n = useWebNotifications({ onOpenChat: (peerId) => select(peerId), soundUrl: "/ping.mp3" });
<button onClick={() => n.requestPermission()}>Enable notifications</button>   // must come from a click
```

A desktop notification is shown for each new message from a chat that is not open while the tab is hidden (a hidden tab does not count as "open").
Clicking it focuses the tab and calls `onOpenChat`. `ChatApp` wires this up and shows a bell button while the permission is still undecided.
In the foreground, `InAppMessageBanners` (also in `ChatApp`) shows a banner for messages in other chats. Notifications need a secure context
(HTTPS or localhost). Closed-tab push needs a service worker and Web Push, which this package does not include (`POST /devices` accepts `platform: "web"`).

## Browser support
Current Chrome, Edge, Firefox and Safari (16.4+). Uses `WebSocket`, `ResizeObserver`, `matchMedia`, `visualViewport` (optional), pointer events,
`Notification` (optional), `navigator.share` (optional), canvas (wallpaper downscaling). Touch: long-press for the message menu, swipe right to reply.

## How it relates to the React Native package

- One engine, two UIs: `mobile/src/engine/index.ts` (`commskit/engine`) re-exports the socket client (`CommsClient`), `ChatStore`,
  `ModerationStore`, `UserDirectory`, wire types, and the pure UI helpers (formatting, grouping, previews, last seen, filters, document badges,
  message actions, sticky date, tokens, `createTheme`, appearance model). It imports neither `react` nor `react-native`
  (`mobile/__tests__/engineEntry.test.ts`). `@snakechat/commskit-web` aliases it (`tsconfig` `paths`, `tsup` / `vitest` aliases) and **bundles** it into
  `dist/index.js`, so apps install only `@snakechat/commskit-web`. Nothing from `react-native` is pulled in.
- The providers and hooks (`CommsWebProvider`, `ChatProvider`, `useConversation`, ...) are thin React bindings with the same names and
  return shapes as the RN ones; `CommsWebProvider` uses the browser `WebSocket` and the tab visibility as the "app state".
- Not shared: components and CSS (DOM vs native views), and the call stack.

## Development

```bash
npm run typecheck && npm test && npm run build    # tsc, vitest (jsdom + a fake WebSocket), tsup
```
The real-browser end-to-end run lives in `../examples/web-app` (`npm run e2e`).
