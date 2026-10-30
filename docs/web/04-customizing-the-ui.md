# @snakechat/commskit-web: customizing the UI

Everything about the look and structure of the web chat can be changed. There are five levels, from "no code" to "write your own UI".
Use the lowest level that does the job.

Series: [01 Overview](01-overview.md) | [02 Keys, secrets, WebSockets, placeholders](02-keys-secrets-websockets-and-placeholders.md) | [03 Using, running, deploying](03-using-running-and-deploying.md) | **04 Customizing the UI (this file)** | [Web example app](../example/web-example.md) | [Design system](../design/design-overview.md)

Import lines below use the final package name `@snakechat/commskit-web`. Until it is published, use whatever name your app currently resolves
(for example the `file:` link in `examples/web-app`).

## Contents
1. [The five levels](#1-the-five-levels)
2. [Level 1: what end users can change](#2-level-1-what-end-users-can-change)
3. [Level 2: design tokens (colors, sizes, fonts)](#3-level-2-design-tokens-colors-sizes-fonts)
4. [Level 3: CSS and layout props](#4-level-3-css-and-layout-props)
5. [Level 4: replace components](#5-level-4-replace-components)
6. [Level 5: build your own UI on the hooks](#6-level-5-build-your-own-ui-on-the-hooks)
7. [Recipes](#7-recipes)
8. [Rules and gotchas](#8-rules-and-gotchas)
9. [Troubleshooting](#9-troubleshooting)

## 1. The five levels

| Level | Who | What you change | Code needed |
|---|---|---|---|
| 1. Appearance sheet | End users | Mode, theme, text size, density, wallpaper | None (built in) |
| 2. Tokens | You | Colors, radii, spacing, fonts, shadows, motion, layout numbers | One `theme` prop |
| 3. CSS and props | You | Any style rule; header buttons, menus, gates, placeholders | CSS file or props |
| 4. Slots | You | Replace any component with your own (bubble, composer, header, dialogs, ...) | A `components` prop |
| 5. Headless | You | Everything: write all markup yourself | Hooks only |

Levels combine. A common setup: tokens for brand colors, one custom `MessageBubble` slot, everything else default.

## 2. Level 1: what end users can change

Users open the Appearance sheet from the "Wallpaper" item in the chat menu (when an `AppearanceProvider` is present) and, if you pass `onOpenAppearance` to the conversation list, from the button there.

| Setting | Options | Stored as |
|---|---|---|
| Mode | Auto (follows the OS), Light, Dark | `mode`: `"system"`, `"light"`, `"dark"` |
| Text size | Small, Medium, Large (fonts x0.9, x1, x1.2) | `textSize` |
| Density | Comfortable, Compact (spacing x1, x0.75) | `density` |
| Theme | 7 presets: indigo, rose, emerald, ocean, amber, violet, graphite | `preset` |
| Wallpaper | Default, 8 solid colors, 5 gradients, or the user's own photo (with a dim slider) | `wallpaper` |
| Wallpaper scope | All chats, or this chat only | `perChat` |

These are local to the browser (nothing is sent to the other person). They are saved in `localStorage` under `commskit.appearance.v1`.

### Controlling the settings from your own code

```tsx
import { useAppearance } from "@snakechat/commskit-web";

const Settings = () => {
  const a = useAppearance();
  return (
    <>
      <button onClick={() => a.setMode("dark")}>Dark</button>
      <button onClick={() => a.setTextSize("large")}>Bigger text</button>
      <button onClick={() => a.setDensity("compact")}>Compact</button>
      <button onClick={() => a.setPreset("emerald")}>Emerald</button>
      <button onClick={() => a.setWallpaper({ kind: "gradient", index: 2 })}>Gradient 3</button>
      <button onClick={() => a.setWallpaper({ kind: "solid", index: 0 }, { peerId: "U2" })}>Chat with U2 only</button>
    </>
  );
};
```

`useAppearance()` also returns the current values (`mode`, `scheme`, `preset`, `textSize`, `density`, `wallpaper`, `perChat`), `theme` (the resolved token object),
`hasOverride(peerId)`, `resetWallpaper(peerId)` and `storageFailed`. Without an `AppearanceProvider` it returns defaults and its setters do nothing.

### Storing the settings on your server (controlled mode)

Pass `value` and `onChange` and the host owns the state. No storage is used.

```tsx
<AppearanceProvider value={prefs} onChange={(next) => { setPrefs(next); saveToServer(next); }}>
```

`value` must be a full `AppearanceState`: `{ mode, preset, textSize, density, wallpaper, perChat }`.

Other provider props: `storage` (any `{ getItem, setItem, removeItem? }`; `null` turns persistence off), `storageKey`, `initial` (starting values; saved ones win),
`onStorageError` (a write failed, for example quota full; the choice still holds for the session).

### Hiding or replacing the Appearance sheet

* Hide the button: `<ConversationListScreen onOpenAppearance={false} />` and `<ChatScreen appearanceMenu={false} />`.
* Use your own handler: `onOpenAppearance={() => openMySettings()}`.
* Replace the whole sheet: the `AppearanceSheet` slot (see level 4).

## 3. Level 2: design tokens (colors, sizes, fonts)

`AppearanceProvider` renders a `<div class="ck-root">` that carries every token as a CSS variable. All kit screens must be inside it.
Pass overrides with the `theme` prop:

```tsx
<AppearanceProvider
  theme={{
    colors: { accent: "#0F766E", bubbleOut: "#0F766E" },        // both light and dark
    schemes: { dark: { accent: "#2DD4BF", background: "#0B1220" } }, // per scheme (wins over `colors`)
    radius: { bubble: 12 },
    space: { lg: 18 },
    font: { family: "Inter, system-ui, sans-serif", size: { body: 16 } },
    layout: { composerMaxLines: 4, bubbleMaxWidthPct: 80 },
  }}
>
```

Order of precedence for a color, lowest to highest: base tokens, the user's chosen preset, your `colors`, your `schemes.<scheme>`.
Text size and density are applied last, on top of everything (they scale `font.size` and `space`).
You cannot set `preset` through `theme` (the user picks it); set the default with `initial={{ preset: "rose" }}`.

### What each token group controls

| Token group | Names | CSS variable |
|---|---|---|
| `colors` | `accent`, `accentStrong`, `accentSoft`, `onAccent`, `background`, `surface`, `surfaceAlt`, `surfaceSunken`, `border`, `text`, `textMuted`, `textSubtle`, `wallpaper`, `bubbleIn`, `bubbleInText`, `bubbleOut`, `bubbleOutText`, `tickOut`, `tickReadOut`, `online`, `success`, `danger`, `warning`, `overlay` | `--ck-<kebab-name>`, for example `--ck-bubble-out` |
| `radius` | `sm` 6, `md` 10, `lg` 16, `xl` 22, `bubble` 18, `pill` 999 | `--ck-radius-<name>` |
| `space` | `xxs` 2, `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `xxl` 32 | `--ck-space-<name>` |
| `font.size` | `caption` 12, `small` 13, `body` 15, `title` 17, `heading` 22, `display` 28 | `--ck-font-<name>` |
| `font.weight` | `regular`, `medium`, `semibold`, `bold` | `--ck-weight-<name>` |
| `font.family`, `font.lineHeight` | CSS font stack, multiplier (1.4) | `--ck-font-family`, `--ck-line-height` |
| `shadow` | `sm`, `md`, `lg` | `--ck-shadow-<name>` |
| `motion.duration` | named durations in ms | `--ck-dur-<name>` |
| `layout` | `tapTarget` 44, `bubbleMaxWidthPct` 72, `composerMaxLines` 6 (and the list width and breakpoints) | `--ck-tap`, `--ck-bubble-max`, `--ck-composer-max-lines` |

The call colors (`callBackgroundStart`, `callControl`, ...) exist in the token set but the web package has no call UI, so they have no effect here.

### Changing tokens at runtime or from CSS

Because tokens are CSS variables you can also override them in a stylesheet, which wins over the `theme` prop if it is more specific:

```css
.ck-root { --ck-accent: #0f766e; --ck-radius-bubble: 6px; }
.ck-root[data-ck-scheme="dark"] { --ck-accent: #2dd4bf; }
```

The root has `data-ck-scheme="light" | "dark"` (the resolved scheme) and `data-ck-preset="<name>"`, handy for your own selectors.

## 4. Level 3: CSS and layout props

### Style any part with CSS

Load your stylesheet after `@snakechat/commskit-web/styles.css`. All classes are prefixed `ck-`. The ones you will use most:

| Area | Classes |
|---|---|
| Layout | `ck-app`, `ck-pane`, `ck-pane-list`, `ck-pane-chat`, `ck-list-screen`, `ck-chat` |
| Conversation list | `ck-rows`, `ck-row`, `ck-row-main`, `ck-row-name`, `ck-row-preview`, `ck-row-time`, `ck-badge`, `ck-search`, `ck-chips`, `ck-chip` |
| Chat header | `ck-chat-header`, `ck-header-name`, `ck-header-status`, `ck-header-actions`, `ck-icon-btn` |
| Messages | `ck-messages`, `ck-msg-row`, `ck-bubble`, `ck-meta`, `ck-ticks`, `ck-quote`, `ck-date-sep`, `ck-date-chip`, `ck-typing` |
| Composer | `ck-composer`, `ck-composer-row`, `ck-input`, `ck-send`, `ck-reply-bar` |
| Overlays | `ck-dialog`, `ck-menu`, `ck-menu-item`, `ck-toast`, `ck-banner`, `ck-backdrop` |
| Misc | `ck-avatar`, `ck-presence-dot`, `ck-wallpaper`, `ck-skeleton`, `ck-empty` |

State classes are added on the same element, for example `is-selected`, `is-unread`, `is-blocked` on `ck-row`. Check the exact class names in your browser's
inspector, or in `web/src/styles.css`. Selectors that depend on inner markup can change between versions; the token variables and the slots in level 4 are the stable surface.

Examples:

```css
.ck-bubble { box-shadow: var(--ck-shadow-sm); }
.ck-row.is-unread .ck-row-name { font-weight: var(--ck-weight-bold); }
.ck-composer .ck-send { border-radius: var(--ck-radius-pill); }
```

Use `className` (and `style` on `AppearanceProvider`) to add your own class to the root of `AppearanceProvider`, `ChatApp`, `ChatScreen`, `ConversationListScreen` and `Composer`.

### Layout

`ChatApp` is the ready-made responsive layout: one pane on a phone, list and chat side by side from 700 px. It fills its parent, so give the parent a height (for example `100dvh`).
Want a different layout? Skip `ChatApp` and place `ConversationListScreen` and `ChatScreen` yourself inside `CommsStack`.

### Props that change what is shown

| Component | Props |
|---|---|
| `ChatApp` | `chat` (props passed to every `ChatScreen`), `list` (props for the list), `notifications`, `banners`, `placeholder`, `className` |
| `ChatScreen` | `renderActions` (extra header buttons), `menuItems`, `messageActions`, `gate(info)` (render something over the chat, for example a consent screen), `disabledReason`, `placeholder`, `replies`, `swipeToReply`, `showConnectionBanner`, `clock`, `appearanceMenu`, `moderationMenu`, `className` |
| `ConversationListScreen` | `title`, `emptyTitle`, `emptyText`, `onOpenAppearance`, `blockedUsers`, `className` |
| `Composer` | `placeholder`, `maxLength`, `className` |

## 5. Level 4: replace components

Pass `components` to `AppearanceProvider`. Anywhere the kit would render the built-in, it renders yours instead.

```tsx
import { AppearanceProvider, DefaultAvatar, type CommsComponents } from "@snakechat/commskit-web";

const MyBubble: CommsComponents["MessageBubble"] = ({ message, groupStart }) => (
  <div className={groupStart ? "my-bubble my-bubble--first" : "my-bubble"}>{message.content}</div>
);

const SmallAvatar: CommsComponents["Avatar"] = (props) => <DefaultAvatar {...props} size={32} />;

<AppearanceProvider components={{ MessageBubble: MyBubble, Avatar: SmallAvatar }}>
  ...
</AppearanceProvider>
```

### Rules

* A replacement receives exactly the props of the built-in (`CommsComponents["Name"]` types them for you). The kit still owns the behavior: your component is called with the data and the handlers.
* A replacement can render the built-in. Every built-in is exported as `Default<Name>` (`DefaultAvatar`, `DefaultMessageBubble`, ...). Wrapping the default is the easiest way to add something small.
* Define your replacement components outside of other components (module scope), or memoize the `components` object. A new function identity every render remounts the component and loses its state.
* A slot can be nested: if you replace `ChatScreen`, you decide whether to use `DefaultChatScreen`, and which of its pieces (`ChatHeader`, `MessageList`, `Composer`) to render.

### All slots

| Group | Slots |
|---|---|
| App and screens | `ChatApp`, `ChatScreen`, `ChatHeader`, `ConversationListScreen`, `ConversationRow` |
| Messages | `MessageList`, `MessageBubble`, `Linkified` (the clickable-link text) |
| Input | `Composer` |
| Primitives | `Avatar`, `Icon`, `Dialog`, `ConfirmDialog`, `PopupMenu`, `ToastStack`, `LiveRegion`, `ConnectionBanner` |
| Sheets and viewers | `AppearanceSheet`, `ReportSheet`, `BlockedUsersScreen`, `AttachmentPreviewSheet`, `ImageLightbox`, `DocumentViewer` |
| Other | `ChatWallpaper`, `InAppMessageBanners` |

### What the main components receive

| Slot | Props (summary) |
|---|---|
| `MessageBubble` | `message`, `groupStart`, `groupEnd`, `peerId`, `peerName`, `myId`, `baseUrl`, `highlighted`, `clock`, `swipeToReply`, `index`, plus handlers `onMenu`, `onReply`, `onOpenImage`, `onOpenFile`, `onJumpToQuote`, `onRetry`, `onCallBack` |
| `Composer` | `onSend(text)`, `onAttach(files)`, `onTyping(bool)`, `replyTo`, `onCancelReply`, `disabledReason`, `blocked`, `rateLimitedUntil`, `placeholder`, `maxLength`, `focusKey`, `className` |
| `ConversationRow` | `conversation`, `typing`, `selected`, `tabbable`, `onSelect(peerId, conversation)`, `clock` |
| `ChatHeader` | `peerId`, `name`, `avatar`, `status`, `lastSeen`, `typing`, `isBlocked`, `blockedByOther`, `onBack`, `onCall`, `actions`, `menuItems`, `clock` |
| `Avatar` | `name`, `id`, `src`, `size`, `online`, `className` |

Your editor shows the full type when you write `CommsComponents["MessageBubble"]`.

## 6. Level 5: build your own UI on the hooks

The hooks hold all chat logic (connection, messages, typing, read receipts, uploads, blocking) and no markup. You can ignore every kit component and render your own.
You still need the providers: `CommsWebProvider` (connection) and `ChatProvider` (state). `CommsStack` sets up both.

| Hook | Gives you |
|---|---|
| `useConversations()` | `{ conversations, loaded, refresh }` |
| `useConversation(peerId, options?)` | `messages`, `loading`, `loadingMore`, `hasMore`, `typing`, `conversation`, `send(text, replyTo?)`, `sendMedia(file, replyTo?)`, `loadMore()`, `markRead()`, `setTyping(bool)`, `deleteMessage(id, {forEveryone})`, `clearChat()`, `retryMessage(id)`, `rateLimitedUntil` |
| `useChat()` | `activePeerId`, `setActiveChat(peerId)`, `refresh()`, the raw `store` |
| `useChatApi()` | `startChat(userId)`, push-token helpers |
| `useUserProfile(id)` | name and avatar from the user directory |
| `useConnectionStatus()` / `useIsConnected()` | socket state |
| `useUnreadCount()` | total unread (for a badge) |
| `useBlocking()` / `useOptionalBlocking()` | block, unblock, blocked list |
| `useChatErrors()` | server errors |
| `useAppearance()` / `useTheme()` | the settings and the resolved theme (level 1) |

Minimal custom chat:

```tsx
import { useConversation } from "@snakechat/commskit-web";

export const MyChat = ({ peerId }: { peerId: string }) => {
  const { messages, send, loading } = useConversation(peerId);
  const [text, setText] = useState("");
  if (loading) return <p>Loading...</p>;
  return (
    <div>
      <ul>{messages.map((m) => <li key={m.id}>{m.content}</li>)}</ul>
      <form onSubmit={(e) => { e.preventDefault(); if (send(text)) setText(""); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </form>
    </div>
  );
};
```

You can mix this with the kit: your own `MyChat` for the thread and the default `ConversationListScreen` for the list, or the reverse.
A few helpers are exported too: `splitLinks` (turn text into link and text parts), `resolveMediaUrl`, `downscaleImageFile`, `readUrlAsBase64` and `displayName`. Message grouping and date labels are not exported from the web package, so a custom UI does its own.

## 7. Recipes

### Brand colors only
```tsx
<AppearanceProvider theme={{ colors: { accent: "#7c3aed", bubbleOut: "#7c3aed" } }}>
```

### Square bubbles and tighter spacing as the default
```tsx
<AppearanceProvider theme={{ radius: { bubble: 4 } }} initial={{ density: "compact" }}>
```

### Different look in light and dark
```tsx
<AppearanceProvider theme={{ schemes: { light: { background: "#fff" }, dark: { background: "#000", surface: "#111" } } }}>
```

### Add a badge to every bubble, keep everything else
```tsx
import { DefaultMessageBubble, type CommsComponents } from "@snakechat/commskit-web";

const BadgedBubble: CommsComponents["MessageBubble"] = (props) => (
  <div style={{ position: "relative" }}>
    {props.message.content?.includes("urgent") ? <span className="urgent-flag">!</span> : null}
    <DefaultMessageBubble {...props} />
  </div>
);
```

### Your own empty state in the list
```tsx
<ConversationListScreen emptyTitle="No chats yet" emptyText="Start one from a profile." />
```

### Your own settings screen instead of the Appearance sheet
```tsx
<ConversationListScreen onOpenAppearance={() => navigate("/settings/appearance")} />
```
Build `/settings/appearance` with `useAppearance()` (level 1).

### Hide the wallpaper and theme choices (fixed brand look)
Replace the sheet with one that shows only what you allow:
```tsx
import { Dialog, useAppearance, type CommsComponents } from "@snakechat/commskit-web";

const LimitedSheet: CommsComponents["AppearanceSheet"] = ({ onClose }) => {
  const a = useAppearance();
  return (
    <Dialog label="Appearance" onClose={onClose}>
      <button onClick={() => a.setMode("dark")}>Dark</button>
      <button onClick={() => a.setMode("light")}>Light</button>
      <button onClick={() => a.setTextSize("large")}>Larger text</button>
    </Dialog>
  );
};
// <AppearanceProvider components={{ AppearanceSheet: LimitedSheet }}>
```

## 8. Rules and gotchas

* Everything must be inside `AppearanceProvider`. Outside it, components still work with default light styling, but the settings and `components` have no effect.
* Import `styles.css` once (`import "@snakechat/commskit-web/styles.css"`). Your overrides go after it.
* Slots are looked up by name from the nearest `AppearanceProvider`. Nested providers each have their own `components`.
* `textSize` and `density` scale the tokens (`font.size`, `space`). Hard-coded pixel values in your own CSS do not scale. Use the variables (`var(--ck-font-body)`, `var(--ck-space-md)`).
* Keep accessibility when you replace components: the built-ins set roles and labels (for example `role="listbox"` on the list, `aria-label` on buttons). A replacement is responsible for the same.
* Custom `Icon` slot: it receives `name` and `size`, and must render at that size.
* `Composer` replacement: call `onSend(text)` and clear your field only when it returns something other than `false`. Call `onTyping(true/false)` if you want typing indicators.
* The call buttons in the chat header only appear when you pass `onCall`. The web package has no calling.

## 9. Troubleshooting

| Problem | Likely cause |
|---|---|
| Token changes do nothing | The screen is outside `AppearanceProvider`, or your CSS loads before `styles.css`, or a more specific selector wins |
| `components` has no effect | Wrong slot name (check the table), or the component is rendered outside the provider |
| A slot remounts on every render | The replacement is defined inside a component. Move it to module scope |
| Settings reset on reload | `storage={null}`, controlled `value` without saving it, or a blocked/full `localStorage` (`storageFailed` is true) |
| Text size or density does nothing in my CSS | Your CSS uses fixed pixels. Use the `--ck-font-*` and `--ck-space-*` variables |
| TypeScript error on a replacement | The props must match the built-in. Type it as `CommsComponents["Name"]` |
