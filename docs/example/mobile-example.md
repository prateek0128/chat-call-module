# Mobile example app (`examples/expo-app`)

A runnable Expo app that uses every part of the mobile kit against the demo backend.

Related: [01 Overview](../mobile/01-overview.md) · [02 Keys, secrets, WebSockets, placeholders](../mobile/02-keys-secrets-websockets-and-placeholders.md) · [03 Using, running, deploying](../mobile/03-using-running-and-deploying.md) · The example's own [README](../../examples/expo-app/README.md)

## Contents

1. [What it is and who it is for](#1-what-it-is-and-who-it-is-for)
2. [File-by-file map](#2-file-by-file-map)
3. [Login flow and modes](#3-login-flow-and-modes)
4. [How it links the kit](#4-how-it-links-the-kit)
5. [Run it step by step](#5-run-it-step-by-step)
6. [Maestro E2E flows](#6-maestro-e2e-flows)
7. [Known limitations](#7-known-limitations)
8. [What to copy into your own app](#8-what-to-copy-into-your-own-app)

Paths are relative to `comms-kit/examples/expo-app/` unless they start with `comms-kit/`. Everything below was read from the files named.

## 1. What it is and who it is for

| Item | Value |
|---|---|
| App name / slug | `Commskit Demo` / `commskit-demo` (`app.json`, scheme `commskitdemo`) |
| Stack | Expo SDK `~54.0.36`, React Native `0.81.5`, React `19.1.0`, New Architecture on, React Navigation 7 |
| Kit dependency | `"commskit": "file:../../mobile"` (symlink to `comms-kit/mobile`) |
| Talks to | The demo backend `comms-kit/examples/backend/demo-server-python/demo_server.py` |
| Why it exists | Shows the complete provider tree, every kit entry point, the native call setup, the Metro config for a linked kit, and gives E2E flows. It doubles as a manual test bench for chat, calls, push, moderation and appearance |
| Who it is for | Mobile developers integrating the kit (copy the wiring), a tech lead evaluating it (run it on two phones), QA (Maestro flows and the device checklist) |
| Not for | Production. The login uses a demo token endpoint that hands a token to anyone |

Expo Go is **not** supported: WebRTC, CallKit, notifee and VoIP push are native modules, so you need a development build (`expo-dev-client` is installed).

## 2. File-by-file map

| File | What it does | Kit APIs shown |
|---|---|---|
| `index.ts` | Entry. On Android, calls `registerBackgroundCallHandler()` at module scope (in a try/catch) **before** `registerRootComponent(App)`, so a killed app can show the full-screen call notification for a data-only push | `commskit/call-native`: `registerBackgroundCallHandler` |
| `App.tsx` | Root: `GestureHandlerRootView` > `SafeAreaProvider` > `AppearanceProvider` (AsyncStorage persistence, `renderIcon`, storage-error alert) > login screen or `Main`. Loads and saves the session; `key` on `Main` (`baseUrl|userId|mode`) gives each user/server/mode a fresh socket | `commskit/theme`: `AppearanceProvider` |
| `src/Main.tsx` | Signed-in app. Builds `CommsConfig`, ICE servers, runs push setup, builds the provider tree per mode, `NativeCallBridge`, themed `CallOverlay`, `NotificationRouter`, navigation | `CommsProvider`, `ModerationProvider`, `ChatProvider`, `CallProvider`, `turnCredentialsIceServers` + `PUBLIC_STUN`, `CallOverlay`, `useNativeCallNotifier`, `useNotificationRouting`, `useTheme` |
| `src/session.ts` | Demo login state (`Session`: `baseUrl`, `userId`, `userName`, `token`, `mode`, `features`, `users`), persisted in AsyncStorage (`demo.session`, `demo.serverUrl`). `DEFAULT_API_URL` from `app.json` `extra.apiUrl`. Fetches `GET /dev/users` and `GET /dev/token/{id}` | none (host code; this is where **your** auth goes) |
| `src/push.ts` | `setUpPush`: stable device id (`expo-application`), EAS `projectId` from `Constants`, `saveCallSession`, iOS `registerVoipPush`, `registerDevice`. `tearDownPush`: stop VoIP, `clearCallSession`, `unregisterDevice` | `commskit/notifications`: `registerDevice`, `unregisterDevice`; `commskit/call-native`: `registerVoipPush`, `saveCallSession`, `clearCallSession`, `CallKitNotifier` |
| `src/calls.ts` | Creates the platform call notifier once (iOS CallKit appName `Commskit Demo`, Android button texts) | `createPlatformCallNotifier` |
| `src/pickers.ts` | `pickAttachment` (one photo) and `pickWallpaperImage` (downscale to `maxEdge`, copy to `documentDirectory`) with `expo-image-picker`, `expo-image-manipulator`, `expo-file-system/legacy` | `ChatScreen pickAttachment`, `pickWallpaperImage` slots |
| `src/icons.tsx` | `renderIcon` mapping every kit `IconName` to `MaterialCommunityIcons` | `IconRenderer` |
| `src/screens/LoginScreen.tsx` | Server URL field + Load, mode picker (Chat / Calls / Both, limited by server features), "Sign in as" demo users. Has `testID`s used by Maestro (`login-server-url`, `login-connect`, `login-mode-*`, `login-user-*`, `login-error`) | `Avatar`, `useTheme` |
| `src/screens/InboxScreen.tsx` | The chat list with Appearance action and a Settings header button | `ConversationListScreen` (`showAppearanceAction`, `pickWallpaperImage`, `renderHeaderActions`, `me`, empty texts) |
| `src/screens/ChatRoute.tsx` | One conversation. With calls on, bridges chat to call (`onCall` -> `startCall`) | `ChatScreen` (`pickAttachment`, `appearanceMenu`, `pickWallpaperImage`, `moderationMenu`, `onCall`), `useCall` |
| `src/screens/PeopleScreen.tsx` | Calls-only mode: list of demo users with a call button (disabled for blocked pairs) | `useCall().startCall`, `useOptionalBlocking().isBlockedPair` |
| `src/screens/SettingsScreen.tsx` | Account info, connection status, push status, Appearance sheet, Blocked users, standalone Report sheet, Log out (`DELETE /devices` first, then `client.disconnect()`) | `useComms`, `useConnectionStatus`, `useBlocking`, `AppearanceSheet`, `ReportSheet`, `useAppearance` |
| `src/screens/BlockedScreen.tsx` | Settings > Blocked users | `BlockedUsersScreen` |
| `src/screens/HeaderButton.tsx` | A 44 pt header icon button for the example's own screens | `useTheme` |
| `metro.config.js` | Config for the symlinked kit: `watchFolders`, `nodeModulesPaths`, `blockList` for the kit's own `node_modules`, package exports, `allowOptionalDependencies`, empty-module fallback for missing optional peers | n/a ([03 Metro config](../mobile/03-using-running-and-deploying.md#metro-config)) |
| `app.json` | Bundle id / package `com.example.commskitdemo`, the `commskit` plugin with `microphonePermission`, other plugins (`@config-plugins/react-native-webrtc`, `expo-notifications`, `expo-image-picker`, `expo-build-properties` with cleartext + notifee Maven repo, `expo-audio`, `expo-media-library`, `expo-dev-client`), iOS ATS exemption, `extra.apiUrl` | config plugin |
| `eas.json` | EAS profiles `development`, `development-simulator`, `preview`; `appVersionSource: remote` | n/a |
| `tsconfig.json` | Extends `expo/tsconfig.base`, strict; maps `react`, `react-native` to the app's copies for `tsc` only | n/a |
| `.maestro/` | `config.yaml`, 4 flows, 2 subflows (section 6) | n/a |
| `assets/` | Icon, adaptive icon, splash, favicon | n/a |
| `.gitignore` | Also ignores `*.p8`, `*.p12`, `*.key`, `*.pem`, `*.jks`, `*.mobileprovision`, `.env*.local`, `/ios`, `/android` | n/a |

Provider tree in `src/Main.tsx`: `CommsProvider` > `ModerationProvider` > `ChatProvider` (not in Calls mode) > `CallProvider` (not in Chat mode; with the CallKit/notifee notifier, TURN ICE servers, `onOpenChat`, `onCallError`) > navigation + `CallOverlay`. A policy error from `onCallError` shows an alert with "Call anyway" that calls `retry()`.

## 3. Login flow and modes

1. App starts: `loadSession()` reads the saved session from AsyncStorage. If present, `Main` mounts directly.
2. Otherwise `LoginScreen` loads the saved server URL (or `extra.apiUrl`, default `http://192.168.1.10:8000`), calls `GET <server>/dev/users` (timeout 8 s) and shows the demo users and which features the server runs.
3. Choose a mode. The server's `COMMS_FEATURES` limits it (a chat-only server disables Calls and Both):

| Mode | Providers mounted | First screen |
|---|---|---|
| Chat | `ChatProvider` only (no `CallProvider`, native call libs never touched) | Inbox |
| Calls | `CallProvider` only | People (users with call buttons) |
| Both | Both | Inbox, call button in each chat |

4. Tap Alice (U1), Bob (U2) or Carol (U3). `GET <server>/dev/token/{id}` returns a token; the session is saved.
5. `Main` mounts: socket connects, `setUpPush` registers the device, `NotificationRouter` handles taps.
6. Logout (Settings): `tearDownPush` (stop VoIP, `clearCallSession`, `DELETE /devices/{id}` **before** the token is dropped), then `client.disconnect()`; the session is cleared and the login screen shows.

In your app the demo endpoints are replaced by your own login (see [02 section 1](../mobile/02-keys-secrets-websockets-and-placeholders.md#1-the-rule-no-private-keys-in-the-app)).

## 4. How it links the kit

- `package.json`: `"commskit": "file:../../mobile"` so `npm install` creates a symlink `node_modules/commskit` to the kit source.
- `metro.config.js`: watches `../../mobile`, resolves from this app's `node_modules`, hides `../../mobile/node_modules` (one React only), enables package exports and `allowOptionalDependencies`, and maps `expo-av` (not installed; deprecated in SDK 54, `expo-audio` is used) to an empty module.
- `tsconfig.json` `paths` fix duplicate types for `tsc`; `app.json` `experiments.tsconfigPaths: false` keeps Metro from using them.
- Edits in `comms-kit/mobile/src` hot-reload in the running app.

## 5. Run it step by step

Short version. Full details: the example [README](../../examples/expo-app/README.md) and [03 section 4](../mobile/03-using-running-and-deploying.md#4-running-locally).

**1. Backend on your LAN** (from the `comms-kit/` folder; it uses the backend's `.venv`, see `backend/backend-python/README.md`):

```bash
# from the comms-kit folder
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

```powershell
# from the comms-kit folder
.\backend\backend-python\.venv\Scripts\python.exe -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

Find your PC IP (`ipconfig` on Windows, `ipconfig getifaddr en0` on macOS) and open `http://<PC-IP>:8000/dev/users` in the phone's browser. Allow port 8000 in the firewall if it fails.

**2. Install and build a dev client:**

```bash
cd examples/expo-app
npm install
eas init                                              # once; writes extra.eas.projectId (needed for push tokens)
eas build --profile development --platform android    # install the APK from the link / QR
```

```powershell
cd examples\expo-app
npm install
eas init
eas build --profile development --platform android
```

iOS: `eas device:create`, then `eas build --profile development --platform ios` (needs a paid Apple Developer account). Local builds: `npx expo run:android` / `npx expo run:ios` (Android Studio / Xcode). EAS uploads the whole git repo because of `file:../../mobile`, so build from a checkout of this repo.

**3. Start Metro and open the app:**

```bash
npx expo start --dev-client
```

**4. Sign in:** the server URL field defaults to `app.json` `extra.apiUrl` (`http://192.168.1.10:8000`, a placeholder). Replace it with `http://<PC-IP>:8000` (emulator: `http://10.0.2.2:8000`), tap **Load**, pick a mode, and sign in as Alice on phone A and Bob on phone B (or Bob in the browser demo at `http://<PC-IP>:8000/#U2`).

**5. Try:** chat with a photo and read ticks; a call (Mute, Speaker, minimise to the "Return to call" pill, Hang up, then "Call back" in the chat); the Appearance sheet and per-chat wallpaper; Block / Report; background phone B and send a message (push); kill the app on Android and call (full-screen call notification; Android 14+ needs full-screen notification permission, some OEMs need battery optimisation off); iOS killed-app calls need the backend `APNS_*` variables ([03 section 5](../mobile/03-using-running-and-deploying.md#credentials)).

**Calls over mobile data** need TURN on the server (`TURN_SECRET`, `TURN_URIS`); the example README has the commands. The `preview` profile builds a standalone APK (no Metro) for E2E or a second tester.

## 6. Maestro E2E flows

Maestro is **not installed** in the environment where this documentation was written, so the flows were only validated as YAML, never run. Treat them as unverified until you run them.

| File | What it does |
|---|---|
| `.maestro/config.yaml` | `flows: ["*.yaml"]` (runs every flow in the folder; `subflows/` only via `runFlow`) |
| `.maestro/login_and_chat.yaml` | Sign in as Alice (mode both), open Bob, send "Hello from Maestro", see it, back, check the list row |
| `.maestro/appearance.yaml` | Dark mode, Rose theme, Gradient 1 wallpaper, then per-chat wallpaper and reset, then restore defaults |
| `.maestro/report_block.yaml` | Block / unblock Bob from the chat menu, Report (also blocks), Settings > Blocked users > Unblock |
| `.maestro/call_ui.yaml` | Call Bob, handle the microphone prompt, see "Calling..." or "Ringing...", Hang up |
| `.maestro/subflows/login.yaml` | Launch, log out if already signed in, enter `SERVER_URL` (default `http://10.0.2.2:8000`), Load, sign in as `USER_ID` (default `U1`) with `MODE` (default `both`) |
| `.maestro/subflows/open_bob.yaml` | From the list, open the row starting with "Bob" |

All use `appId: com.example.commskitdemo`, the kit's accessibility labels ("Send message", "More options", "Call Bob", "Hang up") and the example's `testID`s.

Run:

1. Install Maestro (Windows: via WSL or the Maestro Studio app, per the example README).
2. Start the demo server (step 1 above). Start an Android emulator or connect a USB device with the app installed (best: the `preview` build; with a dev build, open the project in the dev client once first).
3. From `examples/expo-app`:

```bash
maestro test .maestro                                          # Android emulator: http://10.0.2.2:8000
maestro test -e SERVER_URL=http://192.168.1.23:8000 .maestro   # a real device on your Wi-Fi
```

`npm run e2e` is the same as `maestro test .maestro`. The flows need Bob in the conversation list (the demo server lists every demo user). `call_ui.yaml` needs nobody to answer.

## 7. Known limitations

- Expo Go is not supported; use a development build.
- Native paths (CallKit, PushKit, notifee full-screen intents, background tasks, WebRTC audio) can only be verified on real devices (see [01 section 11](../mobile/01-overview.md#11-not-verified-on-real-devices)).
- The iOS AppDelegate code generated by the kit's plugin has not been compiled (no macOS here); the first `eas build --platform ios` is the real check.
- iOS VoIP needs a paid Apple Developer account, an APNs key and a physical device (no VoIP push in the simulator).
- `npx expo-doctor` reports two expected warnings: a "duplicate" `react` (the kit's dev-only copy, never bundled thanks to the `blockList`) and React Native Directory notes for `react-native-callkeep`, `react-native-incall-manager`, `react-native-voip-push-notification` (untested on the New Architecture), `@notifee/react-native` (unmaintained) and `@stream-io/react-native-webrtc` (no metadata).
- The demo token endpoint is for local testing only; never expose the demo server to the internet.
- Cleartext HTTP is enabled on both platforms (`usesCleartextTraffic`, `NSAllowsArbitraryLoads`) for LAN testing; remove it for production.
- `eas.json` has no `production` profile and `app.json` has no `extra.eas.projectId` until you run `eas init`. No `google-services.json` is configured, so Android remote push with a store/release build is unverified **(host responsibility)**.
- Placeholders to replace: `com.example.commskitdemo`, `http://192.168.1.10:8000`, "Commskit Demo", notification colour `#4F46E5` (full list in [02 section 5](../mobile/02-keys-secrets-websockets-and-placeholders.md#5-placeholders)).
- Only photos are picked for attachments (`pickAttachment`); the example does not use `createExpoPickers()`, `pickers`, `gate`, `messageActions`, `soundSource` or `documentViewerUrl`.
- `src/screens/PeopleScreen.tsx` lists the demo users from the session, not from your user service.

## 8. What to copy into your own app

| Copy | From | Adapt |
|---|---|---|
| Provider tree and per-mode logic | `src/Main.tsx` | Replace `Session`/`useApp` with your own auth/state; drop the mode switch if you ship one mode |
| `index.ts` background handler registration | `index.ts` | Keep it at module scope before `registerRootComponent` |
| Notifier creation | `src/calls.ts` | `appName`, button texts |
| Push setup and teardown | `src/push.ts` | Use your token; keep the order: register after login, unregister **before** dropping the token |
| Pickers | `src/pickers.ts` | Or use `createExpoPickers()` |
| Icon map | `src/icons.tsx` | Your icon set |
| Chat route with `onCall` bridge | `src/screens/ChatRoute.tsx` | Your navigation types |
| Settings rows for Appearance, Blocked users, Report | `src/screens/SettingsScreen.tsx` | Your settings screen |
| Metro config | `metro.config.js` | Only the parts you need: linked kit needs all; registry install needs package exports, `allowOptionalDependencies` and the optional-peer fallback |
| `app.json` plugins and permissions | `app.json` | Your bundle id, strings, remove cleartext/ATS exemptions for production, add `google-services.json` for Android push |
| `eas.json` | `eas.json` | Add a `production` profile |
| Do **not** copy | `src/session.ts` demo endpoints, `LoginScreen.tsx`, `extra.apiUrl` | Replace with your real login |
