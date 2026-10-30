# @snakechat/commskit-mobile: customizing the UI

Everything about the look and structure of the chat and call screens can be changed. There are five levels, from "no code" to "write your own UI".
Use the lowest level that does the job.

Series: [01 Overview](01-overview.md) | [02 Keys, secrets, WebSockets, placeholders](02-keys-secrets-websockets-and-placeholders.md) | [03 Using, running, deploying](03-using-running-and-deploying.md) | **04 Customizing the UI (this file)** | [Mobile example app](../example/mobile-example.md) | [Design system](../design/design-overview.md)

Import lines below use the final package name `@snakechat/commskit-mobile` with its sub-paths (`/theme`, `/chat-ui`, `/call-ui`, `/chat`, `/call`).
Until it is published, use whatever name your app currently resolves (for example the `file:` link in `examples/expo-app`).

## Contents
1. [The five levels](#1-the-five-levels)
2. [Level 1: what end users can change](#2-level-1-what-end-users-can-change)
3. [Level 2: design tokens (colors, sizes, fonts, icons)](#3-level-2-design-tokens-colors-sizes-fonts-icons)
4. [Level 3: props and render hooks](#4-level-3-props-and-render-hooks)
5. [Level 4: replace components](#5-level-4-replace-components)
6. [Level 5: build your own UI on the hooks](#6-level-5-build-your-own-ui-on-the-hooks)
7. [Recipes](#7-recipes)
8. [Rules and gotchas](#8-rules-and-gotchas)
9. [Troubleshooting](#9-troubleshooting)

## 1. The five levels

| Level | Who | What you change | Code needed |
|---|---|---|---|
| 1. Appearance sheet | End users | Mode, theme, text size, density, wallpaper | None (built in) |
| 2. Tokens | You | Colors, radii, spacing, fonts, shadows, motion, layout numbers, icons | A `theme` prop |
| 3. Props and render hooks | You | Header buttons, menus, backgrounds, gradients, texts | Props |
| 4. Slots | You | Replace any component with your own (bubble, composer, header, call screen, buttons, ...) | A `components` prop |
| 5. Headless | You | Everything: write all views yourself | Hooks only |

Levels combine. A common setup: tokens for brand colors, a custom `MessageBubble` slot, everything else default.

There is no CSS on mobile. Styling is done through tokens (numbers and colors in a theme object), props, and replacing components.

## 2. Level 1: what end users can change

Users open the Appearance sheet from the chat's overflow menu ("Wallpaper") or from a button in the conversation list, when an `AppearanceProvider` is present.

| Setting | Options | Stored as |
|---|---|---|
| Mode | Auto (follows the OS), Light, Dark | `mode`: `"system"`, `"light"`, `"dark"` |
| Text size | Small, Medium, Large (fonts x0.9, x1, x1.2) | `textSize` |
| Density | Comfortable, Compact (spacing x1, x0.75) | `density` |
| Theme | 7 presets: indigo, rose, emerald, ocean, amber, violet, graphite | `preset` |
| Wallpaper | Default, 8 solid colors, 5 gradients, or the user's own photo (with a dim slider) | `wallpaper` |
| Wallpaper scope | All chats, or this chat only | `perChat` |

These are local to the device (nothing is sent to the other person). They are saved with `@react-native-async-storage/async-storage` when it is installed
(optional peer). Without it, choices last for the session only, unless you pass your own `storage`.

### Setting it up

```tsx
import { AppearanceProvider } from "@snakechat/commskit-mobile/theme";

<AppearanceProvider theme={{ colors: { accent: "#0F766E" } }}>
  {/* your app */}
</AppearanceProvider>
```

`AppearanceProvider` replaces your `ThemeProvider` (it renders one for you). If you need your own `ThemeProvider`, pass `wrapThemeProvider={false}` and read `useAppearance()` yourself.

### Controlling the settings from your own code

```tsx
import { useAppearance } from "@snakechat/commskit-mobile/theme";

const a = useAppearance();
a.setMode("dark");
a.setTextSize("large");
a.setDensity("compact");
a.setPreset("emerald");
a.setWallpaper({ kind: "gradient", index: 2 });                    // all chats
a.setWallpaper({ kind: "solid", index: 0 }, { peerId: "U2" });     // one chat
a.resetWallpaper("U2");
```

`useAppearance()` also returns the current values (`mode`, `preset`, `textSize`, `density`, `wallpaper`, `perChat`), `ready` (saved choices have been loaded),
`available` (false without a provider, where setters do nothing), `wallpaperFor(peerId)` and `hasOverride(peerId)`.

### Storing the settings on your server (controlled mode)

```tsx
<AppearanceProvider value={prefs} onChange={(next) => { setPrefs(next); saveToServer(next); }}>
```

`value` must be a full `AppearanceState`: `{ mode, preset, textSize, density, wallpaper, perChat }`.
Other props: `storage` (async key-value adapter; `null` turns persistence off), `storageKey`, `initial`, `onStorageError`.

### Wallpaper photos and gradients

* The "Choose image..." tile appears only when you give a picker: `pickWallpaperImage` on `ChatScreen` / `ConversationListScreen` (for example one built on `expo-image-picker`).
  Downscale to `maxEdge` (1600 px) and copy the file somewhere permanent before resolving. The kit stores only the uri.
* Gradients use `expo-linear-gradient` when it is installed. Otherwise pass `renderGradient` (or the tiles fall back to the first color).

### Showing or hiding the Appearance entry points

| Where | Prop |
|---|---|
| Chat overflow menu | `appearanceMenu` on `ChatScreen` (default: shown when an `AppearanceProvider` exists) |
| Conversation list button | `showAppearanceAction`, and `onOpenAppearance` for your own handler |
| The sheet itself | the `AppearanceSheet` slot (level 4) |

## 3. Level 2: design tokens (colors, sizes, fonts, icons)

Pass `theme` to `ThemeProvider` or `AppearanceProvider`:

```tsx
import { ThemeProvider } from "@snakechat/commskit-mobile/theme";

<ThemeProvider
  theme={{
    colors: { accent: "#0F766E", bubbleOut: "#0F766E" },        // both light and dark
    schemes: { dark: { accent: "#2DD4BF", background: "#0B1220" } }, // per scheme (wins over `colors`)
    radius: { bubble: 12 },
    space: { lg: 18 },
    font: { nativeFamily: "Inter", size: { body: 16 } },
    layout: { composerMaxLines: 4, bubbleMaxWidthPct: 80 },
  }}
/>
```

`theme` can also be a full `Theme` (`createTheme(overrides, "dark")`) or a function `(scheme, preset) => Theme`.
Order of precedence for a color, lowest to highest: base tokens, the user's preset, your `colors`, your `schemes.<scheme>`.
Text size and density are applied last, on top of the result (they scale `font.size` and `space`).
With `AppearanceProvider`, the preset is set by the user; give a starting one with `initial={{ preset: "rose" }}`.
With a plain `ThemeProvider` you can pass `preset="rose"` yourself.

### What each token group controls

| Token group | Names |
|---|---|
| `colors` | `accent`, `accentStrong`, `accentSoft`, `onAccent`, `background`, `surface`, `surfaceAlt`, `surfaceSunken`, `border`, `text`, `textMuted`, `textSubtle`, `wallpaper`, `bubbleIn`, `bubbleInText`, `bubbleOut`, `bubbleOutText`, `tickOut`, `tickReadOut`, `online`, `success`, `danger`, `warning`, `overlay`, and for calls `callBackgroundStart`, `callBackgroundEnd`, `callText`, `callTextMuted`, `callControl`, `callControlActive`, `callAccept`, `callHangup` |
| `radius` | `sm` 6, `md` 10, `lg` 16, `xl` 22, `bubble` 18, `pill` 999 |
| `space` | `xxs` 2, `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `xxl` 32 |
| `font.size` | `caption` 12, `small` 13, `body` 15, `title` 17, `heading` 22, `display` 28 |
| `font.weight`, `font.lineHeight` | `regular`, `medium`, `semibold`, `bold`; a multiplier (1.4) |
| `font.nativeFamily` | A font family name. Default `undefined` = the platform system font. Load the font in your app first |
| `shadow`, `motion`, `avatarPalette` | Shadow tokens, durations and easing, the avatar background colors |
| `layout` | `tapTarget` 44, `bubbleMaxWidthPct` 72, `composerMaxLines` 6, list width limits, tablet and desktop breakpoints |

Read the current theme in your own components with `useTheme()` (for example `theme.colors.accent`, `theme.space.md`).

### Icons

The kit draws simple built-in glyphs. Swap them for your icon set with `renderIcon`:

```tsx
<ThemeProvider
  renderIcon={(name, { size, color }) => <Ionicons name={ICONS[name]} size={size} color={color} />}
/>
```

Return `undefined` to keep the built-in glyph for a given name. Icon names:
* Navigation: `back`, `minimise`, `chevronDown`, `close`, `search`, `retry`
* Calls: `call`, `callEnd`, `callIncoming`, `callOutgoing`, `callMissed`, `mic`, `micOff`, `speaker`, `speakerOff`
* Chat: `attach`, `send`, `file`, `image`, `message`
* Menus and appearance: `more`, `check`, `palette`

## 4. Level 3: props and render hooks

| Component | Props that change what is shown |
|---|---|
| `ChatScreen` | `renderActions(ctx)` (extra header buttons), `menuItems`, `messageActions`, `fileActions`, `messageActionsSheet`, `disabledReason`, `placeholder`, `replies`, `swipeToReply`, `showConnectionBanner`, `insets`, `keyboardBehavior`, `keyboardVerticalOffset`, `clock`, `appearanceMenu`, `moderationMenu`, `pickAttachment`, `pickWallpaperImage`, `renderGradient`, `onPressTitle`, `onLongPressMessage`, `onOpenFile` |
| `ConversationListScreen` | `title`, `me` (your avatar and name in the header), `renderHeaderActions()`, `searchable`, `showFilters`, `filters`, `emptyTitle`, `emptyText`, `showAppearanceAction`, `onOpenAppearance`, `insets`, `clock` |
| `CallScreen` / `CallOverlay` | `renderBackground()` (your own call background), plus the handler props |
| `ChatWallpaper`, `AppearanceSheet`, `ConversationListScreen`, `ChatScreen` | `renderGradient(props)` |

`insets` lets you pass the safe-area values if you do not use `react-native-safe-area-context`.

## 5. Level 4: replace components

Pass `components` to `ThemeProvider` (or `AppearanceProvider`). Anywhere the kit would render the built-in, it renders yours instead.

```tsx
import { DefaultAvatar, ThemeProvider } from "@snakechat/commskit-mobile/theme";
import type { ChatUiSlots, MessageBubbleProps } from "@snakechat/commskit-mobile/chat-ui";
import type { CallUiSlots } from "@snakechat/commskit-mobile/call-ui";

const MyBubble = ({ message, groupStart }: MessageBubbleProps) => (
  <View style={{ marginTop: groupStart ? 12 : 2 }}>
    <Text>{message.content}</Text>
  </View>
);

const components = {
  MessageBubble: MyBubble,
  Avatar: (p) => <DefaultAvatar {...p} size={32} />,
} satisfies ChatUiSlots;

<ThemeProvider components={components}>{/* app */}</ThemeProvider>
```

`satisfies ChatUiSlots` (or `CallUiSlots`) checks the props of each replacement. To mix chat, call and theme slots in one object, type it as `ChatUiSlots & CallUiSlots`.

### Rules

* A replacement receives exactly the props of the built-in. The kit still owns the behavior: your component is called with the data and the handlers.
* A replacement can render the built-in. Every built-in is exported as `Default<Name>` (`DefaultAvatar`, `DefaultMessageBubble`, `DefaultCallButton`, ...). Wrapping the default is the easiest way to add something small.
* Define replacement components at module scope, and keep the `components` object stable (a module constant or `useMemo`). A new identity every render remounts the component and loses its state.
* If you replace a container such as `ChatScreen` or `CallScreen`, you decide whether to use the default and which of its pieces to render.
* `components` only reaches the screens that are inside the `ThemeProvider` / `AppearanceProvider` that received it. With `AppearanceProvider wrapThemeProvider={false}`, give `components` to your own `ThemeProvider` instead.

### All slots

| Package path | Slots |
|---|---|
| `/theme` | `Avatar`, `Icon`, `ScalePressable` |
| `/chat-ui` (`ChatUiSlots`) | Screens: `ChatScreen`, `ChatHeader`, `ConversationListScreen`, `ConversationList`, `ConversationRow`, `BlockedUsersScreen`. Messages: `MessageList`, `MessageBubble`, `CallEntry` (call log line), `TypingIndicator`, `ReplyBar`, `AudioMessageRow`. Input: `Composer`, `AttachMenu`. Sheets and viewers: `AppearanceSheet`, `AttachmentPreviewSheet`, `MessageActionsSheet`, `ReportSheet`, `ConfirmDialog`, `ImageViewer`, `VideoPlayerModal`, `DocumentViewerModal`. Feedback: `Toast`, `ConnectionBanner`, `InAppMessageBanner`, `SkeletonBox`. Other: `ChatWallpaper`, `SwipeToReply`, `SwipeUpToDismiss` |
| `/call-ui` (`CallUiSlots`) | `CallScreen`, `CallOverlay`, `CallControls`, `CallButton`, `CallBackground`, `PulseAvatar`, `ReturnToCallPill` |

### What the main components receive

| Slot | Props (summary) |
|---|---|
| `MessageBubble` | `message`, `groupStart`, `maxWidth`, `senderName`, `clock`, `highlighted`, `peerId`, `audioPlayback`, `swipeToReply`, plus handlers `onOpenImage`, `onOpenFile`, `onOpenVideo`, `onCallBack`, `onLongPress`, `onReply`, `onPressReply`, `onRetry` |
| `Composer` | `onSend(text)`, `onAttach()`, `onTypingChange(bool)`, `disabledReason`, `blockedState`, `replyTo`, `placeholder`, `maxLines`, `maxLength`, `insetBottom`, `initialText`, `attachDisabled` |
| `ConversationRow` | `conversation`, `typing`, `selected`, `onPress(peerId, conversation)`, `now`, `clock` |
| `Avatar` | `name`, `id`, `uri`, `size`, `online`, `ringColor`, `style` |
| `CallScreen` | `model`, `connectedAt`, `isMuted`, `isSpeakerOn`, `onAccept`, `onDecline`, `onHangup`, `onToggleMute`, `onToggleSpeaker`, `onClose`, `onCallAgain`, `onMessage`, `onMinimise`, `renderBackground` |
| `CallControls` | `controls`, `isMuted`, `isSpeakerOn`, `peerName`, `onMute`, `onSpeaker`, `onHangup`, `onDecline`, `onAccept`, `onClose`, `onCallAgain`, `onMessage` |
| `CallButton` | `icon`, `caption`, `accessibilityLabel`, `onPress`, `variant`, `active`, `toggle`, `bounce`, `disabled`, `size` |

Your editor shows the full type. `MessageBubbleProps`, `ComposerProps`, `ConversationRowProps` and the call props are exported from their entry points.

## 6. Level 5: build your own UI on the hooks

The hooks hold all chat and call logic (connection, messages, typing, receipts, uploads, call state, WebRTC) and no views. You can ignore every kit component and render your own.
You still need the providers (`CommsProvider`, `ChatProvider`, and `CallProvider` for calls), set up as in [03 Using, running and deploying](03-using-running-and-deploying.md).

### Chat hooks (`@snakechat/commskit-mobile/chat`)

| Hook | Gives you |
|---|---|
| `useConversations()` | `{ conversations, loaded, refresh }` |
| `useConversation(peerId, options?)` | `messages`, `loading`, `loadingMore`, `hasMore`, `typing`, `conversation`, `send(text, replyTo?)`, `sendMedia(file, replyTo?)`, `loadMore()`, `markRead()`, `setTyping(bool)`, `deleteMessage(id, {forEveryone})`, `clearChat()`, `retryMessage(id)`, `rateLimitedUntil` |
| `useChat()` | `setActiveChat(peerId)`, `refresh()`, the raw store |

```tsx
import { useConversation } from "@snakechat/commskit-mobile/chat";

export const MyChat = ({ peerId }: { peerId: string }) => {
  const { messages, send } = useConversation(peerId);
  const [text, setText] = useState("");
  return (
    <View>
      <FlatList data={messages} renderItem={({ item }) => <Text>{item.content}</Text>} />
      <TextInput value={text} onChangeText={setText} onSubmitEditing={() => send(text) && setText("")} />
    </View>
  );
};
```

### Call hook (`@snakechat/commskit-mobile/call`)

`useCall()` returns `state` (the call status and peer), `startCall(peerId)`, `accept()`, `reject()`, `end()`, `toggleMute()`, `toggleSpeaker()`, `isMuted`, `isSpeakerOn`,
`localStream`, `remoteStream`, `lastEnded`, `callAgain()` and `openChat()`. Render your own call screen from `state`, or feed it to the kit's `mapLiveCall` and `CallScreen`.

You can mix both styles: the kit's `ConversationListScreen` with your own chat view, or your own list with the kit's `ChatScreen`.
Pure helpers (`createTheme`, `decideLayout`, color functions, avatar colors and initials) are exported from `/theme` and `/engine`, so a custom UI themes the same way.

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

### Your icon set
```tsx
<ThemeProvider renderIcon={(name, { size, color }) => (ICONS[name] ? <Ionicons name={ICONS[name]} size={size} color={color} /> : undefined)} />
```

### Add something to every bubble, keep everything else
```tsx
import { DefaultMessageBubble } from "@snakechat/commskit-mobile/chat-ui";

const FlaggedBubble = (props: MessageBubbleProps) => (
  <View>
    {props.message.content?.includes("urgent") ? <Text>!</Text> : null}
    <DefaultMessageBubble {...props} />
  </View>
);
// components={{ MessageBubble: FlaggedBubble }}
```

### A custom call screen background
```tsx
<CallScreen model={model} renderBackground={() => <MyVideoLoop />} /* ...handlers */ />
```

### Your own call button style
```tsx
import { DefaultCallButton, type CallButtonProps } from "@snakechat/commskit-mobile/call-ui";

const PillButton = (p: CallButtonProps) => <DefaultCallButton {...p} size={64} />;
// components={{ CallButton: PillButton } satisfies CallUiSlots}
```

### Your own settings screen instead of the Appearance sheet
Pass `onOpenAppearance={() => navigation.navigate("Appearance")}` to the list, set `appearanceMenu={false}` on the chat, and build the screen with `useAppearance()` (level 1).

## 8. Rules and gotchas

* Wrap the app in `AppearanceProvider` (or `ThemeProvider`). Without a provider the kit uses the light default theme, and the settings and `components` have no effect.
* Do not hard-code font sizes and spacing in your own components if you want text size and density to apply. Read them from `useTheme()` (`theme.font.size.body`, `theme.space.md`).
* The layout adapts: `useResponsiveLayout()` chooses one pane or split panes from the window width and the `layout` tokens.
* Keep accessibility when you replace components: the built-ins set roles, labels and live announcements (`announce`). A replacement is responsible for the same.
* Reduce motion: the kit respects the OS setting through `useReducedMotion()`. Use it in your own animations.
* A `Composer` replacement: call `onSend(text)` and clear your field only when it returns something other than `false`. Call `onTypingChange(true/false)` for typing indicators.
* Optional peers (gesture handler, haptics, expo-linear-gradient, image picker and others) enable extra features. Without them the matching feature is hidden or falls back. See the peer table in the package README.
* The mobile package ships TypeScript source. Your Metro/TypeScript setup compiles it. See [03](03-using-running-and-deploying.md) for the Metro config.

## 9. Troubleshooting

| Problem | Likely cause |
|---|---|
| Token changes do nothing | The screen is outside the provider, or you pass a ready `Theme` object that ignores your overrides |
| `components` has no effect | Wrong slot name (check the table), or the screen is outside the provider that got `components`, or `wrapThemeProvider={false}` |
| A slot remounts on every render | The replacement or the `components` object is created inside a component. Move it to module scope |
| Settings reset on restart | `@react-native-async-storage/async-storage` is not installed (memory only), `storage={null}`, or controlled `value` without saving it |
| "Choose image..." tile is missing | No `pickWallpaperImage` was passed |
| Gradient tiles are flat | `expo-linear-gradient` is not installed and no `renderGradient` was passed |
| Text size or density has no effect on my views | They use fixed numbers. Read sizes from `useTheme()` |
| TypeScript error on a replacement | The props must match the built-in. Use `satisfies ChatUiSlots` / `CallUiSlots` to see which |
