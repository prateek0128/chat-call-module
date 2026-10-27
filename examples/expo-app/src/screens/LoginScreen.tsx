/** Demo sign-in: server URL (persisted), feature mode (limited by the server), pick Alice / Bob / Carol. */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar, useTheme } from "commskit/theme";
import {
  allowedModes,
  fetchDemoToken,
  fetchDemoUsers,
  loadServerUrl,
  normalizeUrl,
  saveServerUrl,
  type DemoUser,
  type Feature,
  type Mode,
  type Session,
} from "../session";

const MODE_LABELS: Record<Mode, string> = { chat: "Chat", calls: "Calls", both: "Both" };

export function LoginScreen({ onLogin }: { onLogin: (s: Session) => void }) {
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("");
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [mode, setMode] = useState<Mode>("both");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (raw: string) => {
    const baseUrl = normalizeUrl(raw);
    if (!baseUrl) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetchDemoUsers(baseUrl);
      setFeatures(r.features);
      setUsers(r.users);
      const modes = allowedModes(r.features);
      setMode((m) => (modes.includes(m) ? m : modes[modes.length - 1] ?? "chat"));
      await saveServerUrl(baseUrl);
    } catch (e) {
      setFeatures(null);
      setUsers([]);
      setError(`Can't reach ${baseUrl}/dev/users (${e instanceof Error ? e.message : String(e)}). Is the demo server running with --host 0.0.0.0, and is the phone on the same Wi-Fi?`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    loadServerUrl().then((u) => {
      setUrl(u);
      void load(u);
    });
  }, [load]);

  const signIn = async (user: DemoUser) => {
    const baseUrl = normalizeUrl(url);
    setBusy(true);
    setError(null);
    try {
      const token = await fetchDemoToken(baseUrl, user.id);
      onLogin({ baseUrl, userId: user.id, userName: user.name, token, mode, features: features ?? [], users });
    } catch (e) {
      setError(`Sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const modes = features ? allowedModes(features) : [];
  const s = styles;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[s.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={[s.title, { color: c.text }]} accessibilityRole="header">
          Commskit Demo
        </Text>
        <Text style={[s.muted, { color: c.textMuted }]}>Sign in to the commskit demo server as one of its demo users.</Text>

        <Text style={[s.label, { color: c.textMuted }]}>Server URL</Text>
        <View style={s.row}>
          <TextInput
            testID="login-server-url"
            accessibilityLabel="Server URL"
            value={url}
            onChangeText={setUrl}
            onSubmitEditing={() => load(url)}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.10:8000"
            placeholderTextColor={c.textMuted}
            style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
          />
          <Pressable testID="login-connect" accessibilityRole="button" accessibilityLabel="Load users" onPress={() => load(url)} style={[s.button, { backgroundColor: c.accent }]}>
            <Text style={s.buttonText}>Load</Text>
          </Pressable>
        </View>
        <Text style={[s.hint, { color: c.textMuted }]}>Your PC's LAN IP, port 8000. Saved on this device.</Text>

        {busy ? <ActivityIndicator style={{ marginTop: 16 }} color={c.accent} /> : null}
        {error ? (
          <Text testID="login-error" style={[s.error, { color: c.danger }]}>
            {error}
          </Text>
        ) : null}

        {features ? (
          <>
            <Text style={[s.label, { color: c.textMuted }]}>Mode (server runs: {features.join(" + ") || "nothing"})</Text>
            <View style={s.segmented} accessibilityRole="radiogroup">
              {(["chat", "calls", "both"] as Mode[]).map((m) => {
                const enabled = modes.includes(m);
                const on = mode === m;
                return (
                  <Pressable
                    key={m}
                    testID={`login-mode-${m}`}
                    accessibilityRole="radio"
                    accessibilityLabel={`Mode ${MODE_LABELS[m]}`}
                    accessibilityState={{ checked: on, disabled: !enabled }}
                    disabled={!enabled}
                    onPress={() => setMode(m)}
                    style={[s.segment, { borderColor: c.border }, on && { backgroundColor: c.accent, borderColor: c.accent }, !enabled && { opacity: 0.35 }]}
                  >
                    <Text style={{ color: on ? "#fff" : c.text, fontWeight: "600" }}>{MODE_LABELS[m]}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[s.label, { color: c.textMuted }]}>Sign in as</Text>
            {users.map((u) => (
              <Pressable
                key={u.id}
                testID={`login-user-${u.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Sign in as ${u.name}`}
                disabled={busy}
                onPress={() => signIn(u)}
                style={[s.user, { borderColor: c.border, backgroundColor: c.surface }]}
              >
                <Avatar name={u.name} id={u.id} size={40} />
                <Text style={[s.userName, { color: c.text }]}>
                  {u.name} <Text style={{ color: c.textMuted }}>({u.id})</Text>
                </Text>
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, maxWidth: 520, width: "100%", alignSelf: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 6 },
  muted: { fontSize: 15, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8, textTransform: "uppercase" },
  hint: { fontSize: 12, marginTop: 6 },
  row: { flexDirection: "row", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, fontSize: 16 },
  button: { borderRadius: 12, paddingHorizontal: 18, justifyContent: "center", minHeight: 48 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  error: { marginTop: 16, fontSize: 14 },
  segmented: { flexDirection: "row", gap: 8 },
  segment: { flex: 1, borderWidth: 1, borderRadius: 12, minHeight: 44, alignItems: "center", justifyContent: "center" },
  user: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10, minHeight: 56 },
  userName: { fontSize: 17, fontWeight: "600" },
});
