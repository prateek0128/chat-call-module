# @snakechat/commskit-mobile

Headless 1:1 **chat** and **voice calls** for React Native / Expo, speaking the wire protocol in
[`../docs/archive/PROTOCOL.md`](https://github.com/prateek0128/chat-call-module/blob/main/docs/archive/PROTOCOL.md). It is the mobile half of `commskit`
(plan: [`../docs/archive/IMPLEMENTATION_PLAN.md`](https://github.com/prateek0128/chat-call-module/blob/main/docs/archive/IMPLEMENTATION_PLAN.md), phases 6–8).

## Install

```bash
npm install @snakechat/commskit-mobile
```

The optional peer dependencies for the features you use are listed below. Calls need an Expo development build, not Expo Go.

| Entry | What | Needs |
|---|---|---|
| `@snakechat/commskit-mobile/core` (also `@snakechat/commskit-mobile`) | one WebSocket (`CommsClient`), `CommsProvider`, config, shared user directory, wire types | `react`, `react-native` |
| `@snakechat/commskit-mobile/chat` | `ChatStore`, `ChatProvider`, chat hooks, REST helpers | + `expo-file-system` (optional, for the default media reader) |
| `@snakechat/commskit-mobile/call` | `VoiceCallEngine`, `CallProvider`, `useCall`, audio / notification adapters, ICE servers | + `@stream-io/react-native-webrtc`, `react-native-incall-manager` (optional peers) |
| `@snakechat/commskit-mobile/theme` | design tokens, `createTheme`, `ThemeProvider`, `useTheme`, `useReducedMotion`, shared primitives (`Avatar`, `Icon`, `ScalePressable`, `useSafeInsets`) | `react`, `react-native` (+ `react-native-safe-area-context`, optional) |
| `@snakechat/commskit-mobile/chat-ui` | chat screens and components (see [UI kit](#ui-kit)) | `theme` + `chat` |
| `@snakechat/commskit-mobile/call-ui` | call screens, `CallOverlay` | `theme` + `call` |
| `@snakechat/commskit-mobile/notifications` | `registerDevice` / `unregisterDevice` (`POST`/`DELETE /devices`), Android channels, `useNotificationRouting`, `parseNotificationData` (see [Push notifications](#push-notifications)) | `core` + `expo-notifications`, `expo-device` (optional peers) |
| `@snakechat/commskit-mobile/call-native` | CallKit + PushKit (iOS), notifee full-screen calls + background task (Android), `createPlatformCallNotifier` (see [Incoming calls when the app is closed](#incoming-calls-when-the-app-is-closed-ios-callkit--voip-android-full-screen)) | `core` + `call` (never `chat`) + `react-native-callkeep`, `react-native-voip-push-notification`, `@notifee/react-native`, `expo-task-manager` (optional peers) |
| `@snakechat/commskit-mobile/moderation` | `ModerationStore`, `ModerationProvider`, `useBlocking` (see [Report & block](#report--block)) | `core` |
| `@snakechat/commskit-mobile/app.plugin.js` | Expo config plugin: `"plugins": ["@snakechat/commskit-mobile"]` | `@expo/config-plugins` (present in every Expo app) |

Rules (enforced by `__tests__/boundaries.test.ts`): `chat` and `call` import only `core`, never each
other. Only `src/call` touches WebRTC / InCallManager, and only `src/chat/media.ts` touches
expo-file-system. Every one of those is lazily `require`d inside try/catch, never statically imported.
The headless entries ship no UI. The optional UI kit (`theme`, `chat-ui`, `call-ui`, phase 9) sits on
top of them, with these rules:
- `chat-ui` never imports `call` / `call-ui`.
- `call-ui` never imports `chat` / `chat-ui`.
- `theme` imports neither.
- The engine folders import no UI.

See [UI kit](#ui-kit).

---

## Install

The package ships TypeScript source. Metro and Babel compile it like your own code, and the
`exports` map gives Metro (RN 0.79+ / Expo 53+, package exports on by default) the three entry points.

```jsonc
// app package.json
"dependencies": {
  "@snakechat/commskit-mobile": "^0.1.0",
  // call only:
  "@stream-io/react-native-webrtc": "^137.0.0",
  "react-native-incall-manager": "^4.2.0",
  // chat media with the default reader (Expo):
  "expo-file-system": "~19.0.21"
}
```

With a `file:` / symlinked install, add the kit folder to Metro's `watchFolders` if your Metro
version doesn't follow symlinks. Metro resolves every `require()` when it bundles. If you **don't**
install one of the optional peers that an entry you import uses, enable
`transformer.allowOptionalDependencies` in `metro.config.js`. That way the guarded `require` inside
try/catch is allowed to fail at runtime. For chat without Expo, you can instead pass your own
`readFileAsBase64` (see below).

## Configuration

```ts
import type { CommsConfig } from "@snakechat/commskit-mobile/core";

const config: CommsConfig = {
  baseUrl: "https://api.example.com",          // REST; wsUrl derived as wss://api.example.com
  // wsUrl: "wss://ws.example.com",             // optional override
  getToken: () => SecureStore.getItemAsync("token"),   // called on EVERY (re)connect and REST call
  getUserId: () => SecureStore.getItemAsync("userId"),
  // logger: consoleLogger("[comms]"),
};
```

Socket: `${wsUrl}/ws/${token}`. The client reconnects with backoff `min(1000·2ⁿ, 30000)` while the
app is in the foreground. It reconnects at once when the app becomes active, and sends
`user_status` `online` / `away` on AppState changes. If `getToken()` returns nothing, the status is
`unauthenticated` and nothing reconnects. After login, call `useComms().client.connect()` (or
`reconnect()` after a token change). Use `client.disconnect()` on logout.

---

## Usage

### 1. Chat only

```tsx
import { CommsProvider } from "@snakechat/commskit-mobile/core";
import { ChatProvider, useConversations, useConversation, useUnreadCount, useChatApi } from "@snakechat/commskit-mobile/chat";

export default function App() {
  return (
    <CommsProvider config={config}>
      <ChatProvider onError={(e) => Alert.alert("Chat", e.message)}>
        <Navigation />
      </ChatProvider>
    </CommsProvider>
  );
}

function Inbox() {
  const { conversations, loaded, refresh } = useConversations();   // newest first, live
  const unread = useUnreadCount();
  // conversations[i]: {user_id, username, avatar, status, last_seen, unread_count, last_message, chat_id, ...}
}

function ChatScreen({ peerId, chatId }: { peerId: string; chatId?: number }) {
  const {
    messages,            // newest first (inverted FlatList); temp_* = sending, call_* = live call entry
    loading, loadingMore, hasMore, typing,
    send, sendMedia, loadMore, markRead, setTyping,
  } = useConversation(peerId, { chatId });   // fetches page 1 (limit 10), marks read, sets active chat

  // send("hello", replyToMessage?)                       -> boolean (false = not connected / blocked)
  // await sendMedia({uri, name, type, size}, replyTo?)   -> boolean (10 MB guard)
}

// Start a conversation from a profile:
const { startChat } = useChatApi();
const { chat_id } = await startChat(candidateId);
```

`useChat()` returns `{store, activePeerId, setActiveChat(peerId|null), refresh(), isTyping(peerId)}`.
`useConversation` marks its peer as the **active chat** while mounted, so incoming messages there
don't increment unread. If your screen stays mounted while hidden, pass `{active: false}` and call
`setActiveChat` from your focus handler. Also use `activePeerId` to suppress in-app banners.

### 2. Call only

```tsx
import { CommsProvider } from "@snakechat/commskit-mobile/core";
import { CallProvider, useCall, turnCredentialsIceServers } from "@snakechat/commskit-mobile/call";

const iceServers = turnCredentialsIceServers(config);   // POST /call/turn-credentials, cached until ttl

export default function App() {
  return (
    <CommsProvider config={config}>
      <CallProvider
        iceServers={iceServers}
        onCallError={(err, retry) => {
          if (err.kind === "policy") showCreditPrompt(err.raw?.info, () => retry());   // retry({credit_acknowledged:true})
          else Alert.alert("Call", err.message);                                         // busy, no mic, ...
        }}
        onCallEnded={(summary) => console.log(summary)}   // {callId, endReason, outgoing, peerId, durationSeconds, ...}
      >
        <Navigation />
        <CallOverlay />
      </CallProvider>
    </CommsProvider>
  );
}

function CallOverlay() {
  const { state, accept, reject, end, toggleMute, toggleSpeaker, isMuted, isSpeakerOn, remoteStream, lastEnded } = useCall();
  if (state.isIncoming) return <Incoming name={state.peerName} onAccept={accept} onDecline={reject} />;
  if (state.isActive) return <InCall state={state} onEnd={end} muted={isMuted} onMute={toggleMute} speaker={isSpeakerOn} onSpeaker={toggleSpeaker} />;
  return null;
}

// Place a call:
const { startCall } = useCall();
await startCall(peerId, { peerName: "Asha", chatId: null, extra: { /* host fields for call_initiate */ } });
```

`state`: `{status: "idle"|"ringing"|"connected", direction, isIncoming, isOutgoing, isActive, callId,
peerId, peerName, peerAvatar, chatId, callType, connectedAt}`. `peerId` is always the **other**
person, because legacy quirks are normalised in `call/compat.ts`. Name and avatar come from the
shared user directory.

Also in `useCall()`: `lastEnded` / `clearLastEnded()` / `callAgain()` for an "ended" screen,
`openChat(peerId?)`, `handleNotificationAction(action, callId)`, and `engine` (raw `VoiceCallEngine`).

### 3. Chat + call

```tsx
<CommsProvider config={config}>                {/* ONE socket for both */}
  <ChatProvider onError={showChatError}>
    <CallProvider
      iceServers={iceServers}
      onCallError={handleCallError}
      onOpenChat={(peerId) => navigation.navigate("Chat", { peerId })}   // "Message" on call screens
    >
      <App />
    </CallProvider>
  </ChatProvider>
</CommsProvider>
```

The two features never import each other. The wiring goes through the socket's event types:
- `ChatStore` already turns `call_initiated` / `incoming_call` / `call_*` into `call_<id>` entries in
  an open conversation. The server's `call_log` rewrites them to the stored message (`Voice call · 05:42`).
- When a call ends, `CallProvider` dispatches a **local** `call_log` (`client.dispatchLocal`, flag
  `local: true`), so the chat shows the outcome right away. The server's `call_log` always wins over
  the local one. Turn this off with `emitLocalCallLog={false}`.
- Both providers feed the shared `UserDirectory`, so the call screen knows names from the chat list.
- Render call entries with `parseCallEntry(content)` / `friendlyDuration(seconds)` (exported by
  core and chat). A tap on a call entry calls `useCall().startCall(peerId)` from your screen.

---

## UI kit

Optional, themeable React Native screens on top of the hooks above. There are three entry points:

| Entry | Imports | Main exports |
|---|---|---|
| `@snakechat/commskit-mobile/theme` | react, react-native | `tokens`, `createTheme`, `ThemeProvider`, `useTheme`, `AppearanceProvider`, `useAppearance`, `resolveWallpaper`, `useReducedMotion`, `useResponsiveLayout`, `decideLayout`, `Avatar`, `Icon`, `ScalePressable`, `useSafeInsets`, `announce` |
| `@snakechat/commskit-mobile/chat-ui` | theme, core, chat | `ConversationListScreen`, `ChatScreen`, `ConversationList`, `ConversationRow`, `ChatHeader`, `MessageList`, `MessageBubble`, `CallEntry`, `TypingIndicator`, `Composer`, `AttachmentPreviewSheet`, `ConnectionBanner`, `ImageViewer`, `ChatWallpaper`, `AppearanceSheet`, `MessageActionsSheet`, `ReplyBar`, `InAppMessageBanner`, `useInAppBanner`, `VideoPlayerModal`, `createDefaultFileActions`, plus pure helpers (`buildMessageRows`, `conversationPreview`, `parseTimestamp`, ...) |
| `@snakechat/commskit-mobile/call-ui` | theme, core, call | `CallOverlay`, `CallScreen`, `CallControls`, `CallButton`, `PulseAvatar`, `ReturnToCallPill`, `CallBackground`, `mapLiveCall` / `mapEndedCall` |

The look follows [`../design/DESIGN_SYSTEM.md`](https://github.com/prateek0128/chat-call-module/blob/main/design/DESIGN_SYSTEM.md). Every colour, size,
radius, spacing and duration comes from [`../design/tokens.json`](https://github.com/prateek0128/chat-call-module/blob/main/design/tokens.json) through the
theme. `src/theme/tokens.ts` mirrors that file, and a test keeps them equal.

### Install

Nothing beyond the headless install is required. Optional extras:

| Package | Used for | Without it |
|---|---|---|
| `react-native-safe-area-context` (optional peer, lazily required) | safe-area insets from its `<SafeAreaProvider>` | insets are zero unless you pass `insets` to a screen |
| `expo-image-picker` / `expo-document-picker` (your app) | `ChatScreen pickAttachment` | no attach button |
| `expo-linear-gradient` (your app) | `renderBackground` on `CallOverlay` / `CallScreen` | a banded gradient made of plain Views |
| `expo-linear-gradient` (optional peer, lazily required by `ChatWallpaper`) | gradient chat wallpapers | the gradient's first colour as a solid (or pass `renderGradient`) |
| `@react-native-async-storage/async-storage` (optional peer, lazily required) | saving appearance choices (`AppearanceProvider`) | choices last for the session only (or pass your own `storage`) |
| `expo-image-picker` (+ `expo-image-manipulator`, `expo-file-system`) (your app) | `pickWallpaperImage` ("Choose image…" wallpaper) | no "Choose image…" tile |
| an icon set, e.g. `@expo/vector-icons` (your app) | `<ThemeProvider renderIcon>` | built-in text glyphs |
| `react-native-gesture-handler`, `expo-haptics`, `expo-clipboard`, `expo-video`, `expo-audio` / `expo-av`, `expo-file-system`, `expo-sharing`, `expo-media-library` (optional peers, lazily required by `src/chat-ui/optionalPeers.ts`) | swipe-to-reply, haptics, copy, video player, audio playback, download / share / save to gallery | see [Chat screen features](#chat-screen-features-reply-message-actions-media-files-in-app-banner) for each fallback |

As with the other optional peers, enable `transformer.allowOptionalDependencies` in
`metro.config.js` when `react-native-safe-area-context` is not installed.

### ThemeProvider

```tsx
import { ThemeProvider } from "@snakechat/commskit-mobile/theme";

<ThemeProvider colorScheme="system" /* "light" | "dark" | "system" (default, uses useColorScheme) */>
  <App />
</ThemeProvider>
```

- Without a provider, components use the light theme.
- `useTheme()` returns the resolved theme (`colors`, `space`, `radius`, `font`, `motion`, `layout`, ...).
- `useReducedMotion()` follows the OS setting (`AccessibilityInfo`). When it is on, every animation
  becomes instant and every loop stops.

### Chat only

```tsx
import { CommsProvider } from "@snakechat/commskit-mobile/core";
import { ChatProvider } from "@snakechat/commskit-mobile/chat";
import { ThemeProvider } from "@snakechat/commskit-mobile/theme";
import { ChatScreen, ConversationListScreen } from "@snakechat/commskit-mobile/chat-ui";
import * as ImagePicker from "expo-image-picker";

const pickAttachment = async () => {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
  const a = r.canceled ? null : r.assets[0];
  return a ? { uri: a.uri, name: a.fileName ?? "photo.jpg", type: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 } : null;
};

function InboxScreen({ navigation }) {
  return <ConversationListScreen onOpenConversation={(peerId) => navigation.navigate("Chat", { peerId })} />;
}

function ChatRoute({ route, navigation }) {
  return (
    <ChatScreen
      peerId={route.params.peerId}
      chatId={route.params.chatId}
      onBack={navigation.goBack}
      pickAttachment={pickAttachment}
    />
  );
}
```

The screens render their own header. Set `headerShown: false` for these routes. If you keep a
navigator header above `ChatScreen`, pass `keyboardVerticalOffset`.

`ChatScreen` props:
- `peerId`, `chatId?`
- `onBack?` (shows the back button)
- `onCall?(peerId)`, `renderActions?({peerId, name})`, `onPressTitle?`
- `pickAttachment?() => Promise<{uri, name, type, size} | null>`
- `onOpenFile?(message)` (default `Linking.openURL`), `onLongPressMessage?`
- `peerName?`, `disabledReason?` (e.g. "Chat is not enabled")
- `insets?`, `keyboardVerticalOffset?`, `keyboardBehavior?` (default: iOS `padding`; Android none,
  relying on `adjustResize`)
- `active?`, `showConnectionBanner?`, `maxUploadBytes?`, `clock?` (`"12h"` | `"24h"`)

`ConversationListScreen` props: `onOpenConversation(peerId, conversation)`, `selectedPeerId?`,
`title?`, `me?` (your own avatar), `renderHeaderActions?`, `insets?`, `searchable?`, `emptyTitle?`,
`emptyText?`, `clock?`.

**Split pane on tablets.** `useResponsiveLayout()` (or `decideLayout(width)`) returns
`{mode: "single" | "split", listWidth, ...}` based on the theme breakpoints. In split mode:
- render both screens side by side,
- pass `selectedPeerId` to the list,
- leave out `onBack` on `ChatScreen`.

### Chat screen features: reply, message actions, media, files, in-app banner

Each feature is on by default and works with no extra packages. An optional peer makes it
better when installed. All of these peers are lazily required from one file,
`src/chat-ui/optionalPeers.ts`. If some are not installed, enable
`transformer.allowOptionalDependencies` in `metro.config.js`, as for the other optional peers.

| Optional peer | Adds | Without it |
|---|---|---|
| `react-native-gesture-handler` (wrap the app in `<GestureHandlerRootView>`) | swipe right on a bubble to reply; swipe the in-app banner up to dismiss it | Reply from the long-press menu or the screen-reader "Reply" action; the banner has a ✕ button and auto-hides |
| `expo-haptics` | haptic tick when a swipe reaches the reply threshold | no haptic |
| `expo-clipboard` | "Copy text" in the message menu | item hidden |
| `expo-video` | full-screen in-app video player | `onOpenFile` / `Linking.openURL(file_url)` |
| `expo-audio` (or `expo-av`) | inline play / pause row for audio messages | file card (opens the URL) |
| `expo-file-system` | download to the cache with progress (download, share, save) | `Linking.openURL(file_url)` |
| `expo-sharing` | "Share" opens the share sheet with the downloaded file | `Linking.openURL(file_url)` |
| `expo-media-library` | "Save to gallery" for images and videos (asks for permission) | "Download" instead |

**Reply.** There are three ways to start a reply:
- swipe a bubble right (needs gesture handler),
- long-press → Reply,
- the screen-reader "Reply" action.

A reply bar above the composer shows the quoted sender and a snippet, with a ✕ to cancel. Sending
text or an attachment passes `replyTo` to `useConversation().send` / `sendMedia` and clears the
bar. Tapping a quote inside a bubble scrolls to the original and briefly highlights it. If the
original is not loaded, `MessageList onQuoteNotLoaded` is called (default: announces "Original
message isn't loaded").

**Long-press menu (`MessageActionsSheet`).** The items are, in order:
- Reply
- Copy text
- Save to gallery (images and videos), otherwise Download
- Share
- Report message: incoming messages only, when a `<ModerationProvider>` is mounted. It opens
  `ReportSheet` with `messageId`.
- your own `messageActions`

Items that can't work are hidden (`messageActionList` decides). If you pass `onLongPressMessage`,
it replaces the built-in sheet, as before.

```tsx
<ChatScreen
  peerId={peerId}
  messageActions={(m) => [{ key: "pin", label: "Pin", onPress: (msg) => pin(msg.id) }]}
  onFileActionEvent={(e) => e.status === "error" && showMyToast(e.text)} // optional
  showToasts /* built-in toast for copy / progress / errors (default true) */
/>
```

**Video and audio.** A video bubble shows `thumbnail_url` as its poster. Without one, it shows a
neutral tile with a play icon and the duration (`formatMediaDuration`). Tapping it plays the video
full screen with expo-video (`VideoPlayerModal`), or calls `onOpenVideo` if you pass it. With
expo-audio or expo-av installed, audio messages get a play / pause row.

**Files (`fileActions`).** Download, share and save to gallery go through a `FileActions` adapter.
The default is `createDefaultFileActions({ openURL: Linking.openURL })`:
- **download:** expo-file-system `createDownloadResumable` into `cacheDirectory`, reporting progress.
- **share:** downloads the file, then calls `expo-sharing.shareAsync`. The default download goes to
  the app cache, so users get a visible copy through "Save to Files" in the share sheet.
- **save to gallery:** `expo-media-library.requestPermissionsAsync`, then the download, then
  `saveToLibraryAsync`. If the user denies permission, it returns
  `{ ok: false, reason: "permission_denied" }` and shows "Allow photo access in Settings to save".
- **any missing peer:** falls back to `openURL(file_url)`.

To use react-native-blob-util, a native downloader or similar, pass your own adapter:
`fileActions={{ download, share, saveToGallery, capabilities }}`. Progress and results arrive as
`FileActionEvent`s through `onFileActionEvent` and in the built-in toast.

**In-app message banner.** Mount it once near the root, inside `ChatProvider` and `ThemeProvider`.
Place it after your navigator so it overlays every screen:

```tsx
<CommsProvider config={config}>
  <ChatProvider>
    <ThemeProvider>
      <NavigationContainer ref={navRef}>{/* ... */}</NavigationContainer>
      <InAppMessageBanner onOpenChat={(peerId, chatId) => navRef.navigate("Chat", { peerId, chatId })} />
    </ThemeProvider>
  </ChatProvider>
</CommsProvider>
```

The banner shows the avatar, name and text of each new incoming message from a chat other than
the open one. The open `ChatScreen` sets the store's active chat; you can also pass `activePeerId`.
- Tap opens the chat. Swipe up, ✕, or 4 s (`autoHideMs`) hides it.
- Each message shows at most once.
- It ignores my own messages, call entries, history, and catch-up messages older than 2 minutes.
- It doesn't show while the app is in the background.
- With reduced motion, it appears instantly instead of sliding in.

For a custom UI, use `useInAppBanner({ activePeerId?, enabled?, autoHideMs? })`. It returns
`{ banner, dismiss }`.

**New props** (all optional):

| Component | New props |
|---|---|
| `ChatScreen` | `replies` (default true), `swipeToReply` (default true), `messageActionsSheet` (default true), `messageActions`, `fileActions`, `onFileActionEvent`, `showToasts` (default true), `onOpenVideo` |
| `MessageList` | `onReplyMessage`, `swipeToReply`, `onOpenVideo`, `onQuoteNotLoaded`, `highlightMs` |
| `MessageBubble` | `onReply`, `swipeToReply`, `onPressReply`, `highlighted`, `onOpenVideo`, `peerId`, `audioPlayback` |
| `Composer` | `replyTo`, `onCancelReply` |

**New exports:**
- Components and hooks: `ReplyBar`, `MessageActionsSheet`, `InAppMessageBanner`,
  `useInAppBanner`, `VideoPlayerModal`, `AudioMessageRow`, `Toast`, `SwipeToReply`,
  `SwipeUpToDismiss`, `createDefaultFileActions`.
- Pure helpers: `replySnippet`, `replySenderLabel`, `messageActionList`, `formatMediaDuration`,
  `bannerSuppression`, `scanForBanners`, `SeenSet`.

### Call only

```tsx
import { CallProvider } from "@snakechat/commskit-mobile/call";
import { CallOverlay } from "@snakechat/commskit-mobile/call-ui";

<CommsProvider config={config}>
  <ThemeProvider>
    <CallProvider iceServers={iceServers} onCallError={handlePolicyErrors}>
      <View style={{ flex: 1 }}>
        <Navigation />
        <CallOverlay
          onVisibleChange={(v) => setStatusBarStyle(v ? "light" : "auto")}   // StatusBar is left to the host
        />
      </View>
    </CallProvider>
  </ThemeProvider>
</CommsProvider>

// anywhere: place a call
const { startCall } = useCall();
startCall(peerId, { peerName: "Asha" });
```

`CallOverlay` reads `useCall()` and shows `CallScreen` as a full-screen Modal. It covers these states:
- **Outgoing:** "Calling…", then "Ringing…" once `call_ringing` arrives.
- **Incoming:** Decline / Accept.
- **Connecting.**
- **Active:** timer, Mute, Speaker, Hang up.
- **Ended:** "Call ended · MM:SS", closes after 1.6 s.
- **Failed:** "No answer", "Declined", "On another call", "Microphone access is blocked" or
  "Couldn't connect", with Close and Call again.

Policy errors (credits) produce no failure screen. Keep handling them in `onCallError`.

Props:
- `onOpenChat?(peerId)`, `showMessageAction?`
- `speakerAvailable?`: default true. Pass false if `react-native-incall-manager` isn't installed.
- `allowMinimise?`, `pillPlacement?` (`"top"` | `"bottom"` | `"none"`), `pillOffset?`
- `renderBackground?`, `insets?`
- `onVisibleChange?`, `onMinimisedChange?`

Android back, or the minimise button, minimises an outgoing, connecting or active call to a
"Return to call" pill. An incoming call must be declined or accepted.

**Gradient.** By default, `CallBackground` stacks bands of interpolated colour. For a smooth gradient:
`renderBackground={() => <LinearGradient colors={[theme.colors.callBackgroundStart, theme.colors.callBackgroundEnd]} style={StyleSheet.absoluteFill} />}`.

### Chat + call (combined, React Navigation)

The UI entries never import each other. Three seams connect them:
- `ChatScreen onCall` adds the header call button and "Call back" on call entries.
- `ChatScreen renderActions` adds any other header action.
- `CallProvider onOpenChat` (or `CallOverlay onOpenChat`) drives "Message" on the call screens.

```tsx
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { CallProvider, useCall } from "@snakechat/commskit-mobile/call";
import { CallOverlay } from "@snakechat/commskit-mobile/call-ui";
import { ChatScreen, ConversationListScreen } from "@snakechat/commskit-mobile/chat-ui";

const nav = createNavigationContainerRef();
const Stack = createNativeStackNavigator();

function ChatRoute({ route, navigation }) {
  const { startCall } = useCall();   // the host bridges chat-ui -> call
  return (
    <ChatScreen
      peerId={route.params.peerId}
      onBack={navigation.goBack}
      onCall={(peerId) => startCall(peerId, { chatId: route.params.chatId })}
      pickAttachment={pickAttachment}
    />
  );
}

export default function App() {
  const openChat = (peerId: string) => nav.isReady() && nav.navigate("Chat", { peerId });
  return (
    <CommsProvider config={config}>
      <ThemeProvider>
        <ChatProvider>
          <CallProvider iceServers={iceServers} onCallError={handleCallError} onOpenChat={openChat}>
            <View style={{ flex: 1 }}>
              <NavigationContainer ref={nav}>
                <Stack.Navigator screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="Inbox" component={InboxScreen} />
                  <Stack.Screen name="Chat" component={ChatRoute} />
                </Stack.Navigator>
              </NavigationContainer>
              <CallOverlay showMessageAction />   {/* "Message" -> CallProvider.onOpenChat */}
            </View>
          </CallProvider>
        </ChatProvider>
      </ThemeProvider>
    </CommsProvider>
  );
}
```

During a call, the user can minimise the call screen, use the chat, and return with the pill. The
chat shows the live call entry, then the logged outcome (local and server `call_log`).

### Theming and overrides

```tsx
import { createTheme, ThemeProvider } from "@snakechat/commskit-mobile/theme";

<ThemeProvider
  theme={{
    colors: { accent: "#0F766E", bubbleOut: "#0F766E" },          // both schemes
    schemes: { dark: { accent: "#2DD4BF" } },                     // per scheme (wins)
    radius: { bubble: 14 },
    layout: { composerMaxLines: 4 },
    font: { nativeFamily: "Inter" },                              // native font family (default: system)
  }}
  renderIcon={(name, { size, color }) => <Ionicons name={ICONS[name]} size={size} color={color} />}
/>
```

`theme` also accepts a full `Theme` (`createTheme(overrides, "dark")`) or a `(scheme) => Theme`
function.

Icon names:
- Navigation: `back`, `minimise`, `chevronDown`, `close`, `search`, `retry`
- Calls: `call`, `callEnd`, `callIncoming`, `callOutgoing`, `callMissed`, `mic`, `micOff`,
  `speaker`, `speakerOff`
- Chat: `attach`, `send`, `file`, `image`, `message`
- Menus / appearance: `more`, `check`, `palette`

Return `undefined` from `renderIcon` to keep the built-in glyph.

### Replacing components

Full guide: [Customizing the UI](https://github.com/prateek0128/chat-call-module/blob/main/docs/mobile/04-customizing-the-ui.md).

Pass `components` to `ThemeProvider` (or `AppearanceProvider`). A replacement receives the same props as the built-in, so it keeps the full chat behaviour, and may render the built-in itself.

```tsx
import { DefaultAvatar, ThemeProvider } from "@snakechat/commskit-mobile/theme";
import type { ChatUiSlots } from "@snakechat/commskit-mobile/chat-ui";

const components = {
  MessageBubble: MyBubble,
  Avatar: (p) => <DefaultAvatar {...p} size={32} />,
} satisfies ChatUiSlots;

<ThemeProvider components={components}>...</ThemeProvider>
```

Every UI component is a slot: `Avatar`, `Icon`, `ScalePressable` (theme); the chat-ui components in `ChatUiSlots` (`ChatScreen`, `ChatHeader`, `MessageList`, `MessageBubble`, `Composer`, `ConversationList`, `ConversationRow`, sheets, viewers, banners and more); and the call-ui components in `CallUiSlots` (`CallScreen`, `CallOverlay`, `CallControls`, `CallButton`, `CallBackground`, `PulseAvatar`, `ReturnToCallPill`). The built-ins are exported as `Default<Name>`.

**Fully custom UI:** skip the components and build your own on the headless hooks and providers (`@snakechat/commskit-mobile/chat`, `@snakechat/commskit-mobile/call`, `@snakechat/commskit-mobile/core`); they hold all the chat and call logic and no markup.

### Appearance (themes & wallpapers)

Users pick a colour mode (Auto / Light / Dark), a **text size** (small / medium / large), a **density** (comfortable / compact), a chat theme (7 presets from
`tokens.json → themePresets`) and a chat wallpaper (default, solid, gradient or their own photo),
globally or per chat. These are local device preferences; nothing is sent to the other person.
See "Appearance: chat themes and wallpapers" in [`../design/DESIGN_SYSTEM.md`](https://github.com/prateek0128/chat-call-module/blob/main/design/DESIGN_SYSTEM.md).

`AppearanceProvider` replaces your `ThemeProvider` (it renders one with the user's mode and preset,
forwarding `theme` and `renderIcon`), so the whole kit re-themes live:

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppearanceProvider } from "@snakechat/commskit-mobile/theme";

<AppearanceProvider
  storage={AsyncStorage}            // default: async-storage if installed, else memory; null = don't persist
  renderIcon={renderIcon}           // forwarded to ThemeProvider (as is `theme`)
  onStorageError={() => toast("Couldn't save your wallpaper. It's kept until the app restarts.")}
>
  <App />
</AppearanceProvider>
```

Turn on the built-in entry points (both are off by default, so existing screens don't change):

```tsx
<ConversationListScreen showAppearanceAction pickWallpaperImage={pickWallpaperImage} onOpenConversation={open} />
<ChatScreen peerId={peerId} appearanceMenu pickWallpaperImage={pickWallpaperImage} />
```

- **List header "Appearance"** opens the `AppearanceSheet` in global mode. Pass `onOpenAppearance` to
  handle it yourself, for example to open a settings screen that renders `<AppearanceSheet visible onClose />`.
- **Chat header ⋮ → "Wallpaper"** opens the sheet for that chat, with the scope set to "This chat".
  It also offers "All chats" and "Reset this chat". `ChatHeader` takes `onOpenAppearance` and
  `menuItems` directly.
- **Picking an image is the host's job.** `pickImage({ maxEdge })` should downscale to `maxEdge`
  (`wallpapers.imageMaxEdge`, 1600 px) and copy the file to persistent storage, because the kit
  stores only the uri. With Expo:

```tsx
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system";

const pickWallpaperImage = async ({ maxEdge }: { maxEdge: number }) => {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
  if (res.canceled) return null;
  const a = res.assets[0];
  const resize = (a.width ?? 0) >= (a.height ?? 0) ? { width: Math.min(maxEdge, a.width ?? maxEdge) } : { height: Math.min(maxEdge, a.height ?? maxEdge) };
  const small = await ImageManipulator.manipulateAsync(a.uri, [{ resize }], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
  const dest = `${FileSystem.documentDirectory}wallpaper-${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: small.uri, to: dest });
  return { uri: dest, width: small.width, height: small.height };
};
```

**Rendering.** `MessageList` (and so `ChatScreen`) draws its background with `ChatWallpaper`, using the
chat's own wallpaper if it has one and the global wallpaper otherwise.
- Default: `colors.wallpaper` plus a subtle dot pattern. The pattern is one 16 px PNG tile
  repeated by a single `<Image resizeMode="repeat">`, so it doesn't add a view per dot. Turn it off
  with `<ChatWallpaper pattern={false}>`.
- Solid: a plain colour.
- Gradient: drawn by `renderGradient`, or by `expo-linear-gradient` when it is installed. Without
  either, the first stop is used as a solid colour.
- Image: `<Image resizeMode="cover">` with a dim overlay, white in light mode and black in dark mode,
  0–0.8. The default dim is 0 in light mode and 0.35 in dark mode.

Date chips, call entries, the empty state and the loading spinner all sit on surface-coloured
chips, so they stay readable on any wallpaper.

**Headless use.** Use `useAppearance()` → `{ mode, preset, wallpaper, perChat, wallpaperFor(peerId),
setMode, setPreset, setWallpaper(w, { peerId? }), resetWallpaper(peerId), ready }`. The pure helpers
are `resolveWallpaper(w, scheme)`, `clampDim`, `serializeAppearance` / `parseAppearance` (corrupted
data falls back to defaults) and `createTheme({ preset: "rose" }, "dark")`. A preset changes only the
accent and outgoing-bubble colours. Host `colors` / `schemes` overrides still win over a preset.
For controlled state, use `<AppearanceProvider value onChange>`.

### Host responsibilities

- **StatusBar:** left to the host. Call screens are dark, so switch to light content from
  `CallOverlay onVisibleChange`.
- **Safe areas:** wrap the app in `SafeAreaProvider` (react-native-safe-area-context), or pass
  `insets` to each screen.
- **Keyboard:** `ChatScreen` uses `KeyboardAvoidingView` (iOS `padding`). On Android, keep
  `windowSoftInputMode=adjustResize` (the Expo default).
- **Strings:** English only for now. There is no i18n prop yet.

### Accessibility

- Every icon button has a label: "Call Asha", "Attach file", "Send message", "Mute microphone",
  "Back", "Jump to latest".
- Touch targets are at least `layout.tapTarget` (44 pt), through size or `hitSlop`.
- New incoming messages in the open chat and call status changes are announced
  (`AccessibilityInfo.announceForAccessibility`, plus `accessibilityLiveRegion` on Android).
- Toggles (Mute / Speaker) report `checked`.
- Modals set `accessibilityViewIsModal`.
- Every swipe has an alternative. Bubbles expose "Reply" and "Message actions" screen-reader
  actions, and the in-app banner has a "Dismiss notification" button. The banner and toasts are announced.
- Reduced motion turns off every animation.

### What is and isn't tested

| Tested | How |
|---|---|
| Tokens: `src/theme/tokens.ts` equals `../design/tokens.json` (both schemes, radius, space, font, shadow, motion, layout, themePresets, wallpapers) | `__tests__/theme.test.ts` |
| Appearance logic: presets in both schemes (indigo = base, 4.5:1 bubble text), wallpaper render model per kind and scheme, dim clamp, per-chat override and reset, storage round-trip and corrupted data | `__tests__/appearance.test.ts` |
| Appearance UI: provider re-themes live, hydrates and persists, `ChatWallpaper` kinds, `AppearanceSheet` sections and setters, header / list entry points | `__tests__/appearanceUi.test.tsx` |
| Import boundaries for theme / chat-ui / call-ui and the engine folders | `__tests__/boundaries.test.ts` |
| Pure UI logic: grouping, date separators, list previews, call-entry labels, time formatting (naive UTC timestamps), unread badge, composer clamp, attachment size check, connection banner, responsive layout, call screen state mapping | `__tests__/chatUi.test.ts`, `callUi.test.ts`, `theme.test.ts` |
| Components render, wire props and follow provider state: lists, composer, chat screens with a real `CommsProvider` + `ChatProvider`, and `CallOverlay` with a real `CallProvider` (incoming, decline, failure reason) | `__tests__/uiRender.test.tsx`, using `react-test-renderer` and a react-native stand-in |
| Chat screen features (pure logic): reply snippet and sender, message action list per type and availability, media duration, swipe thresholds, banner dedupe and suppression | `__tests__/chatFeatures.test.ts` |
| Default `fileActions` adapter with mocked expo modules: download progress, share, fallback, permission denied | `__tests__/chatFeatures.test.ts` |
| Chat screen features (render): reply bar, actions sheet, quote jump, video bubble, in-app banner | `__tests__/chatFeaturesUi.test.tsx` |
| Types | `npm run typecheck` against `src/types/shims.d.ts` (a strict subset of the real RN types) |

react-native is not installed in this package, so these are not tested here:
- native layout
- real `FlatList` virtualisation and `maintainVisibleContentPosition`
- keyboard avoidance
- `Modal` presentation
- animations on the native driver
- screen-reader behaviour on devices
- gestures (swipe-to-reply, banner swipe) and haptics
- expo-video, expo-audio and expo-av playback
- real downloads, the share sheet and media-library permissions (only mocked modules are tested)

Check them in a host app on iOS and Android.

---

## Adapters

| Prop | Default | Contract |
|---|---|---|
| `ChatProvider readFileAsBase64` | `expoReadFileAsBase64` (lazily requires `expo-file-system/legacy`) | `(uri) => Promise<base64>` |
| `CallProvider webrtc` | `loadStreamWebRTC` (lazily requires `@stream-io/react-native-webrtc`) | `WebRTCFactory {createPeerConnection, getUserMedia, sessionDescription?, iceCandidate?}` |
| `CallProvider audio` | `createInCallManagerAudio()` (lazily requires `react-native-incall-manager`; no-op if missing) | `CallAudio {start({speaker}), stop, startRingtone, stopRingtone, startRingback?, stopRingback?, setSpeaker}` |
| `CallProvider notifier` | `noopNotifier` | `CallNotifier {showIncoming(info), dismiss(callId?), startOngoing(info), stopOngoing()}` |
| `CallProvider iceServers` | public STUN only | `IceServer[]` or `() => Promise<IceServer[]>` (`turnCredentialsIceServers(config)` for `/call/turn-credentials`) |

`createInCallManagerAudio({ringtone, ringSeconds = 45, vibrationPattern, ringback})`: the ringtone
plays only in the foreground, for at most the server's 45 s ring timeout. Ringback is off by
default, which matches Smart Matrimony today. Pass `ringback: "_DTMF_"` to enable it.

**Notifier.** The provider calls `showIncoming` while a call rings and the app is not in the
foreground. It calls `dismiss(callId)` once the call stops ringing or the app comes to the
foreground, and `dismiss()` to clear leftovers. While connected it calls `startOngoing` /
`stopOngoing`. Feed the notification buttons back in:

```ts
const { handleNotificationAction } = useCall();
// action: "answer" | "decline" | "hangup" | "open"
handleNotificationAction("answer", callId);
```

`answer` for a call that hasn't reached this app instance yet (cold start from the notification) is
remembered and accepted as soon as the call rings here. `decline` for an unknown call goes over
REST: `POST /call/{id}/reject`. `answer` waits until the app is active, because the mic can't open
in the background. Pass the notifier as a stable object (module-level or `useMemo`).

`CallProvider` also takes `onIncomingCall(state)`, `onShowCall(state)` (notification "open"), and
`requestUnknownCallerNames` (default true: `req_users` when an unknown caller rings).
`ChatProvider` also takes `pageSize` (10), `maxUploadBytes` (10 MB) and `autoMarkReadActive` (true).

### Framework-free use

`CommsClient`, `ChatStore` and `VoiceCallEngine` import neither React nor react-native. Each exposes
`subscribe` / `getSnapshot` (`useSyncExternalStore`-ready) and takes injected seams: `appState`,
`createWebSocket`, `send`, `webrtc`, `audio`. That is how they're unit-tested.

`CommsClient` options:
- `offlineSendPolicy`: `"drop"` (default; `send` returns false) or `"queue"` (flushed on open), or a
  per-frame function.
- `maxQueue` (100).
- `pingIntervalMs` (off).

---

## Push notifications

`@snakechat/commskit-mobile/notifications` (imports `core` only) registers the device with the backend's
`DeviceRegistry` (PROTOCOL §8) and routes taps. Install the optional peers:

```bash
npx expo install expo-notifications expo-device
```

```tsx
import { registerDevice, unregisterDevice, useNotificationRouting } from "@snakechat/commskit-mobile/notifications";

// After login and on every app start (tokens rotate; the backend upserts by device_id).
// Asks permission, creates the Android channels `messages` (default importance) and
// `call_ringtone` (max, bypasses Do Not Disturb where allowed), reads the Expo push token and
// POSTs /devices {device_id, platform, expo_push_token, voip_token?, app_version, os_version, model}.
const result = await registerDevice({
  config,                                       // same object as <CommsProvider config>
  deviceId: await getStableInstallId(),         // recommended (e.g. expo-application ids); default derives from the token
  appVersion: Constants.expoConfig?.version,
  getVoipToken: () => voipToken,                // iOS, see the next section
  // projectId: "<EAS project id>",             // when expo-notifications can't infer it
});
// result: { registered, deviceId, permission, expoPushToken, voipToken, reason? }

// Logout, BEFORE dropping the auth token: DELETE /devices/{device_id}
await unregisterDevice();

// Inside your navigator, once:
function NotificationRouter() {
  const navigation = useNavigation();
  useNotificationRouting({
    onOpenChat: (peerId) => navigation.navigate("Chat", { peerId }),  // message or missed-call tap (also cold start)
    onIncomingCall: (call) => navigation.navigate("Call"),            // optional; suppresses foreground call banners
    suppressFor: () => activeChatPeerId.current,                      // no banner for the chat on screen
  });
  return null;
}
```

- `parseNotificationData(anything)` normalises Expo `Notification` / `NotificationResponse`
  objects, the plain `data` object and the stringified-`body` / `dataString` variants that
  Android data-only and background-task payloads use. It returns
  `{type: "chat", peerId, chatId}` (peer from `cid: "messaging:<id>"`), `{type: "incoming_call", callId, callerId, callerName, callType, uuid?}`,
  `{type: "missed_call", ...}`, `{type: "unknown"}`, or null.
- `notificationTapTarget` and `notificationPresentation` are the pure routing decisions that the
  hook uses, exported so you can call them from your own handlers.
- The legacy `registerPushToken` / `removePushToken` (`/chats/expo/push/token`) in
  `@snakechat/commskit-mobile/chat` still work for installed apps. New apps use `registerDevice`.

## Incoming calls when the app is closed (iOS CallKit + VoIP, Android full-screen)

`@snakechat/commskit-mobile/call-native` is a call add-on (imports `core` + `call`, never `chat`). It gives
`<CallProvider>` a `CallNotifier` backed by the OS call UI, plus the native plumbing to ring while the
app is killed.

```bash
npx expo install react-native-callkeep react-native-voip-push-notification @notifee/react-native \
  expo-notifications expo-task-manager @react-native-async-storage/async-storage
```

`app.json` (a dev build or EAS build is required; this does not work in Expo Go):

```jsonc
{
  "expo": {
    "plugins": [
      ["@snakechat/commskit-mobile", { "microphonePermission": "Allow $(PRODUCT_NAME) to use the microphone for calls." }]
      // options: voip (default true), callKeepService (default true), notifeeForegroundService (default true),
      //          androidPermissions: [...extra]
    ],
    "ios": { "bundleIdentifier": "com.example.app" }
  }
}
```

The plugin (`app.plugin.js`, plain CommonJS, idempotent marker-guarded edits) adds:
- **Android**: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL`, `FOREGROUND_SERVICE_MICROPHONE`,
  `MANAGE_OWN_CALLS`, `VIBRATE`, `WAKE_LOCK`. It also declares CallKeep's `VoiceConnectionService`
  (+ `RNCallKeepBackgroundMessagingService`) and notifee's `ForegroundService` with
  `foregroundServiceType="phoneCall|microphone"` (`tools:replace`). notifee 7+ resolves its Maven
  repo through autolinking. On older setups, add
  `maven { url "$rootDir/../node_modules/@notifee/react-native/android/libs" }` to `android/build.gradle`.
- **iOS**: `UIBackgroundModes` `audio`, `voip`, `remote-notification`, plus `NSMicrophoneUsageDescription`.
  In the Swift `AppDelegate` (Expo SDK 53+), it adds `import PushKit`, calls
  `RNVoipPushNotificationManager.voipRegistration()` before `return super.application(...)`, and adds
  an `extension AppDelegate: PKPushRegistryDelegate` that reports every VoIP push to CallKit
  (`RNCallKeep.reportNewIncomingCall`) **synchronously**. iOS 13+ requires this, or it stops
  delivering VoIP pushes. It also adds the `RNCallKeep.h` / `RNVoipPushNotificationManager.h`
  imports to the bridging header. Objective-C AppDelegates are rejected with a clear error: add the
  same code by hand, or pass `voip: false`.

```tsx
// index.js — module scope, BEFORE registerRootComponent (background tasks must exist at launch)
import { registerBackgroundCallHandler } from "@snakechat/commskit-mobile/call-native";
if (Platform.OS === "android") registerBackgroundCallHandler(); // data-only incoming_call -> full-screen notification

// calls.ts — create once
import { createPlatformCallNotifier, registerVoipPush, saveCallSession, clearCallSession, useNativeCallNotifier } from "@snakechat/commskit-mobile/call-native";
export const callNotifier = createPlatformCallNotifier({ ios: { appName: "My App" }, android: { texts: { answer: "Answer" } } });

// App
<CommsProvider config={config}>
  <CallProvider notifier={callNotifier}>
    <NativeCallBridge />
    ...
  </CallProvider>
</CommsProvider>

function NativeCallBridge() {
  useNativeCallNotifier(callNotifier); // CallKit / notification buttons -> useCall(); mute synced to CallKit
  return null;
}

// After login (and whenever the token refreshes): lets a killed app decline a call over REST.
await saveCallSession({ baseUrl: config.baseUrl, token });
// iOS: PushKit token -> POST /devices voip_token
registerVoipPush((voipToken) => registerDevice({ config, deviceId, getVoipToken: () => voipToken }), { notifier: callNotifier as any });
// Logout:
await clearCallSession();
await unregisterDevice();
```

How it behaves:
- **iOS**: the backend sends an APNs VoIP push with `uuid = uuid5(NAMESPACE_URL, "commskit:call:" + call_id)`,
  where `NAMESPACE_URL = 6ba7b811-9dad-11d1-80b4-00c04fd430c8`. In Python that's
  `uuid.uuid5(uuid.NAMESPACE_URL, f"commskit:call:{call_id}")`, and `callKitUuid(callId)` here gives
  the same value (pinned by shared test vectors). AppDelegate shows CallKit at once. JS later maps
  CallKit answer / end / mute back to the call. Answer goes out once iOS activated the audio session
  (fallback after 1.5 s). If the socket hasn't delivered the call yet, `handleNotificationAction`
  keeps a pending answer. Decline → `reject_call`, or `POST /call/{id}/reject` when the call isn't
  known yet. A call reported from a push that the app never sees stops ringing after 45 s.
  Connected calls are registered with CallKit (`startCall` / `setCurrentCallActive`) and ended with `endCall`.
- **Android**: the backend (`android_call_style = "data"`) sends a data-only, high-priority push.
  The expo-notifications background task shows a notifee notification: `CATEGORY_CALL`,
  full-screen intent, `Decline` / `Answer`, 45 s timeout. Answer opens the app, and the notifier
  reads it with `getInitialNotification`, then answers as soon as the call rings in the app.
  Decline while killed calls `POST /call/{call_id}/reject` with the stored session. A running app
  instance handles it through `CallProvider` instead. A connected call runs a
  `phoneCall|microphone` foreground service with a chronometer and `Hang up`.
- Elsewhere `createPlatformCallNotifier` returns a no-op notifier.

Backend config: device registry + `DevicePushRouter`, APNs VoIP credentials (`APNS_*`, `pip install -e "./backend/backend-python[apns]"`)
and `android_call_style="data"`. See [backend README: Devices and push notifications](https://github.com/prateek0128/chat-call-module/blob/main/backend/backend-python/README.md#devices-and-push-notifications-protocolmd-section-8)
and [APNs VoIP (iOS CallKit)](https://github.com/prateek0128/chat-call-module/blob/main/backend/backend-python/README.md#apns-voip-ios-callkit).

## Report & block

`@snakechat/commskit-mobile/moderation` (imports `core` only) implements PROTOCOL §7. `ModerationStore` is
framework-free. Its block list follows the WS events `user_blocked`, `blocked_by_user`,
`user_unblocked` and `unblocked_by_user`, plus the `is_blocked` / `blocked_by_other` flags in
`res_users` and `res_messages.info`. Writes go over REST (`POST`/`DELETE /moderation/blocks`,
`POST /moderation/reports` with an explicit `block`, `GET /moderation/blocks`). Updates are
optimistic and roll back on failure. A local `user_blocked` / `user_unblocked` frame keeps
`ChatStore` (which now also tracks these events) in sync immediately.

```tsx
import { ModerationProvider, useBlocking } from "@snakechat/commskit-mobile/moderation";
import { BlockedUsersScreen, ChatScreen, ReportSheet } from "@snakechat/commskit-mobile/chat-ui";

<CommsProvider config={config}>
  <ModerationProvider>
    <ChatProvider>
      <ChatScreen peerId={peerId} moderationMenu />   {/* header: Report, Block / Unblock; composer: "You blocked Nia. Unblock" */}
    </ChatProvider>
  </ModerationProvider>
</CommsProvider>

const { blockedIds, isBlocked, blockedByOther, block, unblock, report, listBlocked } = useBlocking();
await report({ peerId, category: "harassment", reason: "…", messageId, block: true });

// Settings > Blocked users
<BlockedUsersScreen />
```

- `ReportSheet` offers the §7 categories (spam, harassment, inappropriate, fake profile, scam,
  underage, other), an optional free-text reason ("other" requires one) and "Also block"
  (default on). After sending it shows a confirmation and announces it to screen readers.
- `Composer` takes `blockedState` (`blocked` with an Unblock link, or `blocked_by_other` showing
  "You can't reply to this conversation"). `ChatScreen moderationMenu` wires it up.
- `CallOverlay` hides "Call again" for a blocked pair when a `<ModerationProvider>` is mounted. A
  call refused because of a block (`error.reason: "blocked"`) is reported as error kind `blocked`
  ("You can't call this person", not retryable).
- Without `<ModerationProvider>`, chat-ui and call-ui behave as before (moderation is opt-in).

### What must be verified on real devices

None of the native paths below can run in this package's tests. The libraries are mocked, so the
tests cover the JS logic and the plugin's text/object transforms only. Check these on hardware:
- iOS: a VoIP push to a killed / locked app shows CallKit; answering from the lock screen connects
  audio (audio-session activation + WebRTC). Decline / end from CallKit reaches the server. The
  generated Swift `AppDelegate` extension and bridging header compile with your SDK / library
  versions. The Swift selector names of `RNCallKeep.reportNewIncomingCall` and
  `RNVoipPushNotificationManager` are taken from their ObjC headers. The PushKit token reaches
  `POST /devices` (sandbox vs production APNs environment).
- iOS: the `uuid` from the backend matches `callKitUuid` (shared vectors in tests). Also check that
  a CallKit call is not left ringing after the caller cancels while the app is killed (45 s fallback).
- Android 12–15: the data-only push wakes the background task when the app is killed (OEM battery
  optimisers may block it). The full-screen intent shows on the lock screen (Android 14 needs
  `USE_FULL_SCREEN_INTENT` granted; Play policy limits it to calling apps). Answer launches the app
  and connects. Decline while killed sends `/call/{id}/reject` (the stored token must still be
  valid). The `phoneCall|microphone` foreground service starts without a `ForegroundServiceTypeException`.
- Both: notification permission prompts, channel importance/sound (channels are immutable once
  created; reinstall to change them), cold-start tap routing, and foreground banner suppression
  for the open chat.

---

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (src + tests; RN/peer APIs via src/types/shims.d.ts)
npm test            # jest + ts-jest: CommsClient, ChatStore, VoiceCallEngine, compat, REST, boundaries,
                    # UI helpers, token consistency, UI render smoke tests
```

Tests run on pure TS with mocks: a mock WebSocket and AppState, and a mock RTCPeerConnection and
mediaDevices. No react-native preset is needed.

`src/types/shims.d.ts` declares only the subset of globals and `react-native` the kit uses,
including the UI kit's components and APIs. A host app gets the real types instead.

The UI render smoke tests (`__tests__/uiRender.test.tsx`) use `react-test-renderer` with a
hand-written react-native stand-in (`__tests__/rn-mock/react-native.js`). See
[what is and isn't tested](#what-is-and-isnt-tested).

---

## Example migration: Smart Matrimony (documentation only — the app is not changed by this kit)

| Old (smm_android_react_native_v2) | New |
|---|---|
| `WebSocketProvider` (`src/contexts/websocketContext.tsx`), mounted 3× = 3 sockets | `<CommsProvider>` once at the root + `<ChatProvider>` (1 socket total, shared with calls) |
| `useWebSocket().users / fetchUsers / usersRevision` | `useConversations()` → `{conversations, loaded, refresh}` |
| `selectUser(user)` + `messages` + `loadMoreMessages` + `hasMoreMessages` + `loadingMore` | `useConversation(user.user_id, {chatId: user.chat_id})` → `{messages, loadMore, hasMore, loadingMore, loading}` |
| `sendMessage(text, user, replyTo)` | `useConversation(peerId).send(text, replyTo)` |
| `handleFileUpload(attachment, user, replyTo)` | `useConversation(peerId).sendMedia({uri, name, type, size}, replyTo)` (Alerts → `ChatProvider onError`) |
| `handleTyping(bool)` / `typingUsers[chat_id]` | `setTyping(bool)` / `useConversation(peerId).typing` (keyed by peer) |
| `markAsRead(user)` | `markRead()` (also automatic on open and for messages arriving in the active chat) |
| `setActiveChatId(chat_id)` / `getActiveChatId()` (notificationService) | `useChat().setActiveChat(peerId)` / `useChat().activePeerId` (automatic while `useConversation` is mounted) |
| `chatConsent`, `isBlocked`, `blockedByOther` | `useConversation(peerId).thread.info` (`chat_consent_given`, `is_blocked`, `blocked_by_other`) |
| `sendChatConsent`, `reportAndBlockUser`, `unblockUser` (host extensions) | app code: `useComms().client.send("chat_consent", {...})`, and listen with `client.on("user_blocked", ...)`. Apply results with `useChat().store.updateInfo(peerId, {is_blocked: true})` / `store.removeConversation(peerId)` |
| community events (`new_post`, …) re-emitted via DeviceEventEmitter | app code: `useComms().client.on("new_post", handler)` (same socket) |
| `CallProvider` + `useCall()` (`src/contexts/callContext.tsx`), own socket | `<CallProvider>` from `@snakechat/commskit-mobile/call` (no own socket) |
| `useVoiceCall(socket)` (`src/hooks/useVoiceCall.ts`) | `VoiceCallEngine` inside `CallProvider`; use `useCall()` |
| `startCall(receiverId, chatId, receiverName, creditAcknowledged)` | `startCall(receiverId, {chatId, peerName, extra: {credit_acknowledged}})` |
| `callState.callerId / callerName` (peer, with the caller-view quirk) | `state.peerId / peerName` (normalised by `call/compat.ts`) |
| `NoCreditModal` / `CallCreditRequiredModal` inside the provider | `onCallError={(err, retry) => …}`. `err.kind === "policy"`, `err.status` 402/403, credit info in `err.raw.info`. "Confirm" → `retry()` (sends `credit_acknowledged: true`) |
| `onNotice` flash messages ("User is busy", server errors) | `onCallError` with `kind: "busy" \| "server" \| ...` |
| `alert(...)` in useVoiceCall (no mic, not connected, already in a call) | `onCallError` with `kind: "microphone" \| "not_connected" \| "already_in_call" \| "unavailable"` |
| `navigate("Channel", {cid: "messaging:<peer>"})` from call screens | `onOpenChat={(peerId) => navigate("Channel", {cid: \`messaging:${peerId}\`})}` + `useCall().openChat()` |
| ended screen state (`endedCall`, Call again) | `useCall().lastEnded`, `callAgain()`, `clearLastEnded()` |
| `CALL_LOG_EVENT` DeviceEventEmitter fallback | automatic local `call_log` (`emitLocalCallLog`) |
| `rememberUserNames` / `getUserName` (`src/utils/userNames.ts`) | `useComms().users` (`UserDirectory`): `remember`, `getName`, `getAvatar`; hook `useUserProfile(id)` |
| `formatCallDuration` / `callLogText` (`src/utils/callDuration.ts`), `parseCallEntry` / `friendlyDuration` (CustomMessageBubble) | same names in `@snakechat/commskit-mobile/core` (re-exported by chat/call) |
| `startChat`, `sendExpoPushToken`, `removeExpoPushToken` (`src/apiServices/chat.ts`, axios) | `useChatApi().startChat / registerPushToken / removePushToken` (fetch + `getToken`) |
| InCallManager in `CallScreenUI` (start on connect, speaker) + `startCallRingtone` | `CallAudio` adapter (default `createInCallManagerAudio()`); `useCall().toggleSpeaker()` |
| hard-coded TURN (`webrtcuser` / `webrtcpass`) | `iceServers={turnCredentialsIceServers(config)}` (backend `/call/turn-credentials`) |
| native Android `CallNotification` module (`utils/callNotification.ts`: `showIncomingCallNotification`, `dismissIncomingCallNotification`, `startOngoingCall`, `stopOngoingCall`, `registerCallNotificationHandlers`) | a `CallNotifier` adapter wrapping those functions + `registerCallNotificationHandlers({answer: id => handleNotificationAction("answer", id), decline: …, hangup: …, openCall: id => handleNotificationAction("open", id)})` |
| `AsyncStorage` `authToken` / `userId`, `wsBaseUrl` / `apiUrl` | `CommsConfig.getToken / getUserId / baseUrl` |

Things that stay in the Smart Matrimony app: lock-screen handling (`isDeviceLocked`, `releaseLockScreen`,
`ensureFullScreenCallPermission`), the call UI and chat screens (phase 9 offers themeable ones
later), ads, credit modals and in-app banners.

---

## Behaviour notes and differences from the Smart Matrimony app

These are client-side choices. The wire protocol is unchanged.
- Messages are kept **per conversation** (keyed by peer id), newest first. Smart Matrimony kept one global list.
- `message_sent` replaces the matching optimistic message, preferring the same text, then the oldest
  pending one. Smart Matrimony dropped *all* temps on any message event, including an incoming one.
- `loadMore` offset = number of server messages loaded (Smart Matrimony: +10 per page). This stays correct
  after live messages arrive.
- Typing is tracked per peer, each with its own 4 s timer. Smart Matrimony used one shared timer.
- Unknown chat in `new_message` → one `req_users` refresh (Smart Matrimony ignored the message in the list).
- `call_initiated` is only acted on by the device that sent `call_initiate`. A user's other devices
  no longer create an offer.
- `call_answered` by our own id on a device that didn't accept ends with `endReason: "answered_elsewhere"` (Smart Matrimony: `missed`).
- A `call_initiate` with no reply within 15 s is abandoned, so the client can't get stuck "already in a call".
- `user_status` reports `away` in the background (Smart Matrimony sent `offline`; both mean "not online" to the server).
- The local call-log text uses the backend wording, including `Cancelled voice call`.

## Chat extras (PROTOCOL section 9)

Engine (`@snakechat/commskit-mobile/chat`): `ChatStore` handles `message_deleted` (for everyone: "This message was deleted" placeholder; for me: removed), `chat_cleared` (drops messages up to `cleared_at`, resets preview and unread), system messages (`message_type`/`sender_type` "system", never "mine"), and `rate_limited` / `too_long` errors (the optimistic message stays as `failed` with a retry; `onError` gets `retryAfter` / `max`; `state.rateLimitedUntil` is set). `mark_read` also sends `candidate_user_id`. `useConversation()` adds `deleteMessage(id, { forEveryone })`, `clearChat()`, `retryMessage(id)` and `rateLimitedUntil`.

UI (`@snakechat/commskit-mobile/chat-ui`), all opt-out props on `ChatScreen` / `ConversationList`:
- Header subtitle: `last seen just now / N min ago / today at 6:02 PM / yesterday at ... / 13 Sep at ...` (naive UTC timestamps are handled). Priority: You are blocked > Blocked > typing... > online > last seen > offline. One shared 60 s ticker (`useSharedTicker`). `clock="24h"` switches the format. Blocked either way hides the online dot and the call action.
- `ConversationList` / `ConversationListScreen`: filter chips All / Unread N plus host filters (`filters`, `filter`, `onFilterChange`, `showFilters`) with filter-aware empty states. Blocked rows show "You blocked this contact" / "Blocked by {name}" and no online dot. Search also matches the last message text (accent-insensitive).
- Bubbles: sending overlay (spinner and "Sending...") on image/video/file while pending, image load spinner, failed state with "Not sent. Tap to retry", deleted bubble (italic), centred system chip, document badges (`documentBadge(name, mime)`; "PDF . 1.2 MB").
- Calls: the caller sees neutral "No answer" / "Declined"; the callee sees red "Missed voice call" with "Tap to call back".
- Floating sticky day label while scrolling (fades after 1.5 s; instant with reduced motion). `stickyDateLabel` prop on `MessageList`.
- Long-press menu: "Delete for me", "Delete for everyone" (own messages within `unsendWindowSeconds`, default 3600; 0 = no limit, -1 = off), "Retry". Header menu "Clear chat" (confirm dialog, `clearChatMenu`). Rate-limit toast: "You're sending messages too fast. Try again in N s".
- `ImageViewer` has Save and Share buttons (ChatScreen wires them to the `fileActions` adapter).
- Attach menu: `pickers` prop on `ChatScreen` (`AttachPicker[]`: key, label, icon, `pick(): Promise<File|null>`). `createExpoPickers()` builds gallery / camera / video / record / document on expo-image-picker and expo-document-picker. `pickAttachment` still works.
- Message sound: `useMessageSound({ source, enabled, muted })` or `<InAppMessageBanner soundSource soundMuted />`. Uses expo-audio, else expo-av, else is silent. Plays for non-active chats while the app is foregrounded.
- In-app document viewer: `DocumentViewerModal` on react-native-webview, with `documentViewerUrl(fileUrl)` (default: the file URL itself). A Google gview URL is an opt-in because it sends the file URL to a third party: `(u) => "https://docs.google.com/gview?embedded=true&url=" + encodeURIComponent(u)`. Without the WebView, files open via `Linking`.
- Pre-chat gate: `gate={(info) => ReactNode | null}` is rendered over the message list and composer until it returns null. Use `composerDisabledReason` to block typing. Consent example: return a card that sends your own WS frame (for example `client.send("consent", { peer })`), then update the info with `store.updateInfo(peerId, { consent: true })` and return null.

New optional peers: `expo-image-picker`, `expo-document-picker`, `react-native-webview` (all lazily required in `chat-ui/optionalPeers.ts`).
