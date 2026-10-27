/**
 * Signed-in app. Provider stack (README "Chat + call"):
 *   CommsProvider (one socket) > ModerationProvider > ChatProvider (not in Calls mode)
 *     > CallProvider (not in Chat mode, with the CallKit / notifee notifier) > navigation + CallOverlay
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { NavigationContainer, createNavigationContainerRef, DarkTheme, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { setStatusBarStyle } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { CommsProvider, consoleLogger, type CommsConfig } from "commskit/core";
import { ChatProvider } from "commskit/chat";
import { CallProvider, PUBLIC_STUN, turnCredentialsIceServers } from "commskit/call";
import { CallOverlay } from "commskit/call-ui";
import { ModerationProvider } from "commskit/moderation";
import { useNotificationRouting, type RegisterDeviceResult } from "commskit/notifications";
import { useNativeCallNotifier } from "commskit/call-native";
import { useTheme } from "commskit/theme";
import { getCallNotifier } from "./calls";
import { setUpPush, tearDownPush } from "./push";
import { modeHasCalls, modeHasChat, type Session } from "./session";
import { InboxScreen } from "./screens/InboxScreen";
import { PeopleScreen } from "./screens/PeopleScreen";
import { ChatRoute } from "./screens/ChatRoute";
import { SettingsScreen } from "./screens/SettingsScreen";
import { BlockedScreen } from "./screens/BlockedScreen";

export type RootStackParamList = {
  Inbox: undefined;
  People: undefined;
  Chat: { peerId: string; chatId?: number | null; peerName?: string };
  Settings: undefined;
  Blocked: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
export const navRef = createNavigationContainerRef<RootStackParamList>();

const openChat = (peerId: string) => {
  if (navRef.isReady()) navRef.navigate("Chat", { peerId });
};

interface AppCtx {
  session: Session;
  chat: boolean;
  calls: boolean;
  push: { result: RegisterDeviceResult | null; error: string | null };
  logout: () => Promise<void>;
}
const Ctx = createContext<AppCtx | null>(null);
export const useApp = (): AppCtx => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside <Main>");
  return v;
};

export function Main({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const chat = modeHasChat(session.mode);
  const calls = modeHasCalls(session.mode);

  const config = useMemo<CommsConfig>(
    () => ({
      baseUrl: session.baseUrl,
      getToken: () => session.token,
      getUserId: () => session.userId,
      logger: __DEV__ ? consoleLogger("[comms]") : undefined,
    }),
    [session],
  );
  // POST /call/turn-credentials (TURN for mobile data), cached until ttl; public STUN when the server has no TURN.
  const iceServers = useMemo(() => turnCredentialsIceServers(config, { fallback: PUBLIC_STUN }), [config]);

  // Devices + push (POST /devices, iOS VoIP token, saved call session) after login / on every start.
  const [push, setPush] = useState<AppCtx["push"]>({ result: null, error: null });
  const stopVoip = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    setUpPush(config, session.token, calls, (result, error) => alive && setPush({ result, error })).then((p) => {
      if (alive) stopVoip.current = p.stop;
      else p.stop();
    });
    return () => {
      alive = false;
      stopVoip.current();
    };
  }, [config, session.token, calls]);

  const logout = useCallback(async () => {
    await tearDownPush(stopVoip.current); // DELETE /devices/{id} BEFORE dropping the token
    onLogout();
  }, [onLogout]);

  const ctx = useMemo<AppCtx>(() => ({ session, chat, calls, push, logout }), [session, chat, calls, push, logout]);

  let body: ReactNode = <Navigation />;
  if (calls) {
    body = (
      <CallProvider
        iceServers={iceServers}
        notifier={getCallNotifier()}
        onOpenChat={chat ? openChat : undefined}
        onCallError={(err, retry) => {
          if (err.kind === "policy") Alert.alert("Call", err.message, [{ text: "Cancel" }, { text: "Call anyway", onPress: () => retry() }]);
          else Alert.alert("Call", err.message);
        }}
      >
        <NativeCallBridge />
        <View style={{ flex: 1 }}>
          <Navigation />
          <ThemedCallOverlay showMessageAction={chat} />
        </View>
      </CallProvider>
    );
  }
  if (chat) body = <ChatProvider onError={(e) => Alert.alert("Chat", e.message)}>{body}</ChatProvider>;

  return (
    <Ctx.Provider value={ctx}>
      <CommsProvider config={config}>
        <ModerationProvider>{body}</ModerationProvider>
      </CommsProvider>
    </Ctx.Provider>
  );
}

/** CallKit / notification buttons -> useCall(); mute mirrored to CallKit. */
function NativeCallBridge() {
  useNativeCallNotifier(getCallNotifier());
  return null;
}

function ThemedCallOverlay({ showMessageAction }: { showMessageAction: boolean }) {
  const theme = useTheme();
  return (
    <CallOverlay
      showMessageAction={showMessageAction}
      onVisibleChange={(v) => setStatusBarStyle(v ? "light" : "auto")}
      renderBackground={() => (
        <LinearGradient colors={[theme.colors.callBackgroundStart, theme.colors.callBackgroundEnd]} style={StyleSheet.absoluteFill} />
      )}
    />
  );
}

/** Notification taps (warm + cold start) -> open the chat; no banner for the chat on screen. */
function NotificationRouter() {
  const { chat, calls } = useApp();
  useNotificationRouting({
    onOpenChat: (peerId) => (chat ? openChat(peerId) : undefined),
    // With calls on, the in-app CallOverlay shows ringing calls, so suppress foreground call banners.
    onIncomingCall: calls ? () => {} : undefined,
    suppressFor: () => {
      const route = navRef.isReady() ? navRef.getCurrentRoute() : undefined;
      return route?.name === "Chat" ? (route.params as RootStackParamList["Chat"]).peerId : null;
    },
  });
  return null;
}

function Navigation() {
  const { chat } = useApp();
  const theme = useTheme();
  const base = theme.scheme === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = { ...base, colors: { ...base.colors, background: theme.colors.background, card: theme.colors.surface, text: theme.colors.text, primary: theme.colors.accent, border: theme.colors.border } };
  return (
    <NavigationContainer ref={navRef} theme={navTheme}>
      <NotificationRouter />
      <Stack.Navigator initialRouteName={chat ? "Inbox" : "People"} screenOptions={{ headerShown: false }}>
        {chat ? <Stack.Screen name="Inbox" component={InboxScreen} /> : <Stack.Screen name="People" component={PeopleScreen} />}
        {chat ? <Stack.Screen name="Chat" component={ChatRoute} /> : null}
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: true, title: "Settings" }} />
        <Stack.Screen name="Blocked" component={BlockedScreen} options={{ headerShown: true, title: "Blocked users" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
