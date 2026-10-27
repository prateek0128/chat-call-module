/** Root: safe areas + appearance (theme, wallpapers, icons) around the login screen or the signed-in app. */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppearanceProvider } from "commskit/theme";
import { renderIcon } from "./src/icons";
import { LoginScreen } from "./src/screens/LoginScreen";
import { Main } from "./src/Main";
import { clearSession, loadSession, saveSession, type Session } from "./src/session";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadSession().then((s) => {
      setSession(s);
      setReady(true);
    });
  }, []);

  const login = useCallback((s: Session) => {
    void saveSession(s);
    setSession(s);
  }, []);

  const logout = useCallback(() => {
    void clearSession();
    setSession(null);
  }, []);

  return (
    // GestureHandlerRootView: the kit's optional swipe-to-reply / banner swipe (react-native-gesture-handler).
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppearanceProvider
          storage={AsyncStorage}
          renderIcon={renderIcon}
          onStorageError={() => Alert.alert("Appearance", "Couldn't save your wallpaper. It's kept until the app restarts.")}
        >
          <StatusBar style="auto" />
          {!ready ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator />
            </View>
          ) : session ? (
            // key: a new user / server / mode gets fresh providers (one socket per session)
            <Main key={`${session.baseUrl}|${session.userId}|${session.mode}`} session={session} onLogout={logout} />
          ) : (
            <LoginScreen onLogin={login} />
          )}
        </AppearanceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
