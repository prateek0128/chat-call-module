# commskit mobile: using, running and deploying

How to add the kit to an existing React Native / Expo app, wire it, run it locally, and ship it.

Previous: [02 Keys, secrets, WebSockets and placeholders](02-keys-secrets-websockets-and-placeholders.md) · Start: [01 Overview](01-overview.md) · Example app: [mobile-example](../example/mobile-example.md)

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Getting the package into your app](#2-getting-the-package-into-your-app)
3. [Wiring code](#3-wiring-code)
4. [Running locally](#4-running-locally)
5. [Building and releasing](#5-building-and-releasing)
6. [What the server must provide](#6-what-the-server-must-provide)

Paths are relative to `comms-kit/` unless stated. Commands are shown for bash and PowerShell where they differ. Items marked **(unverified)** were not confirmed in this repo. The backend docs (`docs/backend/`) and web docs are written separately; the backend link used here is `../backend/` plus the existing `backend/backend-python/README.md`.

## 1. Prerequisites

| Need | For | Notes |
|---|---|---|
| Node 20+ and npm | everything | From `examples/expo-app/README.md` |
| Expo SDK 54 app (RN 0.81, React 19.1) | the kit | What the example and the dev dependencies use. Peer ranges are wider (`react >=18`, `react-native >=0.72`); older SDKs are untested. Package exports in Metro are on by default from RN 0.79 / Expo 53 (`mobile/README.md`) |
| Expo account + EAS CLI | cloud builds, `eas init` (push token) | `npm i -g eas-cli`, `eas login` |
| Android Studio (SDK + emulator) | local Android builds / emulator | Not needed if you only use EAS cloud builds and a real phone |
| Xcode (macOS only) | local iOS builds / simulator | Windows/Linux cannot build iOS locally: use EAS cloud builds |
| Paid Apple Developer account | iOS device builds, push, VoIP/CallKit | Device builds need provisioning; VoIP push needs an APNs key |
| Physical devices | push tokens, calls, CallKit, full-screen intents | Simulators cannot get remote push tokens (`registerDevice` returns `not_a_device`); no VoIP push in the iOS simulator |
| Firebase project | Android push (FCM) | **Host responsibility, unverified here** |
| Two devices (or phone + browser demo) | testing chat and calls | |
| The backend | everything | See [section 6](#6-what-the-server-must-provide) |

## 2. Getting the package into your app

The package ships TypeScript source (`mobile/package.json`: `main` = `src/index.ts`), so Metro compiles it like your own code. Options:

| Option | Best for | Effort |
|---|---|---|
| A. Local `file:` link | Developing the kit and the app side by side (what the example does) | Metro config needed |
| B. Private npm registry or GitHub Packages | Teams; versioned installs | Publish setup once |
| C. Vendored copy | Teams that want no registry and no symlinks | A copy script |

### A. Local `file:` link

```jsonc
// your app's package.json
"dependencies": { "commskit": "file:../comms-kit/mobile" }
```

```bash
npm install
```

```powershell
npm install
```

npm makes `node_modules/commskit` a symlink to the folder. Metro needs extra config for that (see [Metro config](#metro-config)). Symlink behaviour on Windows without developer mode **(unverified)**; the example was developed on Windows with this setup.

### B. Registry (private npm or GitHub Packages)

`mobile/package.json` is currently `"private": true` and `"license": "UNLICENSED"`, so `npm publish` refuses. Before publishing:

1. Pick a scoped name: change `"name": "commskit"` to `"@yourorg/commskit"`. Imports become `@yourorg/commskit/chat`, and the config plugin becomes `"plugins": ["@yourorg/commskit"]`.
2. Remove `"private": true`.
3. Set a real `license` (the kit has none yet: **decide the licence with your legal owner**; `UNLICENSED` means all rights reserved).
4. Bump `version` (semver). Optionally add `repository` (required for GitHub Packages linking).
5. `files` already limits the tarball to `src` (without `src/types`), `plugin`, `app.plugin.js`, `README.md`. Check with `npm pack --dry-run`.

Private npm registry (for example Verdaccio, Artifactory, npm Teams):

```bash
cd mobile
npm login --registry https://registry.yourcompany.com
npm publish --registry https://registry.yourcompany.com
```

```powershell
cd mobile
npm login --registry https://registry.yourcompany.com
npm publish --registry https://registry.yourcompany.com
```

GitHub Packages (package scope must be your GitHub user or org, lower case):

```bash
# ~/.npmrc or the consuming app's .npmrc (never commit the token)
echo "@yourorg:registry=https://npm.pkg.github.com" >> .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> ~/.npmrc
cd mobile && npm publish
```

```powershell
Add-Content .npmrc "@yourorg:registry=https://npm.pkg.github.com"
# put //npm.pkg.github.com/:_authToken=<token> in %USERPROFILE%\.npmrc
cd mobile; npm publish
```

Then in the app: `npm install @yourorg/commskit`. For EAS cloud builds, EAS must be able to read the registry: add the token as an EAS secret / `.npmrc` **(unverified: follow EAS "private npm packages" docs)**. Installed from a registry there is no symlink, so `watchFolders` and the `blockList` of the example are not needed; the optional-peer settings below still apply.

### C. Vendored copy (idea, not in the repo)

Copy `mobile/src`, `mobile/plugin`, `mobile/app.plugin.js` and `mobile/package.json` into `your-app/vendor/commskit/` and depend on `"commskit": "file:./vendor/commskit"`. A small sync script:

```bash
rm -rf vendor/commskit && mkdir -p vendor/commskit
cp -r ../comms-kit/mobile/src ../comms-kit/mobile/plugin ../comms-kit/mobile/app.plugin.js ../comms-kit/mobile/package.json vendor/commskit/
rm -rf vendor/commskit/src/types
```

```powershell
Remove-Item -Recurse -Force vendor\commskit -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force vendor\commskit | Out-Null
Copy-Item -Recurse ..\comms-kit\mobile\src, ..\comms-kit\mobile\plugin, ..\comms-kit\mobile\app.plugin.js, ..\comms-kit\mobile\package.json vendor\commskit\
Remove-Item -Recurse -Force vendor\commskit\src\types
```

(`src/types` holds typecheck shims used only inside the kit; the published `files` list excludes it.) You must rerun it for every kit update.

### Installing peers

Install only what the features you use need. Use `npx expo install` so versions match your SDK. These commands come from `mobile/README.md` and the example's `package.json`.

**Chat only (ready-made UI)**

```bash
npx expo install react-native-safe-area-context @react-native-async-storage/async-storage expo-file-system react-native-gesture-handler expo-haptics expo-clipboard expo-video expo-audio expo-sharing expo-media-library expo-linear-gradient expo-image-picker expo-document-picker
```

Everything after `expo-file-system` is optional polish (see the table in [01 section 6](01-overview.md#6-optional-peer-dependencies)). The minimum for headless chat is nothing besides `react`/`react-native` (plus `expo-file-system` for uploads with the default reader). Add `react-native-webview` for the in-app document viewer.

**Chat + push**

```bash
npx expo install expo-notifications expo-device expo-application expo-constants
```

(`expo-application` and `expo-constants` are what the example uses for the device id and project id; the kit does not require them.)

**Calls (add to the above)**

```bash
npm install @stream-io/react-native-webrtc react-native-incall-manager
npx expo install expo-audio
```

The example uses `@stream-io/react-native-webrtc ^145.4.1` and `react-native-incall-manager ^4.3.0`. The kit README's snippet says `^137.0.0` (see the report for this inconsistency); the peer range is `>=118`. These two packages are not in Expo's version table, so use `npm install`, not `expo install` **(unverified whether `expo install` would pin them)**. Add the WebRTC config plugin the example uses: `npm install @config-plugins/react-native-webrtc@~13.0.0` and list it in `app.json` plugins.

**Native call UI when the app is closed (calls + CallKit/full-screen)**

```bash
npm install react-native-callkeep react-native-voip-push-notification @notifee/react-native
npx expo install expo-notifications expo-task-manager @react-native-async-storage/async-storage expo-build-properties expo-dev-client
```

**Everything (the example's full set)**: see `examples/expo-app/package.json`. Also add `@react-navigation/native`, `@react-navigation/native-stack`, `react-native-screens` if you use React Navigation.

Then add the config plugin and rebuild the native project (any native library or plugin change needs a new dev build):

```json
{ "expo": { "plugins": [ ["commskit", { "microphonePermission": "Allow $(PRODUCT_NAME) to use the microphone for voice calls." }] ] } }
```

Plugin details: [02 section 3](02-keys-secrets-websockets-and-placeholders.md#3-the-config-plugin-options-permissions-infoplist).

### Metro config

Needed for a linked/local package. The example's `examples/expo-app/metro.config.js` (comments shortened):

```js
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const kitRoot = path.resolve(projectRoot, "../comms-kit/mobile"); // adjust: where the kit folder is
const SEP = String.raw`[\\/]`;
const pathPattern = (p) =>
  p.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join(SEP);

const config = getDefaultConfig(projectRoot);

// 1. Watch the kit's source (it is outside the project; node_modules/commskit is a symlink).
config.watchFolders = [...(config.watchFolders || []), kitRoot];

// 2. Resolve the kit's imports from THIS app's node_modules, and hide the kit's own node_modules
//    (its test-only copy of React) so the bundle contains exactly one React.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
const kitNodeModules = new RegExp(`^${pathPattern(path.join(kitRoot, "node_modules"))}${SEP}.*$`);
const existing = config.resolver.blockList;
config.resolver.blockList = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), kitNodeModules];

// 3. Package exports ("commskit/chat", ...) on (default in SDK 54; explicit is clearer).
config.resolver.unstable_enablePackageExports = true;

// 4. Optional peers are require()d inside try/catch.
config.transformer.allowOptionalDependencies = true;

module.exports = config;
```

| Setting | Why |
|---|---|
| `watchFolders` | Metro only watches the project by default; a symlinked kit outside it is not hot-reloaded or resolved |
| `resolver.nodeModulesPaths` | The kit's `import "react"` must resolve to the app's React |
| `blockList` of `<kit>/node_modules` | The kit folder has its own `react` for unit tests; a second React breaks hooks ("Invalid hook call") |
| `unstable_enablePackageExports` | Lets `commskit/chat`, `commskit/call`, ... resolve through `package.json` `exports` |
| `allowOptionalDependencies` | A `require("x")` written directly in a `try` block may fail to resolve without breaking the bundle |

**Gotcha** (from the example's `metro.config.js`, step 5): `allowOptionalDependencies` only covers a `require()` written directly inside `try`. Some chat-ui peers are required through a helper in `chat-ui/optionalPeers.ts`, which Metro treats as a hard dependency. If you do not install such a peer, the bundle fails with "Unable to resolve module ...". Fix: install it, or copy the example's `resolveRequest` fallback that maps a missing optional kit peer to `{ type: "empty" }` (the example uses it for `expo-av`). The list in the example: `react-native-gesture-handler`, `expo-haptics`, `expo-clipboard`, `expo-video`, `expo-audio`, `expo-av`, `expo-file-system`, `expo-file-system/legacy`, `expo-sharing`, `expo-media-library`, `expo-linear-gradient`, `@react-native-async-storage/async-storage`, `react-native-safe-area-context`.

If the kit is installed from a registry (a real copy in `node_modules`), you normally need only steps 3 and 4 (and the fallback if you skip peers).

TypeScript: if `tsc` reports two copies of React types because of a linked kit, the example's `tsconfig.json` maps `react`, `react/*` and `react-native` to its own copies through `paths` (typecheck only; `app.json` has `experiments.tsconfigPaths: false` so Metro ignores them).

### Other app-level setup

| Item | What to do |
|---|---|
| `app.json` plugins | `["commskit", {...}]` plus the libraries' own plugins (`expo-notifications`, `expo-image-picker`, `expo-media-library`, `expo-audio`, `expo-build-properties`, `@config-plugins/react-native-webrtc`, `expo-dev-client`), as in `examples/expo-app/app.json` |
| `GestureHandlerRootView` | If `react-native-gesture-handler` is installed (swipe-to-reply, banner swipe), wrap the app root in `<GestureHandlerRootView style={{ flex: 1 }}>` |
| `SafeAreaProvider` | Wrap the app in `SafeAreaProvider` (react-native-safe-area-context) or pass `insets` to every screen |
| `StatusBar` | Left to the host. Call screens are dark: switch to light content from `CallOverlay onVisibleChange` |
| Android keyboard | Keep `windowSoftInputMode=adjustResize` (Expo default; the example sets `softwareKeyboardLayoutMode: "resize"`) |
| Screens' own headers | Set `headerShown: false` for routes that render `ChatScreen` / `ConversationListScreen`, or pass `keyboardVerticalOffset` |

## 3. Wiring code

Real names, verified from `mobile/src` and `examples/expo-app/src/Main.tsx`.

### Provider order

`CommsProvider` (one socket) is the outermost. Then, as needed: `ModerationProvider`, `ChatProvider`, `CallProvider`. Theme/appearance wrap the whole app above them.

```
GestureHandlerRootView
  SafeAreaProvider
    AppearanceProvider  (or ThemeProvider)
      CommsProvider
        ModerationProvider      (optional)
          ChatProvider          (chat modes)
            CallProvider        (call modes; notifier = native call UI)
              navigation + CallOverlay + InAppMessageBanner
```

### Shared setup (all modes)

```tsx
// comms.ts
import { consoleLogger, type CommsConfig } from "commskit/core";
import { auth } from "./auth"; // YOUR login/token code

export const commsConfig: CommsConfig = {
  baseUrl: "https://api.example.com",                // see 02 section 2
  getToken: () => auth.getToken(),                   // refresh here if expired
  getUserId: () => auth.getUserId(),
  logger: __DEV__ ? consoleLogger("[comms]") : undefined,
};
```

If your session can change, build the config with `useMemo` like the example does, and remount the providers with a `key` per user so a new login gets a clean socket and stores.

### Mode 1: chat only

```tsx
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppearanceProvider } from "commskit/theme";
import { CommsProvider } from "commskit/core";
import { ChatProvider } from "commskit/chat";
import { ModerationProvider } from "commskit/moderation";
import AsyncStorage from "@react-native-async-storage/async-storage";

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppearanceProvider storage={AsyncStorage}>
          <CommsProvider config={commsConfig}>
            <ModerationProvider>
              <ChatProvider onError={(e) => Alert.alert("Chat", e.message)}>
                <Navigation />
              </ChatProvider>
            </ModerationProvider>
          </CommsProvider>
        </AppearanceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

Screens:

```tsx
import { ConversationListScreen, ChatScreen } from "commskit/chat-ui";

function Inbox({ navigation }) {
  return (
    <ConversationListScreen
      title="Chats"
      onOpenConversation={(peerId, c) => navigation.navigate("Chat", { peerId, chatId: c.chat_id ?? null })}
      showAppearanceAction
      pickWallpaperImage={pickWallpaperImage}       // host slot, see 02 section 5
    />
  );
}

function ChatRoute({ route, navigation }) {
  const { peerId, chatId, peerName } = route.params;
  return (
    <ChatScreen
      peerId={peerId}
      chatId={chatId ?? null}
      peerName={peerName}
      onBack={navigation.goBack}
      pickAttachment={pickAttachment}                // host slot
      appearanceMenu
      pickWallpaperImage={pickWallpaperImage}
      moderationMenu                                  // needs <ModerationProvider>
    />
  );
}
```

Headless alternative: `useConversations()`, `useConversation(peerId, { chatId })`, `useUnreadCount()`, `useChatApi().startChat(id)` from `commskit/chat` (see `mobile/README.md` section "Chat only").

### Mode 2: calls only

```tsx
import { CommsProvider } from "commskit/core";
import { CallProvider, PUBLIC_STUN, turnCredentialsIceServers, useCall } from "commskit/call";
import { CallOverlay } from "commskit/call-ui";

const iceServers = turnCredentialsIceServers(commsConfig, { fallback: PUBLIC_STUN });

<CommsProvider config={commsConfig}>
  <CallProvider
    iceServers={iceServers}
    onCallError={(err, retry) => {
      if (err.kind === "policy") showCreditPrompt(err.message, () => retry()); // credits / paywall
      else Alert.alert("Call", err.message);
    }}
  >
    <View style={{ flex: 1 }}>
      <Navigation />
      <CallOverlay onVisibleChange={(v) => setStatusBarStyle(v ? "light" : "auto")} />
    </View>
  </CallProvider>
</CommsProvider>;

// anywhere under CallProvider
const { startCall } = useCall();
await startCall(peerId, { peerName: "Asha" });
```

Keep `iceServers` at module scope or in `useMemo` (a stable reference). `useCall()` only works under `<CallProvider>`.

### Mode 3: chat + calls + native call UI + push (everything)

`index.ts` (module scope, **before** `registerRootComponent`; background tasks must exist when Android starts the killed app):

```ts
import { Platform } from "react-native";
import { registerRootComponent } from "expo";
import { registerBackgroundCallHandler } from "commskit/call-native";
import App from "./App";

if (Platform.OS === "android") registerBackgroundCallHandler(); // data-only incoming_call push -> full-screen notification
registerRootComponent(App);
```

`calls.ts` (create the notifier once; only when calls are used):

```ts
import { createPlatformCallNotifier, type NativeCallNotifier } from "commskit/call-native";

let notifier: NativeCallNotifier | null = null;
export const getCallNotifier = () =>
  (notifier ??= createPlatformCallNotifier({
    ios: { appName: "My App" },                         // appName is required
    android: { texts: { answer: "Answer", decline: "Decline" } },
  }));
```

`push.ts` (after login and on every app start):

```ts
import { registerDevice, unregisterDevice } from "commskit/notifications";
import { clearCallSession, registerVoipPush, saveCallSession, type CallKitNotifier } from "commskit/call-native";

export async function setUpPush(config, token, calls) {
  let voipToken: string | null = null;
  let stop = () => {};
  const register = () => registerDevice({
    config,
    deviceId,                       // stable id, e.g. expo-application
    appVersion,
    projectId,                      // from `eas init`
    getVoipToken: () => voipToken,  // iOS only
  });
  if (calls) {
    await saveCallSession({ baseUrl: config.baseUrl, token });   // lets a killed app decline over REST
    if (Platform.OS === "ios") {
      stop = registerVoipPush((t) => { voipToken = t; void register(); }, { notifier: getCallNotifier() as CallKitNotifier });
    }
  }
  await register();
  return stop;
}

export async function tearDownPush(stop: () => void) {
  stop();
  await clearCallSession();
  await unregisterDevice();   // DELETE /devices/{id}, BEFORE the token is dropped
}
```

`Main.tsx` (signed-in tree, from the example):

```tsx
import { CommsProvider } from "commskit/core";
import { ChatProvider } from "commskit/chat";
import { CallProvider, PUBLIC_STUN, turnCredentialsIceServers } from "commskit/call";
import { CallOverlay } from "commskit/call-ui";
import { ModerationProvider } from "commskit/moderation";
import { useNotificationRouting } from "commskit/notifications";
import { useNativeCallNotifier } from "commskit/call-native";

function NativeCallBridge() {
  useNativeCallNotifier(getCallNotifier()); // CallKit / notification buttons -> useCall(); mute mirrored to CallKit
  return null;
}

function NotificationRouter() {              // render inside the navigator, once
  useNotificationRouting({
    onOpenChat: (peerId) => openChat(peerId),         // message / missed-call tap, also from a cold start
    onIncomingCall: () => {},                         // optional: suppress foreground call banners (CallOverlay shows the call)
    suppressFor: () => currentChatPeerId(),           // no banner for the chat on screen
  });
  return null;
}

export function Main({ session }) {
  const config = useMemo(() => ({ baseUrl: session.baseUrl, getToken: () => session.token, getUserId: () => session.userId }), [session]);
  const iceServers = useMemo(() => turnCredentialsIceServers(config, { fallback: PUBLIC_STUN }), [config]);
  return (
    <CommsProvider config={config}>
      <ModerationProvider>
        <ChatProvider onError={(e) => Alert.alert("Chat", e.message)}>
          <CallProvider
            iceServers={iceServers}
            notifier={getCallNotifier()}
            onOpenChat={openChat}
            onCallError={(err, retry) => (err.kind === "policy" ? askCredits(() => retry()) : Alert.alert("Call", err.message))}
          >
            <NativeCallBridge />
            <View style={{ flex: 1 }}>
              <Navigation />                              {/* contains <NotificationRouter /> */}
              <CallOverlay showMessageAction />
            </View>
          </CallProvider>
        </ChatProvider>
      </ModerationProvider>
    </CommsProvider>
  );
}
```

In the chat screen, bridge chat to calls yourself (chat-ui and call never import each other):

```tsx
const { startCall } = useCall();
<ChatScreen peerId={peerId} onCall={(id) => void startCall(id, { chatId, peerName })} ... />
```

For an in-app banner for other chats: `<InAppMessageBanner onOpenChat={(peerId, chatId) => ...} />` after the navigator, inside `ChatProvider` and the theme.

### Navigation integration

**React Navigation** (what the example uses): a `createNavigationContainerRef()` lets code outside screens navigate (notification taps, call screen "Message"):

```tsx
const navRef = createNavigationContainerRef<RootStackParamList>();
const openChat = (peerId: string) => navRef.isReady() && navRef.navigate("Chat", { peerId });

<NavigationContainer ref={navRef}>
  <NotificationRouter />
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="Inbox" component={InboxScreen} />
    <Stack.Screen name="Chat" component={ChatRoute} />
  </Stack.Navigator>
</NavigationContainer>
```

**Expo Router** (not tested in this repo; an adaptation of the same idea):

```tsx
// app/_layout.tsx: providers wrap <Stack/>; `router` replaces navRef
import { router, Stack } from "expo-router";
const openChat = (peerId: string) => router.push({ pathname: "/chat/[peerId]", params: { peerId } });
// render <NotificationRouter /> (useNotificationRouting) and <CallOverlay /> inside the layout, next to <Stack />

// app/chat/[peerId].tsx
import { useLocalSearchParams, router } from "expo-router";
export default function ChatRoute() {
  const { peerId } = useLocalSearchParams<{ peerId: string }>();
  return <ChatScreen peerId={String(peerId)} onBack={router.back} />;
}
```

Hide the header for these routes (`headerShown: false`) because the kit screens draw their own.

### Login and logout lifecycle

| Step | Do |
|---|---|
| Login | Get the token from your backend. Store it securely. Mount the provider tree (autoConnect opens the socket). If you keep providers mounted across login, call `useComms().client.connect()` (or `reconnect()` after a token change) |
| After login, every app start | `registerDevice(...)`; with calls: `saveCallSession({ baseUrl, token })`; iOS: `registerVoipPush(...)` |
| Token refresh | Update what `getToken()` returns, call `saveCallSession` again, and `client.reconnect()` if the socket was closed for a bad token |
| Logout | (1) stop VoIP listener (2) `clearCallSession()` (3) `unregisterDevice()` while the token is still valid (4) `useComms().client.disconnect()` (5) clear your stored token and unmount the providers (the example remounts by `key`) |

### Credits / paywall

Call refusals reach `onCallError(err, retry)`. `err.kind === "policy"` (HTTP 402/403 style host policy; credit info in `err.raw.info`) produces **no** failure screen: show your own prompt, then `retry()` places the call again with `credit_acknowledged: true`, or `retry({...yourFields})`. Other kinds include `busy`, `microphone`, `not_connected`, `already_in_call`, `unavailable`, `server`, `blocked` (a block-refused call is not retryable). `startCall(peerId, { extra: {...} })` adds host fields to `call_initiate`.

### Theming and branding

```tsx
<AppearanceProvider
  storage={AsyncStorage}
  renderIcon={renderIcon}
  theme={{
    colors: { accent: "#0F766E", bubbleOut: "#0F766E" },    // both schemes
    schemes: { dark: { accent: "#2DD4BF" } },               // per scheme (wins)
    radius: { bubble: 14 },
    font: { nativeFamily: "Inter" },
  }}
>
```

`theme` also accepts a full `Theme` from `createTheme(overrides, "dark")`. Users can then pick Auto/Light/Dark, a preset and wallpapers themselves (`showAppearanceAction`, `appearanceMenu`). Icon names to map: see `mobile/README.md` "Theming and overrides". Use `AppearanceProvider` **instead of** `ThemeProvider` (it renders one).

## 4. Running locally

### 4.1 Start the backend demo

The demo server is `examples/backend/demo-server-python/demo_server.py` (setup in `backend/backend-python/README.md`; the fuller backend guide is in `../backend/backend-python/`). It runs with the backend's virtualenv. Bind to all interfaces so phones can reach it:

```bash
# from the comms-kit folder
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

```powershell
# from the comms-kit folder
.\backend\backend-python\.venv\Scripts\python.exe -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
```

Features can be limited with `COMMS_FEATURES` (default `chat,call`): bash `COMMS_FEATURES=chat ...`; PowerShell `$env:COMMS_FEATURES = "chat"` before the command. The demo hands out tokens to anyone: never expose it to the internet.

### 4.2 Which URL the app uses

| Where the app runs | Server URL | Notes |
|---|---|---|
| Android emulator | `http://10.0.2.2:8000` | `10.0.2.2` is the emulator's alias for the host PC (the Maestro default) |
| iOS simulator | `http://localhost:8000` | Same machine (standard behaviour; **unverified here**, no macOS) |
| Physical phone | `http://<PC LAN IP>:8000` | Phone and PC on the same Wi-Fi; server started with `--host 0.0.0.0`; firewall must allow port 8000 (Windows: allow Python on "Private networks") |

Find the LAN IP: Windows `ipconfig` (IPv4 of the Wi-Fi adapter); macOS `ipconfig getifaddr en0`; Linux `hostname -I`. Test from the phone's browser: `http://<PC-IP>:8000/dev/users` should return JSON.

Plain `http://` / `ws://` works only because the example app enables cleartext (Android `usesCleartextTraffic`, iOS `NSAllowsArbitraryLoads`). Your own app needs the same for local HTTP dev, and must not ship it for production ([02 section 4](02-keys-secrets-websockets-and-placeholders.md#cleartext-ws-for-local-development)).

### 4.3 Dev build vs Expo Go

| Feature | Expo Go | Dev build (`expo-dev-client`) |
|---|---|---|
| Voice calls (WebRTC), CallKit, notifee, VoIP push, the config plugin | **No**. Native modules | Yes |
| Chat only (`core`, `chat`, `chat-ui`, `theme`, `moderation`) | **Unverified.** The code lazily requires optional peers, so it may run if every native peer you import exists inside Expo Go; not tested here | Yes |
| Remote push | Unverified; Expo has restricted remote push in Expo Go on recent SDKs (check Expo docs) | Yes, on a physical device |

The example README states plainly: Expo Go is not supported; use a development build.

Build and run a dev client (details in [mobile-example](../example/mobile-example.md)):

```bash
npx expo install --check
eas build --profile development --platform android      # or: npx expo run:android (Android Studio)
npx expo start --dev-client
```

```powershell
npx expo install --check
eas build --profile development --platform android
npx expo start --dev-client
```

iOS: `eas build --profile development --platform ios` after `eas device:create` (cloud, works from Windows), or `npx expo run:ios` on a Mac.

### 4.4 Tests

```bash
cd mobile && npm install && npm run typecheck && npm test      # 24 suites, 325 tests passed on 2026-10-26
cd ../examples/expo-app && npm run typecheck                    # the example's own tsc check
```

Same commands in PowerShell (use `;` instead of `&&` on Windows PowerShell 5.1: `npm run typecheck; npm test`). `npm run check:boundaries` runs only the import-rule test.

### 4.5 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Invalid hook call" / two copies of React | The kit's own `node_modules/react` is bundled | Metro `blockList` for `<kit>/node_modules` and `nodeModulesPaths` to the app (see [Metro config](#metro-config)) |
| "Unable to resolve module expo-xxx from .../commskit/src/..." | An optional peer is not installed and is required through a helper (`optionalPeers.ts`) | Install it, or use the empty-module `resolveRequest` fallback from the example |
| "Unable to resolve module commskit/chat" | Package exports off or kit not watched | `unstable_enablePackageExports = true`, `watchFolders`; restart Metro with `npx expo start --clear` |
| "Network request failed" on login / REST | Wrong URL for where the app runs; server bound to 127.0.0.1; firewall; cleartext blocked | Use the table in 4.2; `--host 0.0.0.0`; allow port 8000; enable cleartext for dev; check `/dev/users` in the phone browser |
| Socket status stays `reconnecting` / banner "offline" | Same as above, or expired/invalid token (close code 1008, see `useConnectionStatus().lastCloseCode`) | Fix URL; make `getToken()` return a fresh token |
| Status `unauthenticated` | `getToken()` returned nothing | Log in first; then `client.connect()` |
| `registerDevice` returns `registered: false`, reason `not_a_device` | Simulator/emulator | Use a physical device |
| reason `permission_denied` | User refused notifications | Re-enable in system settings |
| reason `no_token` or push token error | Missing EAS `projectId` | Run `eas init`; or pass `projectId` |
| Microphone permission / "Microphone access is blocked" | Permission denied or `NSMicrophoneUsageDescription` missing | Check the plugin option `microphonePermission`; re-allow in settings. Android prompts at the first call |
| Call connects but no audio / one-way audio on mobile data | No TURN | Configure TURN on the backend (`TURN_SECRET`, `TURN_URIS`) and use `turnCredentialsIceServers` |
| Speaker button does nothing | `react-native-incall-manager` missing | Install it, or pass `speakerAvailable={false}` |
| CallKit does not ring when the app is killed (iOS) | No VoIP token reached the backend; backend `APNS_*` missing/wrong; sandbox vs production mismatch; simulator; AppDelegate patch not applied | Check `POST /devices` has `voip_token`; set `APNS_USE_SANDBOX=1` for dev builds; use a physical iPhone; check `plugins` has `commskit` with `voip` not `false`; rebuild. Without `APNS_*` the backend falls back to a normal push (no CallKit) |
| `eas build` iOS fails in the AppDelegate patch | Objective-C AppDelegate, or Swift selector names differ | The plugin throws for non-Swift AppDelegates; pass `voip: false` or add the code by hand. First iOS build is the real check (not compiled in this repo) |
| Android incoming call shows no full-screen screen | Android 14+ requires the full-screen-intent permission to be granted | Settings > Apps > your app > allow full-screen notifications |
| Android call does not wake a killed app | OEM battery killer (Xiaomi, Oppo, ...) | Disable battery optimisation for the app |
| Android build: notifee artifact not found | Maven repo not resolved | notifee 7+ autolinks it; otherwise `expo-build-properties` `android.extraMavenRepos: ["../node_modules/@notifee/react-native/android/libs"]` (as in the example) |
| Notification channel changes ignored | Channels are immutable once created | Uninstall/reinstall, or use new channel ids |
| Killed-app decline does nothing | No stored session or stale token, or AsyncStorage missing | Call `saveCallSession` after login and after token refresh; install async-storage |
| "Delete for everyone" missing or rejected | `unsendWindowSeconds` differs from the server value | Match `ChatConfig.unsend_window_seconds` |

## 5. Building and releasing

### EAS profiles

`examples/expo-app/eas.json` (verified):

```json
{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal", "android": { "buildType": "apk" }, "ios": { "resourceClass": "default" } },
    "development-simulator": { "extends": "development", "ios": { "simulator": true } },
    "preview": { "distribution": "internal", "android": { "buildType": "apk" } }
  },
  "submit": {}
}
```

| Profile | Purpose |
|---|---|
| `development` | Dev client (needs Metro), internal distribution, Android APK |
| `development-simulator` | Same, for the iOS simulator |
| `preview` | Standalone APK with JS bundled (no Metro): E2E runs, second tester |
| `production` | **Not in the example.** Add one yourself, for example `"production": { "autoIncrement": true }` (a suggestion; with `appVersionSource: "remote"` EAS manages build numbers) **(unverified here)** |

```bash
eas init                                                  # once: EAS project, writes extra.eas.projectId
eas build --profile development --platform android
eas build --profile production --platform all
eas submit --platform ios                                 # to TestFlight / App Store Connect
eas submit --platform android                             # to Google Play
```

The same commands work in PowerShell. The example depends on `file:../../mobile`, so EAS must upload the whole repo; build from a checkout of this repo. With the kit from a registry, EAS only needs your app.

### Credentials

| Platform | What | How |
|---|---|---|
| iOS | Apple Developer account, bundle id, provisioning, Push Notifications capability | EAS manages signing and entitlements (`eas credentials`). Devices for internal builds: `eas device:create` |
| iOS | APNs key (.p8) for **backend** VoIP push (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX`) | Apple Developer portal. Never in the app. The backend sends to topic `<bundle id>.voip` |
| iOS | Push key for Expo push (chat messages) | EAS credentials **(unverified: follow Expo docs)** |
| iOS | `UIBackgroundModes` audio / voip / remote-notification, microphone string | Set by the `commskit` plugin |
| Android | FCM v1 service account key uploaded to EAS; `google-services.json` in the app | Firebase console, `eas credentials` **(host responsibility, unverified here)** |
| Android | Upload keystore | EAS-managed or your own |
| Android | Permissions and services | Set by the `commskit` plugin ([02 section 3](02-keys-secrets-websockets-and-placeholders.md#3-the-config-plugin-options-permissions-infoplist)) |

### Production checklist for the app

- `baseUrl` is `https://`; remove `NSAllowsArbitraryLoads` and `usesCleartextTraffic`.
- Own bundle id / package; matches backend `APNS_BUNDLE_ID` and Firebase.
- Real `microphonePermission` and photo strings.
- Real login; no `/dev/*` endpoints; `getToken` refreshes tokens.
- `projectId` set by `eas init`.
- Backend has TURN and the push credentials ([section 6](#6-what-the-server-must-provide)).
- Test the native paths on real devices first ([01 section 11](01-overview.md#11-not-verified-on-real-devices)).

### OTA updates

`examples/expo-app` does not include `expo-updates` (not in its `package.json`), so OTA is **not configured** there. If you add EAS Update, only JS/asset changes can ship over the air. Anything that changes native code (adding a native peer, changing `commskit` plugin options, bumping an SDK) needs a new binary build.

### Store requirements

Privacy policy, App Store privacy labels, Google Play Data safety answers and store review notes are your app's
responsibility. This kit does not ship templates for them.

### Versioning

| What | Where |
|---|---|
| App version shown to users | `app.json` `expo.version` (the example reads it via `Constants.expoConfig?.version` and sends it as `app_version` in `POST /devices`) |
| Build numbers | EAS remote (`"appVersionSource": "remote"`) |
| Kit version | `mobile/package.json` `version` (`0.1.0`). Pin an exact version of the kit in your app; the kit ships source, so any update can change behaviour |
| Wire protocol | `docs/archive/PROTOCOL.md` v1. Keep app and backend kit versions compatible |

## 6. What the server must provide

Backend docs: [`../backend/backend-python/`](../backend/backend-python/) (being written; the existing reference is `backend/backend-python/README.md`, including its "Devices and push notifications" and "APNs VoIP (iOS CallKit)" sections).

| Server capability | Used by the app for | Reference |
|---|---|---|
| `wss://<host>/ws/<jwt>` WebSocket | Everything live | `docs/archive/PROTOCOL.md` section 1 |
| JWT validation (same secret you sign with at login) | Authentication | your backend |
| Chat feature (+ `chat` REST: `POST /chats/start`) | Chat | PROTOCOL sections 3, 5, 9 |
| Call feature (signalling relay, `POST /call/turn-credentials`, `POST /call/{id}/reject`) | Calls | PROTOCOL section 4 |
| Moderation (`/moderation/blocks`, `/moderation/reports`) | Block / report | PROTOCOL section 7 |
| Device registry (`POST /devices`, `DELETE /devices/{id}`) + push sender (Expo) | Push | PROTOCOL section 8 |
| APNs VoIP credentials (`APNS_*`, `pip install -e "./backend/backend-python[apns]"`) | iOS CallKit when killed | backend README |
| `android_call_style = "data"` (default in the demo) | Android full-screen incoming call when killed | PROTOCOL section 8 |
| TURN server + `TURN_SECRET`, `TURN_URIS` | Calls over mobile data | `examples/expo-app/README.md` |
| Media storage (S3 or compatible, presigned URLs) | Attachments | `docs/backend/backend-python/03-using-running-and-deploying.md` |
| TLS, WebSocket upgrade through the proxy, idle timeout at least 120 s, JWT redacted from logs | Production | `docs/backend/backend-python/03-using-running-and-deploying.md` |
| `unsend_window_seconds` equal to the app's `unsendWindowSeconds` | Delete for everyone | PROTOCOL section 9 |

### Local vs production: what do I need

| Item | Local development | Production |
|---|---|---|
| Server URL | `http://<LAN IP>:8000` or `10.0.2.2` | `https://api.yourapp.com` (`wss` derived) |
| Cleartext allowance | Yes (dev only) | No |
| Auth | Demo `/dev/token/{id}` | Your login, short-lived JWT + refresh |
| App identity | `com.example.commskitdemo` | Your own bundle id / package |
| Build | Dev build (`expo-dev-client`) | `production` profile, store submission |
| Expo account, `eas init` | Needed for push only | Required |
| Android push (FCM) | Optional for chat/calls on a foreground app | Required: `google-services.json` + FCM service account |
| iOS push / VoIP | Optional; needs paid Apple account + physical iPhone | Required for killed-app calls: APNs key on backend, production APNs (not sandbox) |
| TURN | Optional on one Wi-Fi network | Required (mobile data) |
| Media storage | Local disk | S3-compatible, private bucket |
| Moderation, privacy policy, store notes | Not needed | Required by stores for user-generated content |
| Tests | `npm run typecheck`, `npm test` | Plus the real-device checklist |
