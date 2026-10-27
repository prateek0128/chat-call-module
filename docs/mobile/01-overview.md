# commskit mobile: overview

What the mobile package is, what is inside, and what is (and is not) verified.

Next: [02 Keys, secrets, WebSockets and placeholders](02-keys-secrets-websockets-and-placeholders.md) · [03 Using, running and deploying](03-using-running-and-deploying.md) · Example app: [mobile-example](../example/mobile-example.md)

## Contents

1. [What it is](#1-what-it-is)
2. [Why you need it](#2-why-you-need-it)
3. [Map of entry points](#3-map-of-entry-points)
4. [Headless vs ready-made UI](#4-headless-vs-ready-made-ui)
5. [Dependency rules](#5-dependency-rules)
6. [Optional peer dependencies](#6-optional-peer-dependencies)
7. [Feature list](#7-feature-list)
8. [Shared engine with the web package](#8-shared-engine-with-the-web-package)
9. [What is NOT included](#9-what-is-not-included)
10. [Testing status](#10-testing-status)
11. [Not verified on real devices](#11-not-verified-on-real-devices)

Paths below are relative to `comms-kit/` unless stated. Everything here was checked against `mobile/package.json`, `mobile/src/*`, `mobile/plugin/withCommskit.js`, `mobile/README.md` and `docs/archive/PROTOCOL.md`.

## 1. What it is

| Item | Value |
|---|---|
| Folder | `mobile/` |
| npm package name | `commskit` (version `0.1.0`) |
| Language | TypeScript **source** (no build step; `main`/`types` point at `src/index.ts`). Metro and Babel compile it like your own code |
| Targets | Expo SDK 54 / React Native 0.81 / React 19.1 (this is what the example app and the dev dependencies use). Peer ranges are looser: `react >=18`, `react-native >=0.72` |
| Wire protocol | `docs/archive/PROTOCOL.md` (v1), compatible with the Smart Matrimony apps |
| Status of the package | `"private": true`, `"license": "UNLICENSED"` in `mobile/package.json`. You must change both before publishing (see [03 section 2](03-using-running-and-deploying.md#2-getting-the-package-into-your-app)) |

It is the mobile half of commskit: 1:1 **chat** and 1:1 **voice calls** (peer-to-peer WebRTC, the server only relays signalling), talking to the commskit backend (`backend/backend-python/`).

## 2. Why you need it

Without the kit, a phone app has to build all of this itself:

| Piece | What you would have to write |
|---|---|
| Socket | One authenticated WebSocket, reconnect with backoff, foreground/background handling, presence, ping/pong, queue or drop while offline |
| State | Conversation list, per-chat message pages, optimistic sends, read ticks, typing, unread counts, delete/unsend/clear, rate-limit errors |
| Call engine | Signalling state machine, WebRTC offer/answer/ICE, TURN credentials, ringing timeouts, busy/declined/missed handling, call log entries in chat |
| Screens | Conversation list, chat (bubbles, replies, media, files, composer), call screen, minimise pill, report/block screens |
| Push | Device registration, Expo push token, Android channels, tap routing, VoIP token |
| Native call UI | iOS CallKit + PushKit, Android full-screen incoming call + foreground service, answering when the app is killed |
| Moderation | Block, unblock, report, "you are blocked" states |
| Theming | Light/dark, presets, wallpapers, accessibility, reduced motion |

The kit provides all of it. You supply: login/tokens, navigation, branding, and the pickers/storage choices listed in [02 section 5](02-keys-secrets-websockets-and-placeholders.md#5-placeholders).

## 3. Map of entry points

Import each feature from its own entry so Metro bundles only what you use. `import ... from "commskit"` re-exports **core only** (`mobile/src/index.ts`).

| Entry (`exports` key in `package.json`) | Main exports | Needs (besides `react`, `react-native`) |
|---|---|---|
| `commskit/core` (also `commskit`) | `CommsClient`, `CommsProvider`, `useComms`, `useConnectionStatus`, `useIsConnected`, `useUserProfile`, `CommsConfig`, `authFetch`, `deriveWsUrl`, `socketUrl`, `consoleLogger`, `UserDirectory`, wire types, `parseNotificationData`, call-log helpers (`parseCallEntry`, `formatCallDuration`, ...) | nothing |
| `commskit/chat` | `ChatProvider`, `ChatStore`, `useChat`, `useConversations`, `useConversation`, `useUnreadCount`, `useChatApi`, `startChat`, legacy `registerPushToken` / `removePushToken`, `expoReadFileAsBase64` | `expo-file-system` (optional, default media reader; or pass `readFileAsBase64`) |
| `commskit/call` | `CallProvider`, `useCall`, `VoiceCallEngine`, `turnCredentialsIceServers`, `PUBLIC_STUN`, `createInCallManagerAudio`, `noopNotifier`, `CallNotifier`/`CallAudio` types | `@stream-io/react-native-webrtc`, `react-native-incall-manager` (optional peers, lazily required) |
| `commskit/theme` | `tokens`, `createTheme`, `ThemeProvider`, `useTheme`, `AppearanceProvider`, `useAppearance`, `Avatar`, `Icon`, `ScalePressable`, `useSafeInsets`, `useReducedMotion`, `useResponsiveLayout` | `react-native-safe-area-context` and `@react-native-async-storage/async-storage` (optional) |
| `commskit/chat-ui` | `ConversationListScreen`, `ChatScreen`, `ConversationList`, `MessageList`, `MessageBubble`, `Composer`, `AppearanceSheet`, `ReportSheet`, `BlockedUsersScreen`, `InAppMessageBanner`, `useInAppBanner`, `createExpoPickers`, `createDefaultFileActions`, pure helpers | `theme` + `chat` + optional peers (section 6) |
| `commskit/call-ui` | `CallOverlay`, `CallScreen`, `CallControls`, `CallButton`, `PulseAvatar`, `ReturnToCallPill`, `CallBackground` | `theme` + `call` |
| `commskit/notifications` | `registerDevice`, `unregisterDevice`, `ensureNotificationChannels`, `useNotificationRouting`, `parseNotificationData` | `core` + `expo-notifications`, `expo-device` (optional peers) |
| `commskit/call-native` | `createPlatformCallNotifier`, `useNativeCallNotifier`, `registerVoipPush`, `registerBackgroundCallHandler`, `saveCallSession`, `clearCallSession`, `callKitUuid`, `createCallKitNotifier`, `createAndroidCallNotifier` | `core` + `call` + `react-native-callkeep`, `react-native-voip-push-notification`, `@notifee/react-native`, `expo-task-manager` (optional peers) |
| `commskit/moderation` | `ModerationProvider`, `ModerationStore`, `useBlocking`, `useOptionalBlocking`, `REPORT_CATEGORIES` | `core` |
| `commskit/engine` | The framework-free engine: `CommsClient`, `ChatStore`, `ModerationStore`, wire types, pure `chat-ui` and `theme` helpers. **No** React, **no** react-native | nothing |
| `commskit/app.plugin.js` | Expo config plugin, used as `"plugins": ["commskit"]` in `app.json` | `@expo/config-plugins` (present in every Expo app) |

The mobile `README.md` table does not list `commskit/engine`; it exists in `package.json` and `src/engine/index.ts` (see the inconsistency list in the hand-over report).

## 4. Headless vs ready-made UI

| Kind | Entries | What you get |
|---|---|---|
| Headless (no UI) | `core`, `chat`, `call`, `notifications`, `call-native`, `moderation`, `engine` | State, hooks, REST/WS, native call plumbing. Build any UI on top |
| Ready-made UI | `theme`, `chat-ui`, `call-ui` | Themeable React Native screens built on the hooks. Optional |
| Build-time | `commskit/app.plugin.js` | Native manifest/Info.plist/AppDelegate changes at prebuild |

`CommsClient`, `ChatStore` and `VoiceCallEngine` import neither React nor react-native, and expose `subscribe` / `getSnapshot`, so you can use them with any UI layer.

## 5. Dependency rules

Enforced by `mobile/__tests__/boundaries.test.ts` (`npm run check:boundaries`).

| Rule | Why |
|---|---|
| `chat` and `call` import only `core`. **Never each other** | A chat-only app does not load call code; a call-only app does not load chat code |
| Only `src/call` touches WebRTC / InCallManager | Native peers stay in one place |
| Only `src/chat/media.ts` touches `expo-file-system` (plus the chat-ui file actions via `optionalPeers.ts`) | Same |
| Every optional peer is loaded with a lazy `require()` inside `try/catch` | Missing peer = feature off, not a crash at import (Metro needs `allowOptionalDependencies`, see [03](03-using-running-and-deploying.md#metro-config)) |
| `chat-ui` never imports `call` / `call-ui`; `call-ui` never imports `chat` / `chat-ui`; `theme` imports neither | UI kits stay independent |
| Engine folders import no UI | Engine stays portable |
| `call-native` imports `core` + `call`, never `chat`; `notifications` and `moderation` import `core` only | Add-ons stay separable |

Chat and call are glued only through socket events and host props (`CallProvider onOpenChat`, `ChatScreen onCall`).

## 6. Optional peer dependencies

All of these are `peerDependenciesMeta.optional: true` in `package.json` except `react` and `react-native`. Install with `npx expo install <name>` (exact commands per mode in [03 section 2](03-using-running-and-deploying.md#installing-peers)).

| Package | Used by | What happens without it |
|---|---|---|
| `@stream-io/react-native-webrtc` | `call` (`loadStreamWebRTC`) | Calls cannot start (you can pass your own `webrtc` factory to `CallProvider`) |
| `react-native-incall-manager` | `call` audio adapter | No ringtone/speaker routing (no-op audio). Pass `speakerAvailable={false}` to `CallOverlay` |
| `expo-file-system` | `chat` default `readFileAsBase64`; chat-ui downloads | Uploads need your own `readFileAsBase64`; files open via `Linking` |
| `react-native-safe-area-context` | `theme` `useSafeInsets` | Insets are 0 unless you pass `insets` to each screen |
| `@react-native-async-storage/async-storage` | `AppearanceProvider`, `call-native` saved call session | Appearance lasts one session; the saved call session lives in memory only (does **not** survive a killed app) |
| `expo-linear-gradient` | gradient wallpapers, `CallOverlay renderBackground` | First gradient colour as a solid / banded Views |
| `expo-notifications`, `expo-device` | `notifications`, background call task | `registerDevice` / `useNotificationRouting` throw or are unavailable |
| `expo-task-manager` | `registerBackgroundCallHandler` | Throws with an install hint |
| `react-native-callkeep` | iOS CallKit, Android ConnectionService | No native call UI |
| `react-native-voip-push-notification` | iOS VoIP token | `registerVoipPush` throws with an install hint |
| `@notifee/react-native` | Android full-screen call notification, foreground service | No full-screen call UI |
| `@expo/config-plugins` | the config plugin | Plugin cannot run (already in every Expo app) |
| `react-native-gesture-handler` | swipe to reply, banner swipe | Reply from long-press menu; banner has a close button |
| `expo-haptics` | swipe haptic | No haptic |
| `expo-clipboard` | "Copy text" | Item hidden |
| `expo-video` | in-app video player | Opens via `Linking` / `onOpenVideo` |
| `expo-audio` or `expo-av` | audio message player, message sound | File card / silent |
| `expo-sharing` | Share | Falls back to `Linking.openURL(file_url)` |
| `expo-media-library` | Save to gallery | "Download" instead |
| `expo-image-picker`, `expo-document-picker` | `createExpoPickers()` (attach menu) | You supply your own `pickAttachment` / `pickers`, or no attach button |
| `react-native-webview` | `DocumentViewerModal` | Files open via `Linking` |

## 7. Feature list

**Chat** (`chat`, `chat-ui`)
- Conversation list (newest first, live), unread badges, search (also matches last message text), filter chips All / Unread plus host filters.
- Message pages (page size 10, load older on scroll), optimistic sending, failed state with retry, sent / delivered / read ticks, typing indicator, date separators and a floating sticky day label.
- Text, images, video, audio, files. Upload limit 10 MB (`MAX_UPLOAD_BYTES`). Attachment preview before sending.
- **Reply** (swipe, long-press, screen-reader action), quoted reply bar, jump to original.
- **Message actions**: Copy, Save to gallery / Download, Share, Report, host-defined `messageActions`.
- **Unsend / delete / clear**: "Delete for me", "Delete for everyone" (own messages inside `unsendWindowSeconds`, default 3600), "Clear chat" with confirm dialog (PROTOCOL section 9).
- **Last seen / presence** in the header: online, typing, "last seen today at 6:02 PM", blocked states; `clock="24h"` option.
- Rate-limit toast and `rateLimitedUntil` state; system messages (centred chip); document badges ("PDF . 1.2 MB").
- In-app message banner for other chats, optional message sound, in-app video/audio/document viewers, image viewer with Save/Share.
- Pre-chat `gate` (for example consent) and `composerDisabledReason`.
- Connection banner when the socket is down.
- Tablet split-pane helper (`useResponsiveLayout`).

**Appearance** (`theme`, `chat-ui`)
- Light / Dark / Auto, 7 theme presets, wallpapers (default, solid, gradient, own photo), global or per chat, saved on the device, nothing sent to the peer.
- `ThemeProvider` / `createTheme` overrides, custom `renderIcon`, accessibility labels, 44 pt touch targets, reduced-motion support. English strings only (no i18n prop).

**Moderation** (`moderation`, `chat-ui`)
- Block / unblock (optimistic, rolls back on failure), report with categories (spam, harassment, inappropriate, fake profile, scam, underage, other), "Also block", Blocked users screen, blocked composer states, call button hidden for blocked pairs.

**Notifications** (`notifications`)
- Permission request, Expo push token, Android channels `messages` and `call_ringtone`, `POST /devices` / `DELETE /devices/{id}`, tap routing (also from a cold start), foreground banner suppression for the open chat.

**Calls** (`call`, `call-ui`, `call-native`)
- 1:1 voice calls (WebRTC), TURN credentials via `POST /call/turn-credentials` with public STUN fallback, outgoing/incoming/connecting/active/ended/failed screens, mute, speaker, minimise to a "Return to call" pill, call again, "Message" from the call screen.
- Local call-log entry in chat right after a call; the server's `call_log` replaces it.
- Policy errors (for example credits) through `onCallError(err, retry)`.
- **iOS CallKit + PushKit VoIP**: ring while the app is killed or locked (code written, not run on a device).
- **Android full-screen incoming call** with notifee, answer/decline buttons, foreground service during the call, background task for data-only pushes, decline over REST while killed.

## 8. Shared engine with the web package

`mobile/src/engine/index.ts` (`commskit/engine`) re-exports only modules that import neither `react` nor `react-native` (checked by `__tests__/engineEntry.test.ts`): `CommsClient`, `ChatStore`, `ModerationStore`, wire types, and the pure `chat-ui` / `theme` helpers (formatting, grouping, last-seen, filters, tokens). The web package `commskit-web` (`web/`) aliases this entry, so web and phone format, group and theme identically with no forked logic. Calls are not in the web package (per the root `README.md`).

## 9. What is NOT included

| Not included | Detail |
|---|---|
| A backend | Use `backend/backend-python/` (Python / FastAPI). See `docs/backend/backend-python/` |
| Login / user accounts | You supply the auth token via `CommsConfig.getToken` |
| Web UI | That is `web/` (`commskit-web`) |
| Group chat, video calls UI | 1:1 only; `call_type` exists in the protocol but the UI is voice (verified from README/UI names; video UI not verified) |
| Verified iOS CallKit / PushKit | Code and plugin transforms exist and are unit-tested, but nothing has been compiled or run on iOS (no macOS in the dev environment) |
| i18n | English strings only |
| Expo Go support for calls and native call UI | Needs a development build (WebRTC, CallKit, notifee, VoIP are native modules) |
| Store listings, privacy policy | Your app's responsibility; not covered by this kit |

## 10. Testing status

Run on 2026-10-26 in `mobile/` (PowerShell or bash, same commands):

```
npm run typecheck
npm test
```

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) | Passed, no errors |
| `npm test` (jest + ts-jest) | **24 test suites passed, 325 tests passed, 0 failed**, 0 snapshots, about 15 s |

What the tests cover: socket client, chat store, call engine, call compat, REST helpers, import boundaries, pure UI logic, token parity with `design/tokens.json`, config plugin text/object transforms, and render smoke tests using `react-test-renderer` with a hand-written react-native stand-in (`__tests__/rn-mock/react-native.js`). Native libraries are mocked. `react-native` itself is not installed in `mobile/`, so layout, list virtualisation, keyboard avoidance, gestures, animations and media playback are not covered by these tests.

## 11. Not verified on real devices

From `mobile/README.md` ("What must be verified on real devices"). None of these can run in the unit tests.

- **iOS**: a VoIP push to a killed or locked app shows CallKit; answering from the lock screen connects audio; decline/end reaches the server; the generated Swift `AppDelegate` extension and bridging header compile with your SDK and library versions; the Swift selector names for `RNCallKeep.reportNewIncomingCall` and `RNVoipPushNotificationManager` come from their Objective-C headers and are unconfirmed; the PushKit token reaches `POST /devices` (sandbox vs production APNs).
- **iOS**: the backend `uuid` equals the kit's `callKitUuid` (shared test vectors exist); a CallKit call is not left ringing after the caller cancels while the app is killed (45 s fallback).
- **Android 12 to 15**: the data-only push wakes the background task when killed (OEM battery optimisers may block it); the full-screen intent shows on the lock screen (Android 14 needs `USE_FULL_SCREEN_INTENT` granted; Play policy limits it to calling apps); Answer launches the app and connects; Decline while killed sends `/call/{id}/reject` (stored token must still be valid); the `phoneCall|microphone` foreground service starts without `ForegroundServiceTypeException`.
- **Both**: notification permission prompts, channel importance and sound (channels are immutable once created; reinstall to change), cold-start tap routing, foreground banner suppression for the open chat.
- **Also not tested natively** (from the UI section of the README): native layout, `FlatList` virtualisation, keyboard avoidance, `Modal` presentation, native-driver animations, screen-reader behaviour, swipe gestures and haptics, expo-video/audio playback, real downloads, share sheet and media-library permissions.
- **Library health** (from `examples/expo-app/README.md`): `react-native-callkeep`, `react-native-incall-manager`, `react-native-voip-push-notification` are reported by `expo-doctor` as untested on the New Architecture; `@notifee/react-native` as unmaintained. They run through the interop layer; verify on devices.
