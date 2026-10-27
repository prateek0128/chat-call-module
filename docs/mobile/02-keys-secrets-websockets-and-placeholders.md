# commskit mobile: keys, secrets, WebSockets and placeholders

What the app may hold, every value the mobile side needs, how the socket behaves, and every placeholder you must replace.

Previous: [01 Overview](01-overview.md) · Next: [03 Using, running and deploying](03-using-running-and-deploying.md) · Wire contract: [`../archive/PROTOCOL.md`](../archive/PROTOCOL.md)

## Contents

1. [The rule: no private keys in the app](#1-the-rule-no-private-keys-in-the-app)
2. [Everything the mobile side needs](#2-everything-the-mobile-side-needs)
3. [The config plugin: options, permissions, Info.plist](#3-the-config-plugin-options-permissions-infoplist)
4. [WebSockets from the client side](#4-websockets-from-the-client-side)
5. [Placeholders](#5-placeholders)

Paths are relative to `comms-kit/`. "Verified" means read in the code listed; items marked **(unverified)** were not confirmed from code.

## 1. The rule: no private keys in the app

An app binary can be unpacked by anyone. Anything inside it (JS bundle, `app.json`, `extra`, native resources, `.env` values baked at build time) is public. **Never put a server secret in the mobile app.**

| Private: server only (never in the app, never in git) | Where it lives instead |
|---|---|
| JWT signing secret (`COMMS_DEMO_SECRET` in the demo server) | Backend secret manager / env |
| `TURN_SECRET` (coturn `static-auth-secret`) | Backend env. The app only receives short-lived credentials from `POST /call/turn-credentials` |
| APNs `.p8` key, `APNS_KEY_ID`, `APNS_TEAM_ID` | Backend env (`APNS_*`). The example `.gitignore` already ignores `*.p8`, `*.p12`, `*.key`, `*.pem`, `*.jks`, `*.mobileprovision` |
| Expo access token (`EXPO_ACCESS_TOKEN`) | Backend env (only needed when "enhanced push security" is on in Expo) |
| AWS / S3 keys, database URL, Redis URL | Backend env |
| Apple App Store Connect / Google Play service account keys used for `eas submit` | EAS credentials or your CI secret store, not the repo |

| Legitimate in the app (public or per-user) | Notes |
|---|---|
| The **user's own auth token** (JWT) from your login | Per user, short-lived, revocable. Keep it in secure storage (for example `expo-secure-store`) |
| Server base URL (`https://api.example.com`) | Public by nature |
| Public STUN server (`stun:stun.l.google.com:19302`, the kit's `PUBLIC_STUN`) | Public |
| Short-lived TURN username/password from `/call/turn-credentials` | Expires after `ttl`; cached in memory only |
| EAS project id (`extra.eas.projectId`) | An identifier, not a secret |
| Bundle id (`ios.bundleIdentifier`) / Android `package` | Public identifiers |
| `google-services.json` (Firebase client config) for Android push | Client config, designed to ship in the app. It is not a service-account key |
| Apple team id / entitlements / push capability | Managed by EAS credentials; not in your source |
| Expo push token, VoIP (PushKit) token, device id | Per-device identifiers sent to your backend |

Two things in the kit to be aware of:
- `saveCallSession({ baseUrl, token })` (`mobile/src/call-native/session.ts`) stores the user's token under the key `commskit.callSession` in **AsyncStorage (not encrypted)** so a killed app can decline a call. Pass your own `KeyValueStorage` (for example one wrapping `expo-secure-store`) as the second argument if your threat model needs it. Without `@react-native-async-storage/async-storage` the session is kept in memory only and does not survive a killed app.
- The WebSocket URL contains the token (`/ws/<token>`). See [section 4](#token-in-the-url).

## 2. Everything the mobile side needs

"Required when": **always** / **chat** / **calls** / **push** / **iOS calls** / **Android calls** / **build**.

| Name | Where it goes | Purpose | How to obtain | Example (dummy) | Required when |
|---|---|---|---|---|---|
| `CommsConfig.baseUrl` | `mobile/src/core/config.ts:14`; you build the object passed to `<CommsProvider config>` (example: `examples/expo-app/src/Main.tsx`) | REST base and, when `wsUrl` is omitted, the socket host | Your deployed backend URL | `https://api.example.com` | always |
| `CommsConfig.wsUrl` | `config.ts:16` (optional) | WebSocket base if it differs from the REST host | Your reverse proxy / ingress config | `wss://ws.example.com` | only if different from `baseUrl` |
| `CommsConfig.getToken` | `config.ts:18` | Returns the current auth token. Called on **every** (re)connect and **every** REST call. Return `null` when logged out | Your login flow | `() => SecureStore.getItemAsync("token")` | always |
| `CommsConfig.getUserId` | `config.ts:20` | Current user id (string). Called on every connect | Your login flow | `() => "U1"` | always |
| `CommsConfig.logger` | `config.ts` (optional) | `{debug, info, warn, error}`; default is silent | `consoleLogger("[comms]")` | the example enables it only when `__DEV__` | optional |
| User auth token | Your own storage; returned by `getToken` | Authenticates the socket (`/ws/<token>`) and REST (`Authorization: Bearer <token>`) | The **host** app's login (the kit has no login) | a JWT | always |
| Token refresh | In your `getToken` | The kit does **not** refresh tokens and does **not** treat close code 1008 or HTTP 401 specially (verified: no handling in `CommsClient.ts` / `authFetch`). On an expired token the socket keeps reconnecting with backoff, calling `getToken()` each time | You: refresh inside `getToken` before returning, or call `client.reconnect()` after refreshing. Also call `saveCallSession` again after a refresh | n/a | always (host responsibility) |
| Expo push token | Produced by `registerDevice` (`mobile/src/notifications/register.ts`), sent in `POST /devices` as `expo_push_token` | Lets the backend push chat messages and (Android) calls | Automatic: `expo-notifications` `getExpoPushTokenAsync` after permission is granted. Needs a physical device | `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]` | push |
| EAS `projectId` | `app.json` `expo.extra.eas.projectId` (written by `eas init`); read in the example at `examples/expo-app/src/push.ts:22`; or pass `registerDevice({ projectId })` | Needed by Expo to issue a push token for your app | `eas init` (needs an Expo account) | `00000000-0000-0000-0000-000000000000` | push |
| `deviceId` | `registerDevice({ deviceId })` | Stable upsert key on the backend. Default: derived from the push token (changes when the token rotates) | Example uses `expo-application` (`getAndroidId()` / `getIosIdForVendorAsync()`), `examples/expo-app/src/push.ts` | `a1b2c3d4e5f6` | push (recommended) |
| FCM `google-services.json` | File in the app project, referenced by `android.googleServicesFile` in `app.json` **(host responsibility; not mentioned by the kit README or the example, which has none, so Android remote push in a release build is unverified here)** | Android push delivery through Firebase Cloud Messaging via Expo | Firebase console, add the Android app with your `package` name | `./google-services.json` | Android push |
| FCM v1 service account key (private) | Uploaded to EAS / Expo credentials, **not** the app | Lets Expo send Android pushes | Firebase console, service accounts; `eas credentials` **(unverified: follow Expo docs)** | n/a | Android push |
| APNs key for Expo push (iOS) | Uploaded to EAS credentials, **not** the app | iOS push for chat messages via Expo | Apple Developer portal; EAS can create/manage it **(host responsibility; unverified here)** | n/a | iOS push |
| VoIP push token | Produced by `registerVoipPush` (`mobile/src/call-native/voip.ts`) using `react-native-voip-push-notification`; sent in `POST /devices` as `voip_token` via `registerDevice({ getVoipToken })` | Lets the backend ring CallKit when the app is killed | Automatic on a **physical iPhone** with the plugin applied (no VoIP push in the simulator) | 64 hex chars | iOS calls |
| Backend `APNS_*` link | Backend env: `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` (from `examples/expo-app/README.md`) | The backend sends the VoIP push to topic `<bundle id>.voip` (PROTOCOL section 8). `APNS_BUNDLE_ID` must equal `ios.bundleIdentifier`. `APNS_USE_SANDBOX=1` for dev builds, production for TestFlight/App Store | Apple Developer portal: create an APNs key (.p8) | `com.example.commskitdemo` | iOS calls |
| `iceServers` | `<CallProvider iceServers>` (`mobile/src/call/CallProvider.tsx:73`) | STUN/TURN for WebRTC. Default if omitted: public STUN only | See next two rows | `turnCredentialsIceServers(config)` | calls |
| `turnCredentialsIceServers(config, { fallback, stun, path })` | `mobile/src/call/iceServers.ts` | Calls `POST /call/turn-credentials` (default path), caches until `ttl - 60 s`, returns `[...stun, TURN]`; on failure returns `fallback` (default public STUN) | The backend generates it from its `TURN_SECRET` + `TURN_URIS` (coturn REST scheme, `{username, password, ttl, uris}`) | `{ username, password, ttl: 3600, uris: ["turn:turn.example.com:3478?transport=udp"] }` | calls, and always over mobile data |
| TURN server itself | Backend side: `TURN_SECRET`, `TURN_URIS` env (demo server `examples/backend/demo-server-python/demo_server.py`) | Relay when peers cannot connect directly (STUN alone often fails phone on mobile data to phone on Wi-Fi) | Run coturn with `use-auth-secret` | `turn:turn.example.com:3478?transport=udp` | production calls |
| Notifee / CallKeep names | `createPlatformCallNotifier({ ios: { appName }, android: { texts, channelId, smallIcon } })` (`mobile/src/call-native/hooks.ts`, `callkit.ts`, `android.ts`) | `appName` is shown by CallKit ("<appName> Audio"). Android texts default to "Incoming voice call", "Answer", "Decline", "Hang up", "Ongoing call"; ringing channel defaults to `call_ringtone`, ongoing channel `call_ongoing`; ring timeout 45 s | You choose | `ios: { appName: "My App" }` (**`appName` is required**) | calls (native UI) |
| `app.json` `plugins: ["commskit"]` | `app.json` `expo.plugins` | Applies the native config for calls. Options in [section 3](#3-the-config-plugin-options-permissions-infoplist) | You write it | `["commskit", { "microphonePermission": "..." }]` | calls |
| Bundle id / package | `app.json` `ios.bundleIdentifier`, `android.package` | App identity; must match `APNS_BUNDLE_ID`, Firebase app, store listing | You choose; the example uses `com.example.commskitdemo` (placeholder) | `com.yourcompany.yourapp` | build |
| `eas.json` | `examples/expo-app/eas.json` | EAS build profiles `development`, `development-simulator`, `preview` (no `production` profile in the example) | `eas build:configure` | see [03 section 5](03-using-running-and-deploying.md#5-building-and-releasing) | build |
| `extra.apiUrl` | `examples/expo-app/app.json:86` | **Example only**: default server URL on its login screen | You edit it | `http://192.168.1.23:8000` | example app only |
| Cleartext HTTP/WS allowance | Android: `expo-build-properties` `android.usesCleartextTraffic: true`; iOS: `ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads: true` (example `app.json:21,61`) | Lets `http://` / `ws://` work for a LAN dev server | Only for local development. Remove for production | n/a | local dev over http |
| Maestro `SERVER_URL` | `maestro test -e SERVER_URL=...` (`examples/expo-app/.maestro/subflows/login.yaml`) | Server URL as the device sees it; default `http://10.0.2.2:8000` | You pass it | `http://192.168.1.23:8000` | E2E only |

## 3. The config plugin: options, permissions, Info.plist

Source: `mobile/plugin/withCommskit.js`, entry `mobile/app.plugin.js`. Add to `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["commskit", { "microphonePermission": "Allow $(PRODUCT_NAME) to use the microphone for voice calls." }]
    ]
  }
}
```

| Option | Default | Effect |
|---|---|---|
| `microphonePermission` | `"Allow $(PRODUCT_NAME) to use the microphone for voice calls."` (placeholder wording, `DEFAULT_MIC_TEXT`, line 33) | Sets `NSMicrophoneUsageDescription`. If you do not pass it and the plist already has one, the existing one is kept |
| `voip` | `true` | `false`: no `voip` background mode, no AppDelegate / bridging-header patch (use for apps without iOS CallKit) |
| `callKeepService` | `true` | `false`: do not declare CallKeep's Android `VoiceConnectionService` and `RNCallKeepBackgroundMessagingService` |
| `notifeeForegroundService` | `true` | `false`: do not declare notifee's `ForegroundService` |
| `androidPermissions` | `[]` | Extra Android permissions appended to the list below |

**Android permissions added** (`ANDROID_PERMISSIONS`): `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL`, `FOREGROUND_SERVICE_MICROPHONE`, `MANAGE_OWN_CALLS`, `VIBRATE`, `WAKE_LOCK`.

**Android services added**: CallKeep `io.wazo.callkeep.VoiceConnectionService` (permission `BIND_TELECOM_CONNECTION_SERVICE`, `foregroundServiceType="phoneCall|microphone"`) and `io.wazo.callkeep.RNCallKeepBackgroundMessagingService`; notifee `app.notifee.core.ForegroundService` with `foregroundServiceType="phoneCall|microphone"` and `tools:replace`.

**iOS Info.plist**: `UIBackgroundModes` gets `audio`, `voip`, `remote-notification` (without `voip` when `voip: false`), plus `NSMicrophoneUsageDescription`.

**iOS AppDelegate (Swift, Expo SDK 53+ only)**: adds `import PushKit`, calls `RNVoipPushNotificationManager.voipRegistration()` before `return super.application(...)`, adds a `PKPushRegistryDelegate` extension that reports every VoIP push to CallKit synchronously (iOS 13+ requirement), and adds `RNCallKeep.h` / `RNVoipPushNotificationManager.h` imports to the `*-Bridging-Header.h`. An Objective-C AppDelegate makes the plugin throw (add the code by hand or pass `voip: false`). **Not compiled on iOS in this repo.**

**Not set by the kit plugin** (host responsibilities; the example does them in `app.json`):
- `NSPhotoLibraryUsageDescription` and camera strings (`expo-image-picker` / `expo-media-library` plugins).
- Cleartext/ATS exceptions for local dev.
- A WebRTC config plugin: the example adds `@config-plugins/react-native-webrtc`. The kit README does not mention it; whether it is strictly required for `@stream-io/react-native-webrtc` **(unverified)**.
- The notifee Maven repo: the example adds `extraMavenRepos: ["../node_modules/@notifee/react-native/android/libs"]` via `expo-build-properties`. The plugin comment says notifee 7+ resolves it through autolinking and older setups need the `maven { url ... }` line.

## 4. WebSockets from the client side

Source: `mobile/src/core/CommsClient.ts`, `config.ts`, `CommsProvider.tsx`. Contract: [`../archive/PROTOCOL.md`](../archive/PROTOCOL.md) section 1.

### URL

| Item | Value |
|---|---|
| Shape | `${wsUrl}/ws/${encodeURIComponent(token)}` (`socketUrl`, `config.ts:54`) |
| `wsUrl` default | Derived from `baseUrl` by `deriveWsUrl`: `https://x` becomes `wss://x`; `http://x` becomes `ws://x`; a `ws(s)://` value is kept; any other scheme throws. Trailing slashes are trimmed |
| Production | Use `https://` / `wss://` |
| Invalid token | Server closes with code **1008** (PROTOCOL). The kit exposes it as `useConnectionStatus().lastCloseCode` but then reconnects like for any close |

### Cleartext (ws://) for local development

| Platform | What blocks it | What to set (example `app.json`) |
|---|---|---|
| iOS | App Transport Security blocks `http://` and `ws://` to non-localhost hosts | `ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads: true` (dev only; this blanket exemption can cause App Review questions, remove it in production builds) |
| Android 9+ | Cleartext traffic is off by default | `expo-build-properties` `android.usesCleartextTraffic: true` (dev only) |

The example enables both because its default server is `http://192.168.x.x:8000`. Remove them when you use `https`/`wss`.

### Token in the URL

The token is in the URL path because the protocol (and Smart Matrimony) uses it. Consequences:
- Reverse proxies and load balancers may log it. Redact `/ws/<JWT>` in access logs and use short JWT lifetimes with refresh.
- Do not log the socket URL in the app. The kit's logger logs close codes and attempt counts, not the URL (verified in `CommsClient.ts`).

### Connection behaviour

| Behaviour | Value / rule | Where |
|---|---|---|
| Reconnect backoff | `min(1000 * 2^n, 30000)` ms, n = attempt (1 s, 2 s, 4 s ... 30 s). Cap configurable with `maxReconnectDelayMs`. Attempt resets to 0 on open | `backoffDelay`, `CommsClient.ts:86` |
| Background | No reconnect timer runs while the app is not `active`; on return to `active` it reconnects at once (attempt reset) if the socket died | `onAppState` |
| Presence | On `active` (after not being active) sends `{type:"user_status", status:"online"}`; on background/inactive sends `status:"away"` if the socket is open | `onAppState`, PROTOCOL section 2 |
| Ping | Off by default. `pingIntervalMs` (prop of `CommsProvider`) sends `{type:"ping"}`; the server replies `PONG` (upper case), which the client lower-cases to `pong` | `CommsClient.ts` |
| Offline send policy | `"drop"` (default: `send` returns `false`), `"queue"` (keeps up to `maxQueue`, default 100, drops the oldest, flushes in order on open), or a per-frame function | `offlineSendPolicy` prop |
| Status values | `idle`, `connecting`, `open`, `reconnecting`, `unauthenticated` (no token), plus `attempt` and `lastCloseCode` | `useConnectionStatus()` |
| No token | `getToken()` returns nothing: status `unauthenticated`, no reconnect. After login call `client.connect()` or `client.reconnect()` | `openSocket` |
| Chat banner | The chat UI shows a connection banner after 3 failed attempts (`OFFLINE_AFTER_ATTEMPTS`) | `chat-ui/connection.ts` |
| Unmount | `CommsProvider` calls `client.connect()` on mount (`autoConnect`, default true) and `client.disconnect()` on unmount. Call `disconnect()` on logout | `CommsProvider.tsx` |
| Call timeouts | ICE gather 3 s, offer wait 10 s, `call_initiate` with no reply 15 s | `VoiceCallEngine.ts:34-37` |

### One socket per app

Mount **one** `<CommsProvider>` at the root. `ChatProvider`, `CallProvider` and `ModerationProvider` all share its socket (the old Smart Matrimony app opened three). The example remounts the whole tree with a `key` per `baseUrl|userId|mode` so a new login gets a fresh socket (`examples/expo-app/App.tsx`). A user may have several sockets (several devices); the server sends events to all of them.

### Frames the client sends (verified from `client.send(...)` calls in `src/`)

`user_status`, `ping`, `req_users`, `get_messages`, `send_message`, `mark_read`, `typing`, `media_upload`, `delete_message`, `clear_chat`, `call_initiate`, `answer_call`, `reject_call`, `end_call`, `sdp_offer`, `sdp_answer`, `ice_candidate`. (`start_recording` exists in the type map but no sender was found in `src/`.) Payloads: `mobile/src/core/types.ts` (`ClientEventMap`) and PROTOCOL sections 2 to 4, 9.

### Frames the client handles (`ServerEventMap`)

`user_status`, `pong`, `error`, `res_users`, `req_users_error`, `res_messages`, `new_message`, `message_sent`, `media_upload_success`, `chat_read`, `messages_read`, `delivery_status`, `typing_status`, `call_initiated`, `incoming_call`, `call_ringing`, `call_answered`, `call_rejected`, `call_ended`, `call_missed`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `call_log`, plus (PROTOCOL sections 7 and 9) `user_blocked`, `blocked_by_user`, `user_unblocked`, `unblocked_by_user`, `message_deleted`, `chat_cleared`, and `error` with `code` `rate_limited` / `too_long` / `not_allowed` / `not_found` / `window_expired`. Unknown frame types are ignored. Subscribe to your own frames with `useComms().client.on("my_type", handler)`.

### REST endpoints the client calls (all `Authorization: Bearer <token>` via `authFetch`)

| Call | Source | Purpose |
|---|---|---|
| `POST /chats/start?candidate_id=<id>` | `chat/api.ts` (`startChat`) | Get or create a 1:1 chat |
| `POST /chats/expo/push/token`, `POST /chats/expo/push/token/remove` | `chat/api.ts` | Legacy push registration (host push adapter) |
| `POST /devices`, `DELETE /devices/{device_id}` | `notifications/register.ts` | Register / unregister this device (body in `DeviceRegistration`: `device_id`, `platform`, `expo_push_token?`, `voip_token?`, `app_version?`, `os_version?`, `model?`) |
| `POST /moderation/blocks` (`{user_id}`), `DELETE /moderation/blocks/{id}`, `GET /moderation/blocks`, `POST /moderation/reports` | `moderation/ModerationStore.ts` | Block, unblock, list, report |
| `POST /call/turn-credentials` | `call/iceServers.ts` | TURN credentials |
| `POST /call/{call_id}/reject` | `call/CallProvider.tsx`, `call-native/session.ts` | Decline a call the app has not received over the socket (notification button, killed app) |

Chat history, sending and read receipts go over the **socket**, not REST. The chat REST helpers `GET /chats/...` listed in PROTOCOL section 5 are not called by the kit (only `startChat` and the legacy push-token calls).

## 5. Placeholders

A "placeholder" here is a default or example value you must replace, or a slot the host must fill. Nothing below is a secret.

### Values in the example app and docs

| Placeholder | Lives in | What the default does | Why it is a placeholder | What to put there |
|---|---|---|---|---|
| `http://192.168.1.10:8000` | `examples/expo-app/app.json:86` (`extra.apiUrl`), `src/session.ts` (fallback), `LoginScreen.tsx` (input hint) | Default server on the demo login screen | Your PC's LAN IP is different; it is editable on the login screen and saved on the device | Your PC's LAN IP, for example `http://192.168.1.23:8000`; for a real app, your `https://` API (and do not use `extra.apiUrl` at all, see section 2) |
| `com.example.commskitdemo` | `examples/expo-app/app.json:18,27`, `.maestro/*.yaml` (`appId`) | Bundle id and Android package of the demo | `com.example.*` is not a registered id; stores and Apple/Google need your own. `APNS_BUNDLE_ID` and Maestro `appId` must match | `com.yourcompany.yourapp` everywhere (app.json, backend `APNS_BUNDLE_ID`, Firebase app, Maestro) |
| EAS project id missing | `app.json` has no `extra.eas.projectId`; `examples/expo-app/src/push.ts:22` reads it | Without it `registerDevice` cannot get an Expo push token on a real build | Created per Expo account | Run `eas init` once |
| Demo token endpoints `/dev/users`, `/dev/token/{id}` | Demo server; called by `examples/expo-app/src/session.ts` (`fetchDemoUsers`, `fetchDemoToken`) | Hands out a token to anyone | Demo convenience only | Replace with your real login. Never deploy these endpoints |
| `Commskit Demo` app name | `examples/expo-app/src/calls.ts` (`ios.appName`) and `app.json` `name` | Shown by CallKit ("Commskit Demo Audio") | Branding | Your app name |
| `"Answer"` / `"Decline"` texts | `examples/expo-app/src/calls.ts` | Android notification button labels | Kit defaults already exist in English | Your localised text via `android.texts` |
| `#4F46E5` notification colour | `examples/expo-app/app.json` (`expo-notifications` plugin) | Android notification accent | Branding | Your colour |
| `com.example.app` | `mobile/README.md` plugin snippet | Illustration of `ios.bundleIdentifier` | Example text | Your bundle id |
| `https://api.example.com`, `wss://ws.example.com` | `mobile/README.md`, this doc | Illustrations of `baseUrl` / `wsUrl` | Example text | Your URLs |
| Plugin default microphone string | `mobile/plugin/withCommskit.js:33` | `"Allow $(PRODUCT_NAME) to use the microphone for voice calls."` is written to `NSMicrophoneUsageDescription` when you pass none | Apple reviews this wording | Pass `microphonePermission` with wording that fits your app |
| Photo / save-photo permission strings | `examples/expo-app/app.json` (`expo-image-picker`, `expo-media-library`, `NSPhotoLibraryUsageDescription`) | "Choose photos to send in chats and to use as a chat wallpaper." | Wording for the demo | Your wording |
| Maestro `10.0.2.2:8000` | `.maestro/subflows/login.yaml` | Android emulator's alias for the host PC | Only right for an emulator | `-e SERVER_URL=http://<LAN IP>:8000` for a real device |
| `ringback` off | `createInCallManagerAudio` | No ringback tone | Matches Smart Matrimony today | `ringback: "_DTMF_"` to enable |

### Slots the host must supply (props the kit does not fill for you)

| Slot | Component | Default | What to supply |
|---|---|---|---|
| `getToken`, `getUserId` | `CommsConfig` | none (required) | Your auth |
| `pickAttachment` | `ChatScreen` | no attach button | `() => Promise<{uri, name, type, size} \| null>` (example `src/pickers.ts`) |
| `pickers` | `ChatScreen` | none | `AttachPicker[]`; `createExpoPickers()` builds gallery/camera/video/record/document on `expo-image-picker` and `expo-document-picker` |
| `pickWallpaperImage` | `ConversationListScreen`, `ChatScreen`, `AppearanceSheet` (`pickImage`) | no "Choose image..." tile | `({maxEdge}) => Promise<{uri, width, height} \| null>`; must downscale to `maxEdge` (1600) and copy to **persistent** storage, because the kit stores only the uri |
| `documentViewerUrl` | `ChatScreen` | the file URL itself | Optional `(fileUrl) => viewerUrl`. A Google `gview` URL sends the file URL to a third party, so it is opt-in (privacy) |
| `gate` | `ChatScreen` | none | `(info) => ReactNode \| null`, for example a consent card. Pair with `composerDisabledReason` |
| `messageActions` | `ChatScreen` | built-in items only | `MessageAction[]` or `(message) => MessageAction[]` for your extra long-press items |
| `soundSource` / `soundMuted` | `InAppMessageBanner`, `useMessageSound` | `null` = **silent** (verified in `chat-ui/messageSound.ts`) | A sound file (`require(...)` or uri) and your mute setting |
| `renderGradient` | `ChatScreen`, `ConversationListScreen`, `ChatWallpaper` | `expo-linear-gradient` if installed, else first colour as solid | Your gradient renderer |
| `renderBackground` | `CallOverlay`, `CallScreen` | banded Views | A gradient view (example uses `LinearGradient`) |
| `renderIcon` | `ThemeProvider` / `AppearanceProvider` | built-in text glyphs | Icon set mapping (example `src/icons.tsx` uses `MaterialCommunityIcons`) |
| `unsendWindowSeconds` | `ChatScreen` | `3600` (`DEFAULT_UNSEND_WINDOW_SECONDS`) | Must **match the server** `ChatConfig.unsend_window_seconds` (`0` = no limit, `-1` = off). The client only decides whether to show "Delete for everyone"; the server enforces and replies `window_expired` |
| `readFileAsBase64` | `ChatProvider` | `expo-file-system/legacy` reader | Your reader if you do not use Expo |
| `fileActions` | `ChatScreen` | `createDefaultFileActions` (expo peers) | Your downloader/sharer |
| `iceServers` | `CallProvider` | public STUN only | `turnCredentialsIceServers(config)` |
| `notifier` | `CallProvider` | no-op | `createPlatformCallNotifier({...})` |
| `onCallError` | `CallProvider` | none | Credit/paywall prompt and busy/mic messages |
| `onOpenChat` | `CallProvider` | none | Navigate to your chat route |
| `storage` | `AppearanceProvider` | async-storage if installed, else memory | `AsyncStorage` or your own |
| `deviceId`, `appVersion`, `projectId` | `registerDevice` | derived / inferred | See section 2 |
| `insets` | screens | from `SafeAreaProvider` | Pass only if you do not use it |
| i18n | all screens | English only | Not supported yet |
