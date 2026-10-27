# Commskit Demo (Expo example app)

A runnable Expo SDK 54 / React Native 0.81 app that uses every part of the mobile kit
([`../../mobile`](../../mobile/README.md)) against the demo backend
([`../backend/demo-server-python/demo_server.py`](../backend/demo-server-python/demo_server.py)):

| Kit entry | Used for |
|---|---|
| `commskit/core` | `CommsProvider` (one socket), `useComms`, `useConnectionStatus` |
| `commskit/chat` + `commskit/chat-ui` | `ChatProvider`, `ConversationListScreen`, `ChatScreen` (attachments, appearance menu, moderation menu, call button), `AppearanceSheet`, `ReportSheet`, `BlockedUsersScreen` |
| `commskit/call` + `commskit/call-ui` | `CallProvider` (TURN via `turnCredentialsIceServers`, falling back to public STUN), `useCall().startCall`, `CallOverlay` with an `expo-linear-gradient` background |
| `commskit/call-native` | `createPlatformCallNotifier` + `useNativeCallNotifier` (CallKit on iOS, notifee full-screen calls on Android), `registerVoipPush` (iOS), `registerBackgroundCallHandler` (Android, killed app, in `index.ts`), `saveCallSession` / `clearCallSession` |
| `commskit/notifications` | `registerDevice` on login, `unregisterDevice` on logout, `useNotificationRouting` (tap → open chat) |
| `commskit/moderation` | `ModerationProvider`, `useBlocking` |
| chat-ui optional peers | react-native-gesture-handler (`GestureHandlerRootView` in `App.tsx`), expo-haptics, expo-clipboard, expo-video, expo-audio, expo-sharing, expo-media-library |
| `commskit/theme` | `AppearanceProvider` (persisted in AsyncStorage), `renderIcon` (MaterialCommunityIcons), `useTheme`, `Avatar` |
| config plugin | `"plugins": [["commskit", {...}]]` in `app.json` |

Expo Go is **not** supported: WebRTC, CallKit, notifee and VoIP push are native modules. You need a
development build (EAS or a local `expo run:*`).

## Layout

```
App.tsx              SafeAreaProvider > AppearanceProvider > Login | Main
index.ts             registerBackgroundCallHandler() (Android) before registerRootComponent
src/Main.tsx         CommsProvider > ModerationProvider > ChatProvider? > CallProvider? > navigation + CallOverlay
src/screens/         Login, Inbox (ConversationListScreen), Chat (ChatScreen), People (calls-only),
                     Settings (Appearance, Blocked users, Report…, Log out), Blocked (BlockedUsersScreen)
src/push.ts          registerDevice / registerVoipPush / saveCallSession, and the logout teardown
src/calls.ts         the platform call notifier, created once (only when calls are on)
src/pickers.ts       pickAttachment + pickWallpaperImage (expo-image-picker / image-manipulator / file-system)
metro.config.js      resolves the linked kit (see "How the kit is linked")
.maestro/            E2E flows
```

## Prerequisites

- Node 20+ and npm.
- An [Expo account](https://expo.dev/signup) and EAS CLI: `npm i -g eas-cli`, then `eas login`.
- Android: any Android 10+ phone (USB debugging not required for EAS installs).
- iOS: a paid Apple Developer account (dev builds on a device need provisioning; VoIP push needs an APNs key).
- Python backend set up as in [`../../backend/backend-python/README.md`](../../backend/backend-python/README.md) (`backend/backend-python/.venv`).
- Two phones (or a phone + the browser demo) to test chat and calls between two users.

## 1. Run the demo server on your LAN

```bash
# from the comms-kit folder
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` makes it reachable from phones on the same Wi-Fi. Find your PC's LAN IP:
- Windows: `ipconfig` → "IPv4 Address" of the Wi-Fi adapter (e.g. `192.168.1.23`)
- macOS: `ipconfig getifaddr en0`; Linux: `hostname -I`

Check it from the phone's browser: `http://<PC-IP>:8000/dev/users` should show JSON. If not, allow
port 8000 through the PC firewall (Windows: allow Python on "Private networks").

The demo server hands out tokens to anyone. Never expose it to the internet.

## 2. Build and install the dev client

```bash
cd examples/expo-app
npm install                    # also links ../../mobile as node_modules/commskit
npx expo install --check       # optional: confirms SDK-compatible versions
eas init                       # once: creates the EAS project and writes extra.eas.projectId (needed for push tokens)
eas build --profile development --platform android     # APK, install from the link / QR code
eas build --profile development --platform ios         # register the device first: eas device:create
```

EAS uploads the whole git repository (the app depends on `file:../../mobile`), so build from a
checkout of this repo. Local builds also work: `npx expo run:android` / `npx expo run:ios` (Android
Studio / Xcode required).

Then start Metro and open the app on the phone (same Wi-Fi as the PC):

```bash
npx expo start --dev-client
```

The `preview` profile builds a standalone APK with the JS bundled in (no Metro needed), useful for E2E
runs and for handing the app to a second tester.

**Change the app id:** edit `ios.bundleIdentifier` and `android.package` in `app.json`
(`com.example.commskitdemo`), plus `APNS_BUNDLE_ID` on the server. Rebuild after changing them.

## 3. Sign in

The login screen asks for the **server URL**. The default comes from `app.json` →
`expo.extra.apiUrl` (`http://192.168.1.10:8000`); edit it in the field to `http://<PC-IP>:8000` and tap
**Load**. It is remembered on the phone. Then pick the mode (**Chat / Calls / Both**; modes the server
doesn't run are disabled, see `COMMS_FEATURES`) and a demo user: Alice (U1), Bob (U2) or Carol (U3).

Plain `http://` works because the app allows cleartext traffic (`expo-build-properties`
`usesCleartextTraffic`, iOS `NSAllowsArbitraryLoads`). Use HTTPS for anything beyond a LAN demo.

## 4. What to try on two phones

Phone A signs in as Alice, phone B as Bob (or use `http://<PC-IP>:8000/#U2` in a browser for Bob).

- **Chat:** open Bob, send text and a photo (📎), watch ✓ / ✓✓ / read ticks and "typing…". Scroll up
  to load older messages. Turn off Wi-Fi to see the connection banner.
- **Calls:** in a chat tap the phone icon (or the Calls tab in Calls mode). Accept on the other phone;
  try Mute, Speaker, minimise (Android back) → "Return to call" pill, Hang up. The call log appears in
  the chat with "Call back".
- **Appearance:** palette icon in the list header (theme mode, 7 themes, wallpapers incl. "Choose
  image…"); in a chat ⋮ → Wallpaper for a per-chat wallpaper. Settings → Theme & wallpaper opens the
  same sheet.
- **Report / block:** in a chat ⋮ → Block / Unblock, or Report (category, details, "Also block").
  Settings → Blocked users lists and unblocks. Settings → Report Bob opens the standalone `ReportSheet`.
- **Push:** put the app in the background on phone B and send a message from A: a notification
  arrives; tapping it opens that chat. Settings → Push shows the registration status.
  Push needs `eas init` (project id) and a physical device. With "enhanced push security" on, start
  the server with `EXPO_ACCESS_TOKEN`.
- **Killed-app calls (Android):** swipe the app away on B, call from A. The server sends a data-only
  push (`ANDROID_CALL_STYLE=data`, the default), the background task shows a full-screen call
  notification; Answer opens the app and connects, Decline rejects over REST. On Android 14+ grant
  "full-screen notifications" for the app in system settings. Some OEMs (Xiaomi, Oppo, …) block
  background starts until you disable battery optimisation for the app.
- **Killed-app calls (iOS):** needs APNs VoIP (below). Lock B, call from A: CallKit rings; answer from
  the lock screen.

### Calls over mobile data (TURN)

STUN alone usually fails between a phone on mobile data and one on Wi-Fi. Run a TURN server (e.g.
coturn with `use-auth-secret` / `static-auth-secret=<secret>`) and start the demo server with:

```bash
TURN_SECRET=<secret> TURN_URIS="turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp" \
  backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

The app fetches short-lived credentials from `POST /call/turn-credentials` and falls back to public
STUN when the server has none. The phones also have to reach the server itself (a public URL or a
tunnel such as cloudflared/ngrok, then use that URL on the login screen).

### iOS VoIP push (CallKit when the app is closed)

Create an APNs key in the Apple Developer portal (see
[backend README → APNs VoIP](../../backend/backend-python/README.md#apns-voip-ios-callkit)), install the `apns`
extra (`pip install -e "./backend/backend-python[apns]"`) and start the server with:

```bash
APNS_KEY_PATH=/path/AuthKey_ABC123.p8 APNS_KEY_ID=ABC123 APNS_TEAM_ID=TEAM123456 \
APNS_BUNDLE_ID=com.example.commskitdemo APNS_USE_SANDBOX=1 \
  backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

`APNS_USE_SANDBOX=1` for development builds; TestFlight / App Store builds use production. Without
the `APNS_*` variables iOS gets a normal push for incoming calls instead of CallKit.

## E2E tests (Maestro)

Flows in [`.maestro/`](.maestro): `login_and_chat.yaml` (Alice → Bob, send, see it), `appearance.yaml`
(mode, theme, wallpaper, per-chat wallpaper), `report_block.yaml` (block / unblock, report, Settings →
Blocked users), `call_ui.yaml` (call Bob, see "Calling…", hang up). They use the kit's accessibility
labels ("Send message", "More options", "Call Bob", "Hang up", …) and the example's own testIDs
(`login-*`, `open-settings`, `settings-*`, `logout`).

1. Install [Maestro](https://maestro.mobile.dev/getting-started/installing-maestro) (Windows: via WSL
   or the Maestro Studio app).
2. Start the demo server (step 1) and an Android emulator or a USB device with the app installed.
   Easiest is the `preview` build (JS embedded). With the dev build, open the project in the dev
   client once (`npx expo start --dev-client`) so a launch goes straight to the app.
3. Run from `examples/expo-app`:

```bash
maestro test .maestro                                         # Android emulator: server at http://10.0.2.2:8000
maestro test -e SERVER_URL=http://192.168.1.23:8000 .maestro   # a real device on your Wi-Fi
```

The flows sign in as Alice. The conversation list must show Bob (the demo server lists every demo
user). `call_ui.yaml` doesn't need anyone to answer.

## How the kit is linked

`"commskit": "file:../../mobile"` makes `node_modules/commskit` a symlink to the kit's TypeScript source.
- `metro.config.js`: `watchFolders` includes `../../mobile`; `resolver.nodeModulesPaths` is this app's
  `node_modules`; `blockList` hides `../../mobile/node_modules` (the kit's own test-only copy of React)
  so the bundle has one React; package exports (`commskit/chat`, …) are on (SDK 54 default, set
  explicitly); `allowOptionalDependencies` is on (every optional peer is installed anyway).
- `tsconfig.json`: `paths` maps `react` / `react-native` to this app's copies for `tsc` only
  (`experiments.tsconfigPaths: false` in `app.json` keeps Metro from using them).
- `metro.config.js` also resolves a kit optional peer that isn't installed (only `expo-av` here) to an
  empty module; see "Known issues".
- Edits in `../../mobile/src` hot-reload in the running app.

## Known issues and limitations

- **Expo Go is not supported**; use a development build. Native paths (CallKit, PushKit, notifee
  full-screen intents, background tasks, WebRTC audio) can only be verified on real devices; see the
  kit's [real-device checklist](../../mobile/README.md#what-must-be-verified-on-real-devices).
- `npx expo-doctor` reports two expected warnings: a "duplicate" `react` (the kit's dev-only copy in
  `mobile/node_modules`, never bundled thanks to the Metro `blockList`), and React Native Directory
  notes (react-native-callkeep, react-native-incall-manager, react-native-voip-push-notification:
  "untested on New Architecture"; @notifee/react-native: "unmaintained"; @stream-io/react-native-webrtc:
  no metadata). They run through the New Architecture interop layer; verify on devices.
- The generated iOS AppDelegate code from the kit's plugin has not been compiled here (no macOS);
  the first `eas build --platform ios` is the real check.
- iOS VoIP needs a paid Apple Developer account, APNs key and a physical device (no VoIP push in the
  simulator).
- The demo token endpoint is for local testing only.
